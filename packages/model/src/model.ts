/**
 * The model: a network and its element classes, as a format reads them from a case. A format
 * subclasses it; a host asks the instance every question about the case, and records it with an
 * attached engine. `Model.Topology` and `Model.Item` are field-for-field the shapes
 * `@latkit/network` loads and picks, so a model never adapts for a renderer.
 */

import type { Document } from './document.js';
import type { Domain } from './domain.js';
import type { Engine } from './engine.js';
import { checkRef, fieldOf } from './field.js';
import { createGrid } from './grid.js';
import { decodeCore, encodeCore } from './pack/core.js';
import { decodeShard, encodeShard } from './pack/shard.js';
import { begin, type Recording } from './recording.js';
import { Series } from './series.js';

const NONE = 0xffffffff;

/**
 * A network and its element classes, as a format reads them from a case. Subclass it for a
 * format: describe the case to the constructor, give each class's `values` when asked and the
 * case's `bytes`, and, for a format that edits, its `document`. A host asks the instance where an
 * element sits, what a field holds, and for a class as a table, and records it with the engine
 * attached to it.
 *
 * @remarks
 * Immutable but for its engine. `owners` names the class whose element `i` is vertex `i` and the
 * class whose element `i` is edge `i`; either may be absent. Class values load once, shared by
 * concurrent callers, each of whom may abort without cancelling the others.
 */
export abstract class Model {
  /** The format that read the case, such as `gridkit`. */
  readonly format: string;
  readonly id: string;
  readonly name: string;
  readonly meta: Readonly<Record<string, number | string | boolean | null>>;
  readonly topology: Model.Topology;
  readonly owners: { readonly vertex?: string; readonly edge?: string };
  readonly classes: readonly Model.Class[];
  /**
   * What records it: attach one at any time, and `record` runs it. A recording keeps the engine it
   * began with.
   */
  engine: Engine | null = null;
  readonly #byId = new Map<string, Model.Class>();
  readonly #owners: Record<'vertex' | 'edge', string | null> = { vertex: null, edge: null };
  /** Each class that records a signal, as the series its recordings hold. */
  readonly #recorded: readonly (Series.Shape & { readonly classId: string })[];
  /** Each class's fields as `fields` lists them. */
  readonly #listed = new Map<string, readonly Pick<Model.Field, 'ref' | 'label' | 'unit'>[]>();
  readonly #loaded = new Map<string, Model.Data>();
  readonly #pending = new Map<string, Pending>();
  /** Each resolved number column's sealed one-frame series, by class and column. */
  readonly #constants = new Map<string, Series>();

  /**
   * Check the description once: unique ids, declared columns and signals, anchors within the
   * topology, owners with one element per item, and a consistent topology.
   *
   * @throws Error naming the first thing that is inconsistent.
   */
  constructor(description: Model.Description) {
    nonEmptyString(description.format, 'model format');
    nonEmptyString(description.id, 'model id');
    if (typeof description.name !== 'string') throw new Error('model name must be a string');
    const meta = description.meta ?? {};
    for (const [key, value] of Object.entries(meta)) {
      if (value !== null && !['number', 'string', 'boolean'].includes(typeof value)) {
        throw new Error(`meta '${key}' must be a number, string, boolean, or null`);
      }
    }
    validateTopology(description.topology);
    if (!Array.isArray(description.classes as unknown)) throw new Error('classes must be an array');
    const owners = description.owners ?? {};
    for (const kind of ['vertex', 'edge'] as const) {
      const owner = owners[kind];
      if (owner === undefined) continue;
      if (!description.classes.some((spec) => spec.id === owner)) {
        throw new Error(`${kind} owner '${String(owner)}' is not a class`);
      }
      this.#owners[kind] = owner;
    }
    for (const spec of description.classes) {
      if (this.#byId.has(spec.id)) throw new Error(`duplicate class id '${spec.id}'`);
      const owner =
        this.#owners.vertex === spec.id ? 'vertex' : this.#owners.edge === spec.id ? 'edge' : null;
      validateSpec(spec, description.topology, owner);
      this.#byId.set(spec.id, spec);
      this.#listed.set(spec.id, listing(spec));
    }
    this.format = description.format;
    this.id = description.id;
    this.name = description.name;
    this.meta = meta;
    this.topology = description.topology;
    this.owners = owners;
    this.classes = description.classes;
    this.#recorded = description.classes.flatMap((spec) => {
      const signals = spec.signals.filter((signal) => signal.recorded).map((signal) => signal.id);
      return signals.length ? [{ classId: spec.id, signals, elementCount: spec.count }] : [];
    });
  }

  /**
   * One class's labels and column values, in the order its spec declares the columns. Asked once
   * per class; `signal` aborts once no caller wants it.
   */
  protected abstract values(classId: string, signal: AbortSignal): Promise<Model.Values>;

  /** The case as bytes, the caller's own. */
  abstract bytes(signal?: AbortSignal): Promise<Uint8Array>;

  /** The case open for editing; absent for a format that does not edit. */
  document?(signal?: AbortSignal): Promise<Document>;

  /** The class `id` names, or undefined for a class the model lacks. */
  class(id: string): Model.Class | undefined {
    return this.#byId.get(id);
  }

  /**
   * One class's labels and its columns with their values, checked against its spec.
   *
   * @throws Error for a class the model lacks, or values that do not match the spec.
   */
  load(classId: string, signal?: AbortSignal): Promise<Model.Data> {
    if (signal?.aborted) return Promise.reject(abortError());
    const data = this.#loaded.get(classId);
    if (data) return Promise.resolve(data);
    const spec = this.#byId.get(classId);
    if (!spec) return Promise.reject(new Error(`unknown class '${classId}'`));
    let entry = this.#pending.get(classId);
    if (!entry || entry.controller.signal.aborted) entry = this.#begin(spec);
    return this.#subscribe(classId, entry, signal);
  }

  /** The element a picked item is, through the owners; null when nothing owns that item. */
  elementAt(item: Model.Item): Model.Element | null {
    const classId = this.#owners[item.kind] ?? undefined;
    const spec = classId === undefined ? undefined : this.#byId.get(classId);
    if (!spec || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= spec.count)
      return null;
    return { classId: spec.id, index: item.index };
  }

  /**
   * Where an element sits on the topology: by identity for an owner class, else through its
   * class's anchor; null when it has no place.
   */
  itemOf(element: Model.Element): Model.Item | null {
    const spec = this.#byId.get(element.classId);
    if (
      !spec ||
      !Number.isSafeInteger(element.index) ||
      element.index < 0 ||
      element.index >= spec.count
    )
      return null;
    if (this.#owners.vertex === spec.id) return { kind: 'vertex', index: element.index };
    if (this.#owners.edge === spec.id) return { kind: 'edge', index: element.index };
    if (!spec.anchor) return null;
    const index = spec.anchor.index[element.index]!;
    return index === NONE ? null : { kind: spec.anchor.kind, index };
  }

  /**
   * Every field of class `classId` that `field` can resolve, in declared order: its number
   * columns, then the signals a recording holds. Empty for a class the model lacks.
   */
  fields(classId: string): readonly Pick<Model.Field, 'ref' | 'label' | 'unit'>[] {
    return this.#listed.get(classId) ?? [];
  }

  /**
   * A number column, or a signal of `recording`, resolved to the `{ series, signal }` a renderer
   * binds; null when the model or the recording has no values for it. One reference resolves to
   * one series, so the renderers binding it share its frames.
   *
   * @throws TypeError when `ref` is not a field reference.
   */
  async field(
    ref: Model.FieldRef,
    recording: Recording | null = null,
    signal?: AbortSignal,
  ): Promise<Model.Field | null> {
    checkRef(ref);
    signal?.throwIfAborted();
    const spec = this.#byId.get(ref.classId);
    if (!spec) return null;
    if (ref.kind === 'column') {
      const declared = spec.columns.find((column) => column.id === ref.id);
      if (declared?.kind !== 'number') return null;
      const series = await this.#constant(spec, declared.id, signal);
      return fieldOf(ref, declared.label, declared.unit ?? '', series, 0, spec.count, always);
    }
    const declared = spec.signals.find((candidate) => candidate.id === ref.id);
    if (!declared || !recording) return null;
    const series = recording.series(spec.id);
    const index = series ? series.signals.indexOf(declared.id) : -1;
    if (!series || index < 0) return null;
    return fieldOf(ref, declared.label, declared.unit, series, index, spec.count, (time) =>
      recording.frameAt(time),
    );
  }

  /**
   * One class as a table: its labels and columns, and at `at` every signal `at.recording` records
   * for it, sampled at `at.time`.
   *
   * @throws Error for a class the model lacks; RangeError when `at.time` is not finite.
   */
  async grid(
    classId: string,
    at: { readonly recording: Recording; readonly time: number } | null = null,
    signal?: AbortSignal,
  ): Promise<Model.Grid> {
    const spec = this.#byId.get(classId);
    if (!spec) throw new Error(`unknown class '${classId}'`);
    if (at && !Number.isFinite(at.time)) throw new RangeError('grid time must be finite');
    const data = await this.load(classId, signal);
    const sampled = at
      ? await Promise.all(
          spec.signals.map(async (declared): Promise<Model.Data['columns'][number] | null> => {
            const field = await this.field(
              { classId, kind: 'signal', id: declared.id },
              at.recording,
              signal,
            );
            if (!field) return null;
            const values = await field.at(at.time, signal);
            return {
              kind: 'number',
              id: declared.id,
              label: declared.label,
              unit: declared.unit,
              values: values instanceof Float64Array ? values : Float64Array.from(values),
            };
          }),
        )
      : [];
    signal?.throwIfAborted();
    return createGrid(
      data.labels,
      data.columns,
      sampled.filter((column) => column !== null),
    );
  }

  /**
   * Record the model with its engine: `input` is the engine's to check, at once, and the
   * recording returned waits its turn, then fills as the engine computes, holding every class
   * that records a signal.
   *
   * @throws Error when no engine is attached; what the engine throws for an input it refuses.
   */
  record(
    input: unknown,
    options: { readonly id?: string; readonly label?: string } = {},
  ): Recording {
    const engine = this.engine;
    if (!engine) throw new Error(`model '${this.id}' has no engine attached`);
    return begin(options, this.#recorded, (recorder) => engine.record(this, input, recorder));
  }

  /** The model as a source: its description packed, and each class's values packed when asked. */
  source(): Model.Source {
    return {
      core: (signal) =>
        Promise.resolve().then(() => {
          signal?.throwIfAborted();
          return encodeCore(this);
        }),
      class: async (id, signal) => encodeShard(await this.load(id, signal)),
      bytes: async (signal) => (await this.bytes(signal)).slice(),
    };
  }

  /**
   * The model a source holds, its classes unpacked as they load.
   *
   * @throws Error when the core is not a valid pack or describes an inconsistent model.
   */
  static async from(
    source: Model.Source,
    options: {
      readonly signal?: AbortSignal;
      readonly progress?: (loaded: number, total: number) => void;
    } = {},
  ): Promise<Model> {
    return new Unpacked(decodeCore(await source.core(options.signal, options.progress)), source);
  }

  #begin(spec: Model.Class): Pending {
    const controller = new AbortController();
    const settle = (): void => {
      if (this.#pending.get(spec.id) === entry) this.#pending.delete(spec.id);
    };
    const entry: Pending = {
      controller,
      subscribers: 0,
      promise: this.values(spec.id, controller.signal).then(
        (values) => {
          controller.signal.throwIfAborted();
          const data = join(spec, values);
          this.#loaded.set(spec.id, data);
          settle();
          return data;
        },
        (error: unknown) => {
          settle();
          throw error;
        },
      ),
    };
    this.#pending.set(spec.id, entry);
    return entry;
  }

  /** One shared load per class; each caller may abort without cancelling the others. */
  #subscribe(classId: string, entry: Pending, signal?: AbortSignal): Promise<Model.Data> {
    entry.subscribers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = (): void => {
        signal?.removeEventListener('abort', abort);
        entry.subscribers--;
        if (entry.subscribers === 0 && this.#pending.get(classId) === entry)
          entry.controller.abort();
      };
      const abort = (): void => {
        if (settled) return;
        settled = true;
        release();
        reject(abortError());
      };
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(
        (data) => {
          if (settled) return;
          settled = true;
          release();
          resolve(data);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          release();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** Number column `id` of `spec` as a sealed series of one frame, made once. */
  async #constant(spec: Model.Class, id: string, signal?: AbortSignal): Promise<Series> {
    const key = `${spec.id}\0${id}`;
    const known = this.#constants.get(key);
    if (known) return known;
    const data = await this.load(spec.id, signal);
    let series = this.#constants.get(key);
    if (!series) {
      const column = data.columns.find((candidate) => candidate.id === id)!;
      const made = Series.create({
        signals: [id],
        elementCount: spec.count,
        time: Float64Array.of(0),
        values: column.values as Float64Array,
      });
      made.seal();
      series = made;
      this.#constants.set(key, series);
    }
    return series;
  }
}

/** What a model speaks: its description, topology, classes, values, fields, grids, and source. */
export declare namespace Model {
  /** What a model is before any class loads: what a format gives the constructor. */
  interface Description {
    readonly format: string;
    readonly id: string;
    readonly name: string;
    readonly meta?: Readonly<Record<string, number | string | boolean | null>>;
    readonly topology: Topology;
    readonly owners?: { readonly vertex?: string; readonly edge?: string };
    readonly classes: readonly Class[];
  }
  /** CPU-side graph shape. Field-for-field the topology `@latkit/network` loads. */
  interface Topology {
    /** Number of logical graph vertices. */
    readonly vertexCount: number;
    /** Optional `x, y` or `lon, lat` coordinates, two f32 values per vertex. */
    readonly vertexCoords?: Float32Array;
    /** How coordinates are interpreted; omitted means inferred from their bounds. */
    readonly coordinateSpace?: 'cartesian' | 'geographic';
    /** Edge endpoint vertex indices stored as `[from0, to0, from1, to1, ...]`. */
    readonly edges: Uint32Array;
    /** Per-edge offsets into `polylinePoints`, `edgeCount + 1` long, beginning at zero. */
    readonly polylineStart: Uint32Array;
    /** Optional intermediate `x, y` points for every edge polyline. */
    readonly polylinePoints?: Float32Array;
  }
  /** One topology primitive. Field-for-field the item `@latkit/network` picks. */
  interface Item {
    readonly kind: 'vertex' | 'edge';
    readonly index: number;
  }
  /** One element of one class. */
  interface Element {
    readonly classId: string;
    readonly index: number;
  }
  /** One element class: what is always known about it before its values load. */
  interface Class {
    readonly id: string;
    readonly label: string;
    readonly count: number;
    /**
     * Where each element sits on the topology: `index[i]` is the vertex or edge of element `i`, or
     * `0xffffffff` when element `i` has no place. An owner class is anchored by identity and must
     * not declare one; a class with no place on the canvas omits it.
     */
    readonly anchor?: { readonly kind: 'vertex' | 'edge'; readonly index: Uint32Array };
    /** Its columns; its values hold theirs in this order. */
    readonly columns: readonly Column[];
    readonly signals: readonly Signal[];
  }
  /**
   * An attribute every element of a class has. A missing value is `NaN` in a number column and
   * `null` in a text column; a flag is always `0` or `1`. `group` is an optional inspector
   * section; columns without one form the first section.
   */
  type Column =
    | {
        readonly kind: 'number';
        readonly id: string;
        readonly label: string;
        readonly unit?: string;
        readonly group?: string;
      }
    | {
        readonly kind: 'text';
        readonly id: string;
        readonly label: string;
        readonly group?: string;
      }
    | {
        readonly kind: 'flag';
        readonly id: string;
        readonly label: string;
        readonly group?: string;
      };
  /** A quantity an engine can record for every element of a class. */
  interface Signal {
    readonly id: string;
    readonly label: string;
    readonly unit: string;
    /** Whether a recording of the model holds it. */
    readonly recorded: boolean;
  }
  /** One class's labels and column values in declared order: what a format's `values` gives. */
  interface Values {
    readonly labels: readonly string[];
    readonly values: readonly (Float64Array | readonly (string | null)[] | Uint8Array)[];
  }
  /** One class's labels and its columns with their values: what `load` resolves. */
  interface Data {
    readonly labels: readonly string[];
    readonly columns: readonly (
      | (Extract<Column, { kind: 'number' }> & { readonly values: Float64Array })
      | (Extract<Column, { kind: 'text' }> & { readonly values: readonly (string | null)[] })
      | (Extract<Column, { kind: 'flag' }> & { readonly values: Uint8Array })
    )[];
  }
  /** Which quantity of a class: a number column or a signal. Plain data a host persists. */
  interface FieldRef {
    readonly classId: string;
    readonly kind: 'column' | 'signal';
    readonly id: string;
  }
  /**
   * A field resolved against a model and, for a signal, a recording: the `{ series, signal }`
   * every renderer binds, and what it is.
   */
  interface Field {
    readonly ref: FieldRef;
    readonly label: string;
    readonly unit: string;
    /** A signal's series in the recording; a column's is sealed with one frame. */
    readonly series: Series;
    /** The field's index in `series.signals`. */
    readonly signal: number;
    /** `normalizeDomain` over every committed value; it grows while the recording is live. */
    readonly domain: Domain;
    /**
     * Every element's value at `time`: the latest frame at or before it, the first before the
     * recording starts, NaN where an element has no value. The array is borrowed; never mutate
     * it.
     *
     * @throws RangeError when `time` is not finite.
     */
    at(time: number, signal?: AbortSignal): Promise<Float32Array | Float64Array>;
    /**
     * The field over other items: item `i` holds element `elements[i]` of the class, NaN for
     * `0xffffffff` or an element its series does not hold. It keeps this field's clock and
     * recorded range, so a view colors a value the way every other view of the field does: a
     * diagram's nets over the elements that drive them, a monitor's chosen few, one element's
     * value in an inspector. Nothing is read until something reads it.
     *
     * @throws RangeError for an element outside the class.
     */
    gather(elements: ArrayLike<number>): Field;
  }
  /** A class as a table: search, sort, and windows that format only the rows they return. */
  interface Grid {
    /**
     * What each cell of a row shows, in order: the class's columns, then the signals its
     * recording holds at the grid's time.
     */
    readonly columns: readonly {
      readonly kind: 'column' | 'signal';
      readonly id: string;
      readonly label: string;
      readonly unit?: string;
    }[];
    /** Rows `offset` through `offset + limit` under `query` and `sort`, and the filtered total. */
    window(
      query: string,
      sort: GridSort | null,
      offset: number,
      limit: number,
      signal?: AbortSignal,
    ): Promise<{
      readonly rows: readonly {
        readonly index: number;
        readonly label: string;
        readonly cells: readonly string[];
      }[];
      readonly total: number;
    }>;
    /** The display position of element `index` under `query` and `sort`; null when filtered out. */
    locate(
      index: number,
      query: string,
      sort: GridSort | null,
      signal?: AbortSignal,
    ): Promise<number | null>;
    /** Drop every cache; pending and later queries reject with `AbortError`. */
    dispose(): void;
  }
  /** Which column orders a grid, by its index in `Grid.columns` or null for the label, and how. */
  interface GridSort {
    readonly column: number | null;
    readonly dir: 'asc' | 'desc';
  }
  /**
   * A model held elsewhere: its description packed, and each class's values packed when asked.
   * Every buffer it returns is the caller's; a transport may detach it. A source that holds
   * resources releases them in `close`.
   */
  interface Source {
    core(
      signal?: AbortSignal,
      progress?: (loaded: number, total: number) => void,
    ): Promise<Uint8Array>;
    class(id: string, signal?: AbortSignal): Promise<Uint8Array>;
    bytes(signal?: AbortSignal): Promise<Uint8Array>;
    close?(): void;
  }
}

/** A model a source holds: its classes unpacked from the shards the source gives. */
class Unpacked extends Model {
  readonly #source: Model.Source;

  constructor(description: Model.Description, source: Model.Source) {
    super(description);
    this.#source = source;
  }

  protected async values(classId: string, signal: AbortSignal): Promise<Model.Values> {
    return decodeShard(await this.#source.class(classId, signal), this.class(classId)!);
  }

  bytes(signal?: AbortSignal): Promise<Uint8Array> {
    return this.#source.bytes(signal);
  }
}

interface Pending {
  readonly controller: AbortController;
  readonly promise: Promise<Model.Data>;
  subscribers: number;
}

/** Each class's fields as `fields` lists them: number columns, then recorded signals. */
function listing(spec: Model.Class): readonly Pick<Model.Field, 'ref' | 'label' | 'unit'>[] {
  const entry = (kind: Model.FieldRef['kind'], id: string, label: string, unit: string) =>
    Object.freeze({ ref: Object.freeze({ classId: spec.id, kind, id }), label, unit });
  return Object.freeze([
    ...spec.columns.flatMap((column) =>
      column.kind === 'number' ? [entry('column', column.id, column.label, column.unit ?? '')] : [],
    ),
    ...spec.signals.flatMap((declared) =>
      declared.recorded ? [entry('signal', declared.id, declared.label, declared.unit)] : [],
    ),
  ]);
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isTypedArray(value: unknown, name: string): boolean {
  return Object.prototype.toString.call(value) === `[object ${name}]`;
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} must be non-empty`);
  return value;
}

function nonNegativeInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer`);
  }
  return value;
}

/** A column's frame is its only one, whatever the time. */
function always(time: number): number {
  if (!Number.isFinite(time)) throw new RangeError('time must be finite');
  return 0;
}

/** Reject non-finite geometry before it reaches bounds, sphere, and fit calculations. */
function validateFinite(values: Float32Array, name: string): void {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error(`invalid ${name}`);
  }
}

/**
 * Validate the CPU-side graph shape a `Model.Topology` promises: counts, typed-array kinds, finite
 * coordinates, endpoints within the vertex range, and a monotonic polyline offset table. The one
 * validator every consumer shares, so a topology a model accepts is one a renderer loads.
 *
 * @throws Error naming the first field that is invalid.
 */
export function validateTopology(topology: Model.Topology): void {
  const vertexCount = topology.vertexCount;
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 0) {
    throw new Error('invalid vertex count');
  }
  const coords = topology.vertexCoords;
  if (coords !== undefined) {
    if (!isTypedArray(coords, 'Float32Array')) {
      throw new Error('vertex coordinates must be Float32Array');
    }
    if (coords.length !== 0 && coords.length !== vertexCount * 2) {
      throw new Error('invalid vertex coordinate length');
    }
    validateFinite(coords, 'vertex coordinates');
  }
  const space = topology.coordinateSpace;
  if (space !== undefined && space !== 'cartesian' && space !== 'geographic') {
    throw new Error('invalid coordinate space');
  }
  const edges = topology.edges;
  if (!isTypedArray(edges, 'Uint32Array')) throw new Error('edges must be Uint32Array');
  if (edges.length % 2 !== 0) throw new Error('invalid edge length');
  for (const endpoint of edges) {
    if (endpoint >= vertexCount) throw new Error('edge endpoint out of range');
  }
  const edgeCount = edges.length / 2;
  const points = topology.polylinePoints;
  if (points !== undefined && !isTypedArray(points, 'Float32Array')) {
    throw new Error('polyline points must be Float32Array');
  }
  const pointLength = points?.length ?? 0;
  if (pointLength % 2 !== 0) throw new Error('invalid polyline point length');
  if (points) validateFinite(points, 'polyline points');
  const start = topology.polylineStart;
  if (!isTypedArray(start, 'Uint32Array')) throw new Error('polylineStart must be Uint32Array');
  if (start.length !== edgeCount + 1) throw new Error('invalid polylineStart length');
  if (start[0] !== 0) throw new Error('polylineStart must begin at zero');
  if (start[edgeCount] !== pointLength / 2) throw new Error('polylineStart terminal mismatch');
  for (let edge = 0; edge < edgeCount; edge++) {
    if (start[edge + 1]! < start[edge]!) throw new Error('polylineStart must be monotonic');
  }
}

function validateSpec(
  spec: Model.Class,
  topology: Model.Topology,
  owner: 'vertex' | 'edge' | null,
): void {
  const id = nonEmptyString(spec.id, 'class id');
  if (typeof spec.label !== 'string') throw new Error(`class '${id}' label must be a string`);
  const count = nonNegativeInteger(spec.count, `class '${id}' count`);
  if (!Array.isArray(spec.columns as unknown)) {
    throw new Error(`class '${id}' columns must be an array`);
  }
  const columns = new Set<string>();
  for (const column of spec.columns) {
    const columnId = nonEmptyString(column.id, `class '${id}' column id`);
    if (columns.has(columnId)) throw new Error(`class '${id}' repeats column '${columnId}'`);
    columns.add(columnId);
    const unit = (column as { readonly unit?: unknown }).unit;
    if (
      (column.kind !== 'number' && column.kind !== 'text' && column.kind !== 'flag') ||
      typeof column.label !== 'string' ||
      (column.group !== undefined && typeof column.group !== 'string') ||
      (unit !== undefined && (column.kind !== 'number' || typeof unit !== 'string'))
    ) {
      throw new Error(`class '${id}' column '${columnId}' is malformed`);
    }
  }
  if (!Array.isArray(spec.signals as unknown)) {
    throw new Error(`class '${id}' signals must be an array`);
  }
  const signals = new Set<string>();
  for (const signal of spec.signals) {
    const signalId = nonEmptyString(signal.id, `class '${id}' signal id`);
    if (signals.has(signalId)) throw new Error(`class '${id}' repeats signal '${signalId}'`);
    signals.add(signalId);
    if (
      typeof signal.label !== 'string' ||
      typeof signal.unit !== 'string' ||
      typeof signal.recorded !== 'boolean'
    ) {
      throw new Error(`class '${id}' signal '${signalId}' is malformed`);
    }
  }
  if (owner) {
    if (spec.anchor !== undefined)
      throw new Error(`owner class '${id}' must not declare an anchor`);
    const expected = owner === 'vertex' ? topology.vertexCount : topology.edges.length / 2;
    if (count !== expected)
      throw new Error(`owner class '${id}' must have one element per ${owner}`);
    return;
  }
  const anchor = spec.anchor;
  if (anchor === undefined) return;
  if (anchor.kind !== 'vertex' && anchor.kind !== 'edge') {
    throw new Error(`class '${id}' has an invalid anchor kind`);
  }
  if (!isTypedArray(anchor.index, 'Uint32Array') || anchor.index.length !== count) {
    throw new Error(`class '${id}' anchor must be a Uint32Array of length count`);
  }
  const limit = anchor.kind === 'vertex' ? topology.vertexCount : topology.edges.length / 2;
  for (let element = 0; element < count; element++) {
    const index = anchor.index[element]!;
    if (index !== NONE && index >= limit) {
      throw new Error(`class '${id}' anchors element ${element} beyond the topology`);
    }
  }
}

/** One class's values joined to the columns its spec declares, once they check out. */
function join(spec: Model.Class, data: Model.Values): Model.Data {
  if (!data || typeof data !== 'object') throw new Error(`class '${spec.id}' data is malformed`);
  if (!Array.isArray(data.labels) || data.labels.length !== spec.count) {
    throw new Error(`class '${spec.id}' data must carry one label per element`);
  }
  if (!Array.isArray(data.values as unknown) || data.values.length !== spec.columns.length) {
    throw new Error(`class '${spec.id}' data must carry the values of every declared column`);
  }
  const columns = spec.columns.map((declared, at): Model.Data['columns'][number] => {
    const values = data.values[at];
    const ok =
      declared.kind === 'number'
        ? isTypedArray(values, 'Float64Array')
        : declared.kind === 'text'
          ? Array.isArray(values)
          : isTypedArray(values, 'Uint8Array');
    if (!ok || values!.length !== spec.count) {
      throw new Error(`class '${spec.id}' column '${declared.id}' has the wrong kind or length`);
    }
    if (declared.kind === 'flag' && (values as Uint8Array).some((flag) => flag > 1)) {
      throw new Error(`class '${spec.id}' flag column '${declared.id}' must hold only 0 or 1`);
    }
    return { ...declared, values } as Model.Data['columns'][number];
  });
  return { labels: data.labels, columns };
}
