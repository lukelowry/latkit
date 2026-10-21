/**
 * Patches as latkit's bytes, written here without WebAssembly: a page, a worker, or a server builds
 * them alike. The layout is `crates/latkit/src/data/bytes.rs`'s: a frame of `LATK`, its length, the
 * dataset it changes, and its operations, little endian throughout.
 */

import type { Id, Ids } from './inputs.js';

/** Row ids as a patch takes them: listed, `{ count }` for rows `0..count`, or a typed array. */
export type RowIds = Ids | readonly (Id | null)[] | Uint32Array | Float64Array;

/** A point `[x, y]`, or a list of geometries one level shallower: a path, its parts, or polygons. */
export type Geometry = readonly number[] | readonly Geometry[];

/**
 * One field's values, a value per row; `null` is missing. Typed arrays copy at once: numbers, or
 * in a `Uint8Array` booleans, nonzero true. Booleans, texts, and geometries also as arrays.
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

/** A field naming rows of another table by id: `null` leaves a row unwired. */
export interface Reference {
  reference: string;
  ids: RowIds;
}

/** Values of a field naming rows of `table` by id. */
export function reference(table: string, ids: RowIds): Reference {
  return { reference: table, ids };
}

/** A table's fields by name. */
export type Fields = Readonly<Record<string, Values | Reference>>;

/** A byte stream, structurally compatible with the browser and Node ReadableStream. */
export interface ReadableBytes {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

const MAGIC = [0x4c, 0x41, 0x54, 0x4b]; // LATK
/** The magic and the frame's length. */
const HEADER = 16;
const VERSION = 1;
const OP = { axis: 0, replace: 1, set: 2, remove: 3, append: 4, forget: 5, frames: 6 } as const;
/** Levels of detail kept above frames. */
const LEVELS = 21;
const FIELD_VALUES = 0;
const FIELD_REFERENCE = 1;
const STORE = { f64: 0, f32: 1, i32: 2, u32: 3, u64: 4, bool: 5, text: 6, geometry: 7 } as const;
/** The largest whole number a JavaScript number holds exactly. */
const SAFE = Number.MAX_SAFE_INTEGER;
const utf8 = new TextEncoder();

/**
 * Changes to a dataset, applied in order and all at once by `Data.apply`: plain data, written as
 * latkit's bytes as it is built.
 *
 * ```ts
 * const patch = Patch.to('grid')
 *   .replace('Bus', [101, 102], { x: Float64Array.of(0, 10), name: ['North', 'South'] })
 *   .append(0.5, 'Bus', { vm: Float32Array.of(1.01, 0.99) });
 * ```
 */
export class Patch {
  /** The dataset the patch changes, when it names one; `Data.apply` refuses it for another. */
  readonly data: string | undefined;
  #writer: Writer;
  #count = 0;
  /** Where the operations start: after the header, the name, and their count. */
  #ops: number;
  /** Appends of float frames to the same fields of every row of one table, waiting to be written as
   * one: a field records its frames in one write, however many calls made them. */
  #run: Appends | undefined;

  /** An empty patch, for whichever dataset it is applied to. */
  constructor(data?: string);
  /** @internal */
  constructor(data: string, owned: Uint8Array);
  constructor(data?: string, owned?: Uint8Array) {
    this.data = data || undefined;
    this.#writer = new Writer(owned);
    if (owned) {
      this.#ops = 0;
      return;
    }
    this.#writer.bytes(MAGIC);
    this.#writer.u16(VERSION);
    this.#writer.u16(0);
    this.#writer.zeros(8);
    this.#writer.str(this.data ?? '');
    this.#writer.u32(0);
    this.#ops = this.#writer.length;
  }

  /** An empty patch to dataset `data`. */
  static to(data: string): Patch {
    return new Patch(data);
  }

  /** The patch `bytes` hold: one frame, as `toBytes` or a stream writes it. */
  static fromBytes(bytes: Uint8Array): Patch {
    return Patch.#fromOwnedFrame(bytes.slice());
  }

  static #fromOwnedFrame(bytes: Uint8Array): Patch {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = frameLength(bytes, Infinity);
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
      throw malformed('text is not UTF-8');
    }
    const patch = new Patch(name, bytes);
    patch.#count = view.getUint32(start - 4, true);
    patch.#ops = start;
    return patch;
  }

  /**
   * The patches arriving back to back in `stream`, each as soon as its last byte does: a response
   * body, a file, or a socket's messages. Each frame says its length up front, so a patch longer
   * than `limit` bytes (256 MiB unless given) throws before allocating its body. The parser holds at most one frame, in addition to
   * the input chunk and patches the caller retains. Breaking iteration cancels the reader.
   *
   * ```ts
   * for await (const patch of Patch.stream((await fetch('/feed')).body!)) data.apply(patch);
   * ```
   */
  static async *stream(
    stream: ReadableBytes | AsyncIterable<Uint8Array>,
    { limit = 1 << 28 }: { limit?: number } = {},
  ): AsyncGenerator<Patch> {
    if (!Number.isSafeInteger(limit) || limit < HEADER)
      throw new RangeError(`limit must be a safe integer of at least ${HEADER} bytes`);
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
          const patch = Patch.#fromOwnedFrame(buffer);
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
   * The patch its JSON makes: a list of changes, each named by its method with its parameters by
   * name, such as `{"set": {"table": "Bus", "ids": [1], "fields": {"kv": [345]}}}`. Slices of
   * binary files, `{file, dtype, offset, count}`, are fetched at once relative to `base`, the
   * document's own URL. Reading JSON takes latkit's WebAssembly, which this loads as
   * `loadLatkit()` does.
   */
  static async load(json: string, base = ''): Promise<Patch> {
    const { loadLatkit } = await import('./load.js');
    await loadLatkit();
    const { readPatch } = await import('./runtime.js');
    return Patch.fromBytes(await readPatch(json, base));
  }

  /** Names the axis sampled fields are recorded over, such as `('time', 's')`. */
  axis(name: string, unit: string): this {
    return this.#op(OP.axis, (w) => {
      w.str(name);
      w.str(unit);
    });
  }

  /** Replaces table `table` with these rows and fields, or adds it. */
  replace(table: string, ids: RowIds, fields: Fields = {}): this {
    return this.#op(OP.replace, (w) => writeTable(w, table, ids, fields));
  }

  /**
   * Writes `fields` for rows `ids` of `table`: rows with known ids change, others are added, and
   * fields left out keep their values. Adds the table when there is none of its name.
   */
  set(table: string, ids: RowIds, fields: Fields = {}): this {
    return this.#op(OP.set, (w) => writeTable(w, table, ids, fields));
  }

  /** Removes the rows of `table` with `ids`. */
  remove(table: string, ids: RowIds): this {
    return this.#op(OP.remove, (w) => {
      w.str(table);
      writeIds(w, ids, table);
    });
  }

  /**
   * Records a frame at each axis coordinate of `at`: for each field, a value per row at every
   * coordinate, frame-major; of every row of `table`, or of rows `ids`, the rest holding their last
   * values. A field's first frame makes it sampled. Appends of float arrays to the same fields of
   * every row, one after another, write as one change, so a frame a call costs no more than one call.
   */
  append(
    at: number | readonly number[],
    table: string,
    fields: Readonly<Record<string, Values>>,
    ids?: RowIds,
  ): this {
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

  /** Forgets every sampled field's frames before axis coordinate `before`. */
  forget(before: number): this {
    return this.#op(OP.forget, (w) => w.f64(before));
  }

  /**
   * Holds a run of sampled field `field`'s entries of level `level`, numbered from `first`: what a
   * time tile holds, as `latkit tile` writes them. At level 0 the entries are frames, each a
   * coordinate in `at` and a value per row of `table` in `values`. At level `k` they are buckets of
   * `8^k` frames, each its first and last frame's coordinates in `at`, and in `values` each row's
   * least value over each bucket, then each row's greatest. NaN is missing. No entry may be held
   * already; frames past the field's widen it.
   */
  frames(
    table: string,
    field: string,
    { level = 0, first }: { level?: number; first: number },
    at: Float64Array | readonly number[],
    values: Float32Array | readonly number[],
  ): this {
    const path = `${table}.${field}`;
    if (!Number.isInteger(level) || level < 0 || level > LEVELS)
      throw invalid(path, `levels run from 0 to ${LEVELS}`);
    const per = level === 0 ? 1 : 2;
    const coordinates = Float64Array.from(at);
    const numbers = values instanceof Float32Array ? values : Float32Array.from(values);
    const entries = coordinates.length / per;
    const rows = entries === 0 ? 0 : numbers.length / (entries * per);
    if (!Number.isInteger(entries) || !Number.isInteger(rows))
      throw invalid(
        path,
        `${coordinates.length} coordinates and ${numbers.length} values make no run`,
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

  /** Appends `next`'s changes, to this patch's dataset. */
  extend(next: Patch): this {
    this.#flush();
    next.#flush();
    this.#writer.bytes(next.#writer.view().subarray(next.#ops));
    this.#count += next.#count;
    return this;
  }

  /** The patch as bytes: one frame, naming its dataset when it has one. */
  toBytes(): Uint8Array {
    return this.frame().slice();
  }

  /** @internal The frame, without copying it: read at once, before the patch changes. */
  frame(): Uint8Array {
    this.#flush();
    const view = this.#writer.view();
    const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
    data.setBigUint64(8, BigInt(view.length), true);
    data.setUint32(this.#ops - 4, this.#count, true);
    return view;
  }

  /** Writes the appends waiting as one, before anything after them. */
  #flush(): void {
    const run = this.#run;
    if (!run) return;
    this.#run = undefined;
    const entries = run.fields.map(({ name, parts }): [string, Values] => [name, joined(parts)]);
    this.#op(OP.append, (w) => writeAppend(w, run.table, undefined, run.at, entries));
  }

  /** Writes an operation, or nothing when `body` throws. */
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

/** Frames of the same fields of every row of a table: coordinates, and each field's values. */
interface Appends {
  table: string;
  at: number[];
  fields: { name: string; parts: Floats[] }[];
}

/** `parts` one after another, in the first's storage. */
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

/** An append: its table, its rows or every row, its frames' coordinates, and its fields' values. */
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

/** A table: its name, its ids, and its fields, each values or a reference. */
function writeTable(w: Writer, table: string, ids: RowIds, fields: Fields): void {
  const entries = Object.entries(fields);
  // Room for the typed columns at once, rather than doubling past them.
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

/** The length a frame's header says, once `bytes` hold it; an error for what is no frame. */
function frameLength(bytes: Uint8Array, limit: number): number | undefined {
  for (let i = 0; i < Math.min(bytes.length, 4); i++)
    if (bytes[i] !== MAGIC[i]) throw malformed('not latkit bytes');
  if (bytes.length < HEADER) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== VERSION) throw malformed('unsupported LATK version');
  if (view.getUint16(6, true) !== 0) throw malformed('unsupported LATK flags');
  const encoded = view.getBigUint64(8, true);
  if (encoded > BigInt(Number.MAX_SAFE_INTEGER))
    throw malformed('frame length is not a safe integer');
  const length = Number(encoded);
  if (length > limit)
    throw Object.assign(new Error(`a patch longer than ${limit} bytes`), { code: 'limit' });
  if (length < HEADER) throw malformed('a frame shorter than its header');
  return length;
}

function malformed(reason: string): Error {
  return Object.assign(new Error(`bytes: ${reason}`), { code: 'invalid', path: 'bytes' });
}

function invalid(path: string, reason: string): Error {
  return Object.assign(new Error(`${path}: ${reason}`), { code: 'invalid', path });
}

/** Rows' ids: `u8 0` and a count, or `u8 1` and their values. */
function writeIds(w: Writer, ids: RowIds, path: string): void {
  if (!ArrayBuffer.isView(ids) && !Array.isArray(ids) && 'count' in ids) {
    if (!Number.isInteger(ids.count) || ids.count < 0 || ids.count > 0xffffffff)
      throw invalid(path, 'a count of ids is a whole number from 0');
    w.u8(0);
    w.u32(ids.count);
    return;
  }
  w.u8(1);
  writeIdValues(w, ids, path);
}

/**
 * Ids as values: numbers as `u32` when every one fits, which latkit reads as the `u64` it keeps,
 * else as `u64`; texts when any is one; `null` missing.
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
    if (id === null || id === undefined) missing = true;
    else if (typeof id === 'string') texts = true;
    else if (!Number.isInteger(id) || id < 0 || id > SAFE)
      throw invalid(path, `id ${id}: a numeric id is a whole number from 0 to 2^53 - 1`);
    else if (id > 0xffffffff) wide = true;
  }
  if (texts) {
    writeTexts(
      w,
      Array.from(list, (id) => (id === null || id === undefined ? null : String(id))),
    );
  } else {
    // Each id as one little-endian word, or two, low then high.
    const words = new Uint32Array(wide ? n * 2 : n);
    for (let i = 0; i < n; i++) {
      const id = (list[i] as number | null) ?? 0;
      if (!wide) words[i] = id;
      else [words[i * 2], words[i * 2 + 1]] = [id >>> 0, Math.floor(id / 0x100000000)];
    }
    w.u8(wide ? STORE.u64 : STORE.u32);
    w.u32(n);
    w.bytes(new Uint8Array(words.buffer));
  }
  writeValidity(w, n, missing ? (i) => list[i] !== null && list[i] !== undefined : null);
}

/** Whether an array value is present: `null`, `undefined`, and an empty geometry are missing. */
const present = (v: unknown): boolean =>
  v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);

/** Values as one storage, a validity mask after them when any is missing. */
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
        throw invalid(path, `${values.constructor.name} is not a column's typed array`);
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
      throw invalid(path, `a field holds numbers, booleans, texts, or geometries, not ${kind}`);
  }
  writeValidity(w, n, missing ? (i) => present(list[i]) : null);
}

/** Texts: their byte offsets, then their UTF-8; a missing text is empty. */
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

/** Geometries: their depth, each level's offsets into the next, then their `[x, y]` points. */
function writeGeometry(w: Writer, rows: readonly (Geometry | null)[], path: string): void {
  const depthOf = (g: Geometry): number =>
    typeof g[0] === 'number' ? 0 : Array.isArray(g[0]) ? 1 + depthOf(g[0] as Geometry) : 1;
  const first = rows.find((g) => present(g));
  const depth = first ? depthOf(first) : 0;
  if (depth > 3) throw invalid(path, 'geometries nest at most polygons of rings of [x, y] points');
  const levels: number[][] = Array.from({ length: depth }, () => [0]);
  const coords: number[] = [];
  const push = (g: Geometry, level: number): void => {
    if (level === depth) {
      if (typeof g[0] !== 'number' || typeof g[1] !== 'number')
        throw invalid(path, `geometries nest alike: ${depth} levels deep`);
      coords.push(g[0], g[1]);
      return;
    }
    if (typeof g[0] === 'number')
      throw invalid(path, `geometries nest alike: ${depth} levels deep`);
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

/** `n` bits, `bit(i)` each, in `u64` words, low bit first. */
function writeBits(w: Writer, n: number, bit: (i: number) => boolean): void {
  const words = new Uint8Array(Math.ceil(n / 64) * 8);
  for (let i = 0; i < n; i++) if (bit(i)) words[i >> 3]! |= 1 << (i & 7);
  w.bytes(words);
}

/** `u8 0`, or `u8 1` and the bits of which of `n` values are present. */
function writeValidity(w: Writer, n: number, valid: ((i: number) => boolean) | null): void {
  w.u8(valid ? 1 : 0);
  if (valid) writeBits(w, n, valid);
}

/** Bytes written little endian into a buffer that doubles as it fills. */
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

  /** Room for `n` more bytes past the end. */
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
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`${v} is no u32`);
    this.room(4);
    this.#data.setUint32(this.length, v, true);
    this.length += 4;
  }

  u16(v: number): void {
    this.room(2);
    this.#data.setUint16(this.length, v, true);
    this.length += 2;
  }

  u64(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${v} is no safe unsigned integer`);
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

/** The chunks of a stream, read with a reader where async iteration is missing. */
async function* chunks(
  stream: ReadableBytes | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (!('getReader' in stream)) {
    yield* stream;
    return;
  }
  const reader = stream.getReader();
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return;
      }
      if (!value) throw malformed('a stream chunk is missing');
      yield value;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
