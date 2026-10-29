/**
 * Patches, written directly as latkit's bytes without WebAssembly so a page, worker, or server can
 * build them. The format matches `crates/latkit/src/data/bytes.rs`: a frame with a
 * 12-byte header (the magic `LATK` and the frame's length), the name of the dataset it changes, an
 * operation count, and the operations, all little endian.
 */

import type { Id, Ids } from './inputs.js';
import {
  bytesOf,
  chunks,
  thrown,
  waited,
  wasm,
  type ByteSource,
  type ReadableBytes,
  type Wait,
} from './internal.js';

/**
 * Row ids: a list of numbers or strings, `{ count }` for ids `0` to `count - 1`, or a `Uint32Array`
 * or `Float64Array` of numbers. In a reference, `null` or NaN names no row.
 */
export type RowIds = Ids | readonly (Id | null)[] | Uint32Array | Float64Array;

/**
 * A point `[x, y]`, or a nested list of points: a path (a list of points), parts (a list of paths,
 * such as a polygon's rings), or polygons (a list of parts).
 */
export type Geometry = readonly number[] | readonly Geometry[];

/**
 * One field's values, one per row, with `null` for a missing value. Numbers come as a typed array
 * or an array. A `Uint8Array` holds booleans, where nonzero is true. Booleans, strings, and
 * geometries also come as arrays. Values are copied when passed, so the arrays can be reused right
 * away.
 */
export type Values =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Uint8Array
  | readonly (number | null)[]
  | readonly (boolean | null)[]
  | readonly (string | null)[]
  | readonly (Geometry | null)[];

/** A reference field: for each row, a row of another table. */
export interface Reference {
  /** The table referenced. */
  reference: string;
  /** For each row, the id of the row it references, or `null` or NaN to reference none. */
  ids: RowIds;
}

/** Builds a {@link Reference} field: for each row, the id of the row it references in `table`. */
export function reference(table: string, ids: RowIds): Reference {
  return { reference: table, ids };
}

/** A table's fields by name: values, or a {@link Reference}. */
export type Fields = Readonly<Record<string, Values | Reference>>;

/** A run of entries of a sampled field at one level of detail, for {@link Patch.frames}. */
export interface Run {
  /** The level of detail, from 0 to 21. Defaults to 0. */
  level?: number;
  /** The index of the first entry, a safe nonnegative integer. */
  first: number;
  /**
   * Each frame's coordinate. At a bucket level, the coordinates of each bucket's first and last
   * frames.
   */
  at: Float64Array | readonly number[];
  /**
   * One value per row for each entry, entry by entry. At a bucket level, the per-row minimums of
   * every bucket, then the per-row maximums of every bucket. NaN marks a missing value.
   */
  values: Float32Array | readonly number[];
}

const MAGIC = [0x4c, 0x41, 0x54, 0x4b]; // LATK
/** Header bytes: the magic and the frame's length. */
const HEADER = 12;
/** The longest frame read by default, in bytes: 256 MiB. */
const LIMIT = 1 << 28;
const OP = { axis: 0, replace: 1, set: 2, remove: 3, append: 4, forget: 5, frames: 6 } as const;
/** The highest level of detail; level 0 is frames. */
const LEVELS = 21;
const FIELD_VALUES = 0;
const FIELD_REFERENCE = 1;
const STORE = { f64: 0, f32: 1, i32: 2, u32: 3, u64: 4, bool: 5, text: 6, geometry: 7 } as const;
/** The largest integer a JavaScript number represents exactly, 2^53 - 1. */
const SAFE = Number.MAX_SAFE_INTEGER;
const utf8 = new TextEncoder();

/** @internal Returns `patch`'s frame without copying it. Read it before the patch changes again. */
export let framed: (patch: Patch) => Uint8Array;

/** @internal Wraps one whole frame `bytes` as a patch without copying them. */
export let owned: (bytes: Uint8Array) => Patch;

/**
 * A list of changes to a dataset. `Data.apply` applies them in order, all or none. The patch is
 * written as latkit's bytes as it is built, without WebAssembly. Each method adds a change and
 * returns the patch.
 *
 * ```ts
 * const patch = new Patch('grid')
 *   .replace('Bus', [101, 102], { x: Float64Array.of(0, 10), name: ['North', 'South'] })
 *   .append('Bus', 0.5, { vm: Float32Array.of(1.01, 0.99) });
 * ```
 */
export class Patch {
  static {
    framed = (patch) => patch.#frame();
    owned = (bytes) => Patch.#owning(bytes);
  }

  #data: string | undefined;
  #writer: Writer;
  #count = 0;
  /** Byte offset of the first operation: after the header, dataset name, and operation count. */
  #ops: number;
  /**
   * Unwritten consecutive appends of float frames to the same fields of every row of one table.
   * They are written as one append, so each field records all their frames in one write.
   */
  #run: Appends | undefined;

  /** Creates an empty patch for the dataset named `data`, or for any dataset when omitted. */
  constructor(data?: string) {
    this.#data = data || undefined;
    this.#writer = new Writer();
    this.#writer.bytes(MAGIC);
    this.#writer.zeros(8);
    this.#writer.str(this.#data ?? '');
    this.#writer.u32(0);
    this.#ops = this.#writer.length;
  }

  /**
   * The name of the dataset this patch is for, if any. `Data.apply` rejects it for a dataset with
   * another name.
   */
  get data(): string | undefined {
    return this.#data;
  }

  /**
   * Reads a patch from `source`: latkit's bytes (one frame, as `toBytes()` writes it), or JSON that
   * any language can write without latkit. The JSON is a list of changes. Each change is keyed by
   * its method name and holds the method's parameters by name, such as
   * `{"set": {"table": "Bus", "ids": [1], "fields": {"kv": [345]}}}`. A field may be a slice of a
   * binary file, `{file, dtype, offset, count}`, which is fetched right away. Bytes are read
   * without WebAssembly. JSON needs it, so call `await load()` first, or this rejects with an
   * `unloaded` error.
   */
  static async read(
    source: ByteSource | object,
    options: {
      /** The URL that the JSON's file slices are relative to. Defaults to the JSON's URL. */
      base?: string;
      /**
       * The longest frame in bytes. Defaults to 256 MiB. A longer frame fails with a `limit` error.
       */
      limit?: number;
    } & Wait = {},
  ): Promise<Patch> {
    const { bytes, base } = await bytesOf(source, options);
    if (MAGIC.every((byte, i) => bytes[i] === byte))
      return Patch.#owning(bytes.slice(), options.limit);
    const read = wasm().readPatch(bytes, options.base ?? base);
    return Patch.#owning(await waited<Uint8Array>(read, options, 'reading a patch'), options.limit);
  }

  /**
   * Wraps frame `bytes` as a patch without copying them. Throws unless they are exactly one valid
   * frame of at most `limit` bytes.
   */
  static #owning(bytes: Uint8Array, limit = LIMIT): Patch {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = frameLength(bytes, limit);
    if (length === undefined || length !== bytes.length) throw malformed('not one whole frame');
    const nameLength = bytes.length >= HEADER + 4 ? view.getUint32(HEADER, true) : -1;
    const start = HEADER + 4 + nameLength + 4;
    if (nameLength < 0 || start > bytes.length) throw malformed('truncated');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(HEADER + 4, start - 4),
      );
    } catch {
      throw malformed('the dataset name is not UTF-8');
    }
    const patch = new Patch();
    patch.#data = name || undefined;
    patch.#writer = new Writer(bytes);
    patch.#count = view.getUint32(start - 4, true);
    patch.#ops = start;
    return patch;
  }

  /**
   * Yields each patch in `stream` as soon as its last byte arrives. The stream carries frames back
   * to back, such as a response body, a file, or a socket's messages. At most one frame is
   * buffered, besides the current chunk and any patches the caller keeps. Breaking out of the loop
   * cancels the stream. Throws an `invalid` error if the stream ends inside a frame.
   *
   * ```ts
   * for await (const patch of Patch.stream((await fetch('/feed')).body!)) data.apply(patch);
   * ```
   */
  static async *stream(
    stream: ReadableBytes | AsyncIterable<Uint8Array>,
    options: {
      /**
       * The longest frame in bytes, at least 12. Defaults to 256 MiB. Each frame states its length
       * up front, so a longer frame fails with a `limit` error before its body is allocated.
       */
      limit?: number;
    } = {},
  ): AsyncGenerator<Patch> {
    const { limit = LIMIT } = options;
    if (!Number.isSafeInteger(limit) || limit < HEADER)
      throw invalid('limit', `a whole number of at least ${HEADER} bytes, not ${limit}`);
    let buffer = new Uint8Array(HEADER);
    let used = 0;
    let length: number | undefined;
    for await (const chunk of chunks(stream)) {
      for (let offset = 0; offset < chunk.length;) {
        const n = Math.min(buffer.length - used, chunk.length - offset);
        buffer.set(chunk.subarray(offset, offset + n), used);
        used += n;
        offset += n;
        if (length === undefined) {
          length = frameLength(buffer.subarray(0, used), limit);
          if (length === undefined) continue;
          const frame = new Uint8Array(length);
          frame.set(buffer);
          buffer = frame;
        }
        if (used === length) {
          const patch = Patch.#owning(buffer, limit);
          buffer = new Uint8Array(HEADER);
          used = 0;
          length = undefined;
          yield patch;
        }
      }
    }
    if (used !== 0) throw malformed('the stream ended inside a patch');
  }

  /**
   * Sets the name and unit of the axis that sampled fields are recorded over, such as
   * `axis('time', 's')`.
   */
  axis(name: string, unit: string): this {
    return this.#op(OP.axis, (w) => {
      w.str(name);
      w.str(unit);
    });
  }

  /**
   * Replaces table `table` with rows `ids` and `fields`, adding the table if it does not exist.
   * Without ids, the rows are `0` to `n - 1`, where `n` is the length of each field's values.
   */
  replace(table: string, fields: Fields): this;
  replace(table: string, ids: RowIds, fields?: Fields): this;
  replace(table: string, ids: RowIds | Fields, fields?: Fields): this {
    return this.#op(OP.replace, (w) => writeTable(w, table, ...rows(ids, fields)));
  }

  /**
   * Writes `fields` for rows `ids` of `table`. Rows with existing ids change, new ids add rows, and
   * omitted fields keep their values. Adds the table if it does not exist. Without ids, the rows
   * are `0` to `n - 1`, where `n` is the length of each field's values.
   */
  set(table: string, fields: Fields): this;
  set(table: string, ids: RowIds, fields?: Fields): this;
  set(table: string, ids: RowIds | Fields, fields?: Fields): this {
    return this.#op(OP.set, (w) => writeTable(w, table, ...rows(ids, fields)));
  }

  /** Removes the rows of `table` with `ids`. */
  remove(table: string, ids: RowIds): this {
    return this.#op(OP.remove, (w) => {
      w.str(table);
      writeIds(w, ids, table);
    });
  }

  /**
   * Records a frame of `table` at each axis coordinate in `at`. Each field gives one value per row
   * for each frame, frame by frame. A field becomes a sampled field at its first frame. Consecutive
   * appends of typed float arrays to the same fields of every row are written as one change, so
   * appending one frame per call costs no more than one call with every frame.
   */
  append(
    table: string,
    at: number | readonly number[],
    fields: Readonly<Record<string, Values>>,
    options: {
      /** The rows the frames cover. Defaults to every row. Other rows keep their last values. */
      ids?: RowIds;
    } = {},
  ): this {
    const { ids } = options;
    const frames = typeof at === 'number' ? [at] : at;
    const entries = Object.entries(fields);
    const floats =
      ids === undefined &&
      entries.every(([, v]) => v instanceof Float64Array || v instanceof Float32Array);
    const run = this.#run;
    if (
      floats &&
      run?.table === table &&
      run.fields.length === entries.length &&
      entries.every(
        ([name, v], i) =>
          run.fields[i]!.name === name && run.fields[i]!.parts[0]!.constructor === v.constructor,
      )
    ) {
      for (const t of frames) run.at.push(t);
      entries.forEach(([, v], i) => run.fields[i]!.parts.push((v as Floats).slice()));
      return this;
    }
    this.#flush();
    if (floats) {
      this.#run = {
        table,
        at: [...frames],
        fields: entries.map(([name, v]) => ({ name, parts: [(v as Floats).slice()] })),
      };
      return this;
    }
    return this.#op(OP.append, (w) => writeAppend(w, table, ids, frames, entries));
  }

  /** Drops every sampled field's frames before axis coordinate `before`. */
  forget(before: number): this {
    return this.#op(OP.forget, (w) => w.f64(before));
  }

  /**
   * Stores a run of entries of sampled field `field` in `table`, at one level of detail. This is
   * what a time tile from `latkit tile` holds. At level 0 each entry is a frame. At level `k` each
   * entry is a bucket of `8^k` frames. A run that covers a level's last entry replaces the entries
   * it covers, such as the last bucket while it fills. Entries past the field's last frame extend it.
   */
  frames(table: string, field: string, run: Run): this {
    const { level = 0, first, at, values } = run;
    const path = `${table}.${field}`;
    if (!Number.isInteger(level) || level < 0 || level > LEVELS)
      throw invalid(path, `the level must be a whole number from 0 to ${LEVELS}`);
    const per = level === 0 ? 1 : 2;
    const coordinates = Float64Array.from(at);
    const numbers = values instanceof Float32Array ? values : Float32Array.from(values);
    const entries = coordinates.length / per;
    const rows = entries === 0 ? 0 : numbers.length / (entries * per);
    if (!Number.isInteger(entries) || !Number.isInteger(rows))
      throw invalid(
        path,
        `${coordinates.length} coordinates and ${numbers.length} values do not divide evenly`,
      );
    if (
      !Number.isSafeInteger(first) ||
      first < 0 ||
      !Number.isSafeInteger((first + entries) * 8 ** level)
    )
      throw invalid(path, 'frame indexes must be nonnegative safe integers');
    return this.#op(OP.frames, (w) => {
      w.str(table);
      w.str(field);
      w.u32(rows);
      w.u8(level);
      w.u64(first);
      w.u32(entries);
      w.bytes(new Uint8Array(coordinates.buffer));
      w.bytes(new Uint8Array(numbers.buffer, numbers.byteOffset, numbers.byteLength));
    });
  }

  /** Appends `next`'s changes to this patch, which keeps its own dataset name. */
  extend(next: Patch): this {
    this.#flush();
    next.#flush();
    this.#writer.bytes(next.#writer.view().subarray(next.#ops));
    this.#count += next.#count;
    return this;
  }

  /** The length of `toBytes()` in bytes, without copying them. */
  get byteLength(): number {
    this.#flush();
    return this.#writer.length;
  }

  /** Returns a copy of the patch as latkit's bytes: one frame, naming the dataset if it has one. */
  toBytes(): Uint8Array {
    return this.#frame().slice();
  }

  /** Completes the header and returns the frame uncopied. Read it before the patch changes. */
  #frame(): Uint8Array {
    this.#flush();
    const view = this.#writer.view();
    const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
    data.setBigUint64(MAGIC.length, BigInt(view.length), true);
    data.setUint32(this.#ops - 4, this.#count, true);
    return view;
  }

  /** Writes the pending merged appends as one operation, before any later operation. */
  #flush(): void {
    const run = this.#run;
    if (!run) return;
    this.#run = undefined;
    const entries = run.fields.map(({ name, parts }): [string, Values] => [name, joined(parts)]);
    this.#op(OP.append, (w) => writeAppend(w, run.table, undefined, run.at, entries));
  }

  /** Writes an operation tagged `tag`. If `body` throws, removes what it wrote and rethrows. */
  #op(tag: number, body: (w: Writer) => void): this {
    this.#flush();
    const mark = this.#writer.length;
    try {
      this.#writer.u8(tag);
      body(this.#writer);
    } catch (error) {
      this.#writer.length = mark;
      throw error;
    }
    this.#count++;
    return this;
  }
}

type Floats = Float64Array | Float32Array;

/** Pending merged appends to one table: the frames' coordinates and each field's value chunks. */
interface Appends {
  table: string;
  at: number[];
  fields: { name: string; parts: Floats[] }[];
}

/** Concatenates `parts` into one array of the first part's type. */
function joined(parts: readonly Floats[]): Floats {
  if (parts.length === 1) return parts[0]!;
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out =
    parts[0] instanceof Float32Array ? new Float32Array(length) : new Float64Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Writes an append's body: the table, its rows or a flag for every row, the frames' coordinates,
 * and each field's values.
 */
function writeAppend(
  w: Writer,
  table: string,
  ids: RowIds | undefined,
  frames: readonly number[],
  entries: readonly (readonly [string, Values])[],
): void {
  w.str(table);
  if (ids === undefined) w.u8(0);
  else {
    w.u8(1);
    writeIds(w, ids, table);
  }
  w.u32(frames.length);
  for (const t of frames) w.f64(t);
  w.u32(entries.length);
  for (const [name, values] of entries) {
    w.str(name);
    writeValues(w, values, `${table}.${name}`);
  }
}

/** Writes a table's body: its name, its ids, and its fields, each values or a reference. */
function writeTable(w: Writer, table: string, ids: RowIds, fields: Fields): void {
  const entries = Object.entries(fields);
  // Reserve room for every typed-array column up front, instead of doubling the buffer repeatedly.
  const typed = (v: unknown) => (ArrayBuffer.isView(v) ? v.byteLength : 0);
  w.room(entries.reduce((n, [, f]) => n + typed(isReference(f) ? f.ids : f), typed(ids)));
  w.str(table);
  writeIds(w, ids, table);
  w.u32(entries.length);
  for (const [name, field] of entries) {
    w.str(name);
    const path = `${table}.${name}`;
    if (isReference(field)) {
      w.u8(FIELD_REFERENCE);
      w.str(field.reference);
      writeIdValues(w, field.ids, path);
    } else {
      w.u8(FIELD_VALUES);
      writeValues(w, field, path);
    }
  }
}

function isReference(field: Values | Reference): field is Reference {
  return !ArrayBuffer.isView(field) && !Array.isArray(field) && 'reference' in field;
}

/**
 * Returns the ids and fields of `replace` or `set`, given as `(ids, fields)` or as `(fields)`. With
 * `(fields)` the rows are `0` to `n - 1`, where `n` is the length of the first field's values.
 */
function rows(ids: RowIds | Fields, fields: Fields | undefined): [RowIds, Fields] {
  if (fields !== undefined || isIds(ids)) return [ids as RowIds, fields ?? {}];
  const first = Object.values(ids)[0];
  return [{ count: first ? length(isReference(first) ? first.ids : first) : 0 }, ids];
}

/** Whether `x` is row ids rather than fields: a list, or `{ count }`, since no field is a number. */
function isIds(x: RowIds | Fields): x is RowIds {
  return (
    Array.isArray(x) ||
    ArrayBuffer.isView(x) ||
    typeof (x as { count?: unknown }).count === 'number'
  );
}

/** How many values or ids `x` holds. */
function length(x: Values | RowIds): number {
  return 'length' in x ? x.length : x.count;
}

/**
 * Returns the frame length from the header, or `undefined` until `bytes` hold a whole header.
 * Throws for bytes that are not a frame, or a frame longer than `limit`.
 */
function frameLength(bytes: Uint8Array, limit: number): number | undefined {
  for (let i = 0; i < Math.min(bytes.length, 4); i++)
    if (bytes[i] !== MAGIC[i]) throw malformed('not latkit bytes');
  if (bytes.length < HEADER) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const encoded = view.getBigUint64(MAGIC.length, true);
  if (encoded > BigInt(Number.MAX_SAFE_INTEGER))
    throw malformed('frame length is not a safe integer');
  const length = Number(encoded);
  if (length > limit)
    throw thrown({ code: 'limit', message: `the patch is longer than ${limit} bytes` });
  if (length < HEADER) throw malformed('the frame is shorter than its header');
  return length;
}

function malformed(reason: string): Error {
  return invalid('bytes', reason);
}

function invalid(path: string, reason: string): Error {
  return thrown({ code: 'invalid', message: `${path}: ${reason}`, path });
}

/** Writes row ids: `u8 0` and a count, or `u8 1` and the ids as values. */
function writeIds(w: Writer, ids: RowIds, path: string): void {
  if (!ArrayBuffer.isView(ids) && !Array.isArray(ids) && 'count' in ids) {
    if (!Number.isInteger(ids.count) || ids.count < 0 || ids.count > 0xffffffff)
      throw invalid(path, 'a count of ids must be a whole number from 0 to 2^32 - 1');
    w.u8(0);
    w.u32(ids.count);
    return;
  }
  w.u8(1);
  writeIdValues(w, ids, path);
}

/** Whether `id` names a row. `null`, `undefined`, and NaN name none. */
const names = (id: Id | null | undefined): id is Id =>
  id !== null && id !== undefined && !Number.isNaN(id);

/**
 * Writes ids as values: as text if any id is a string, else as `u32` when every id fits (latkit
 * widens them to the `u64` it stores), else as `u64`. `null` marks a missing id.
 */
function writeIdValues(w: Writer, ids: RowIds, path: string): void {
  if (ids instanceof Uint32Array) {
    w.u8(STORE.u32);
    w.u32(ids.length);
    w.bytes(new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength));
    w.u8(0);
    return;
  }
  if (!ArrayBuffer.isView(ids) && !Array.isArray(ids) && 'count' in ids) {
    const counted = new Uint32Array(ids.count);
    for (let i = 0; i < counted.length; i++) counted[i] = i;
    return writeIdValues(w, counted, path);
  }
  const list = ids as ArrayLike<Id | null>;
  const n = list.length;
  let [texts, missing, wide] = [false, false, false];
  for (let i = 0; i < n; i++) {
    const id = list[i];
    if (!names(id)) missing = true;
    else if (typeof id === 'string') texts = true;
    else if (!Number.isInteger(id) || id < 0 || id > SAFE)
      throw invalid(path, `id ${id} is not a whole number from 0 to 2^53 - 1`);
    else if (id > 0xffffffff) wide = true;
  }
  if (texts) {
    writeTexts(
      w,
      Array.from(list, (id) => (names(id) ? String(id) : null)),
    );
  } else {
    // One little-endian u32 per id, or two when wide: the low word, then the high.
    const words = new Uint32Array(wide ? n * 2 : n);
    for (let i = 0; i < n; i++) {
      const id = names(list[i]) ? (list[i] as number) : 0;
      if (!wide) words[i] = id;
      else [words[i * 2], words[i * 2 + 1]] = [id >>> 0, Math.floor(id / 0x100000000)];
    }
    w.u8(wide ? STORE.u64 : STORE.u32);
    w.u32(n);
    w.bytes(new Uint8Array(words.buffer));
  }
  writeValidity(w, n, missing ? (i) => names(list[i]) : null);
}

/** Whether a value is present. `null`, `undefined`, and an empty geometry count as missing. */
const present = (v: unknown): boolean =>
  v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);

/** Writes values in one storage type, followed by a validity mask when any value is missing. */
function writeValues(w: Writer, values: Values, path: string): void {
  if (ArrayBuffer.isView(values)) {
    if (values instanceof Uint8Array) {
      w.u8(STORE.bool);
      w.u32(values.length);
      writeBits(w, values.length, (i) => values[i] !== 0);
    } else {
      const store =
        values instanceof Float64Array
          ? STORE.f64
          : values instanceof Float32Array
            ? STORE.f32
            : values instanceof Int32Array
              ? STORE.i32
              : values instanceof Uint32Array
                ? STORE.u32
                : undefined;
      if (store === undefined)
        throw invalid(path, `${values.constructor.name} is not a supported typed array`);
      w.u8(store);
      w.u32(values.length);
      w.bytes(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    }
    w.u8(0);
    return;
  }
  const list = values as readonly unknown[];
  const n = list.length;
  let first: unknown;
  let missing = false;
  for (let i = 0; i < n; i++) {
    const v = list[i];
    if (!present(v)) missing = true;
    else if (first === undefined) first = v;
  }
  // Values that are all missing write as numbers. They fit a field of any kind until it holds a value.
  const kind = first === undefined ? 'number' : Array.isArray(first) ? 'geometry' : typeof first;
  for (let i = 0; i < n; i++) {
    const v = list[i];
    if (!present(v)) continue;
    const k = Array.isArray(v) ? 'geometry' : typeof v;
    if (k !== kind)
      throw invalid(path, `a field holds one kind of value: ${kind}, not ${k} at ${i}`);
  }
  switch (kind) {
    case 'number': {
      const numbers = new Float64Array(n);
      for (let i = 0; i < n; i++) numbers[i] = present(list[i]) ? (list[i] as number) : NaN;
      w.u8(STORE.f64);
      w.u32(n);
      w.bytes(new Uint8Array(numbers.buffer));
      break;
    }
    case 'boolean':
      w.u8(STORE.bool);
      w.u32(n);
      writeBits(w, n, (i) => list[i] === true);
      break;
    case 'string':
      writeTexts(w, list as readonly (string | null)[]);
      break;
    case 'geometry':
      writeGeometry(w, list as readonly (Geometry | null)[], path);
      break;
    default:
      throw invalid(path, `a field holds numbers, booleans, strings, or geometries, not ${kind}`);
  }
  writeValidity(w, n, missing ? (i) => present(list[i]) : null);
}

/** Writes texts as `n + 1` byte offsets, then their UTF-8 bytes. A missing text is empty. */
function writeTexts(w: Writer, texts: readonly (string | null)[]): void {
  const n = texts.length;
  let chars = 0;
  for (let i = 0; i < n; i++) chars += texts[i]?.length ?? 0;
  // UTF-8 takes at most three bytes for each UTF-16 unit.
  const bytes = new Uint8Array(chars * 3);
  const offsets = new Uint32Array(n + 1);
  let at = 0;
  for (let i = 0; i < n; i++) {
    offsets[i] = at;
    const text = texts[i];
    if (text) at += utf8.encodeInto(text, bytes.subarray(at)).written;
  }
  offsets[n] = at;
  w.u8(STORE.text);
  w.u32(n);
  w.bytes(new Uint8Array(offsets.buffer));
  w.u32(at);
  w.bytes(bytes.subarray(0, at));
}

/**
 * Writes geometries: their nesting depth, each level's offsets into the next level, then the
 * `[x, y]` points as `f64`.
 */
function writeGeometry(w: Writer, rows: readonly (Geometry | null)[], path: string): void {
  const depthOf = (g: Geometry): number =>
    typeof g[0] === 'number' ? 0 : Array.isArray(g[0]) ? 1 + depthOf(g[0] as Geometry) : 1;
  const first = rows.find((g) => present(g));
  const depth = first ? depthOf(first) : 0;
  if (depth > 3)
    throw invalid(path, 'geometry nests deeper than polygons of rings of [x, y] points');
  const levels: number[][] = Array.from({ length: depth }, () => [0]);
  const coords: number[] = [];
  const push = (g: Geometry, level: number): void => {
    if (level === depth) {
      if (typeof g[0] !== 'number' || typeof g[1] !== 'number')
        throw invalid(path, `every geometry must nest ${depth} levels deep, like the first`);
      coords.push(g[0], g[1]);
      return;
    }
    if (typeof g[0] === 'number')
      throw invalid(path, `every geometry must nest ${depth} levels deep, like the first`);
    for (const item of g as readonly Geometry[]) push(item, level + 1);
    const next = level + 1 < depth ? levels[level + 1]!.length - 1 : coords.length / 2;
    levels[level]!.push(next);
  };
  for (const g of rows) {
    if (present(g)) push(g!, 0);
    else if (depth === 0) coords.push(NaN, NaN);
    else levels[0]!.push(levels[0]!.at(-1)!);
  }
  w.u8(STORE.geometry);
  w.u32(rows.length);
  w.u8(depth);
  for (const offsets of levels) {
    w.u32(offsets.length);
    w.bytes(new Uint8Array(Uint32Array.from(offsets).buffer));
  }
  w.u32(coords.length / 2);
  w.bytes(new Uint8Array(Float64Array.from(coords).buffer));
}

/** Writes `n` bits, bit `i` being `bit(i)`, packed into `u64` words, lowest bit first. */
function writeBits(w: Writer, n: number, bit: (i: number) => boolean): void {
  const words = new Uint8Array(Math.ceil(n / 64) * 8);
  for (let i = 0; i < n; i++) if (bit(i)) words[i >> 3]! |= 1 << (i & 7);
  w.bytes(words);
}

/** Writes `u8 0` when every value is present, else `u8 1` and a bit per value, set if present. */
function writeValidity(w: Writer, n: number, valid: ((i: number) => boolean) | null): void {
  w.u8(valid ? 1 : 0);
  if (valid) writeBits(w, n, valid);
}

/** A little-endian byte writer over a buffer that doubles in size as it fills. */
class Writer {
  #buffer: Uint8Array;
  #data: DataView;
  length: number;

  constructor(owned?: Uint8Array) {
    this.#buffer = owned ?? new Uint8Array(1 << 12);
    this.#data = new DataView(
      this.#buffer.buffer,
      this.#buffer.byteOffset,
      this.#buffer.byteLength,
    );
    this.length = owned?.length ?? 0;
  }

  /** Ensures capacity for `n` more bytes past the end. */
  room(n: number): void {
    if (this.length + n <= this.#buffer.length) return;
    const grown = new Uint8Array(Math.max(2 * this.#buffer.length, this.length + n));
    grown.set(this.#buffer.subarray(0, this.length));
    this.#buffer = grown;
    this.#data = new DataView(grown.buffer);
  }

  view(): Uint8Array {
    return this.#buffer.subarray(0, this.length);
  }

  zeros(n: number): void {
    this.room(n);
    this.#buffer.fill(0, this.length, this.length + n);
    this.length += n;
  }

  bytes(bytes: ArrayLike<number>): void {
    this.room(bytes.length);
    this.#buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  u8(v: number): void {
    this.room(1);
    this.#data.setUint8(this.length, v);
    this.length += 1;
  }

  u32(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff)
      throw thrown({ code: 'limit', message: `${v} does not fit in a 32-bit count` });
    this.room(4);
    this.#data.setUint32(this.length, v, true);
    this.length += 4;
  }

  u64(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0)
      throw thrown({ code: 'invalid', message: `${v} is not a safe nonnegative integer` });
    this.room(8);
    this.#data.setBigUint64(this.length, BigInt(v), true);
    this.length += 8;
  }

  f64(v: number): void {
    this.room(8);
    this.#data.setFloat64(this.length, v, true);
    this.length += 8;
  }

  str(s: string): void {
    const bytes = utf8.encode(s);
    this.u32(bytes.length);
    this.bytes(bytes);
  }
}
