/**
 * The model: an immutable, columnar description of a network and its element classes, built once
 * by a vendor and consumed directly by every latkit renderer and view.
 *
 * @remarks
 * A model is a value plus one lazy, cached loader. `Topology` and `Item` are field-for-field the
 * shapes `@latkit/network` loads and picks, so a model never adapts for a renderer.
 */

/** CPU-side graph shape. Field-for-field the topology `@latkit/network` loads. */
export interface Topology {
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
export interface Item {
  readonly kind: 'vertex' | 'edge';
  readonly index: number;
}

/** One element of one class. */
export interface ElementRef {
  readonly classId: string;
  readonly index: number;
}

/**
 * One attribute over every element of a class.
 *
 * @remarks
 * A missing value is `NaN` in a number column and `null` in a text column; a flag is always `0`
 * or `1`. `group` is an optional inspector section; columns without one form the first section.
 */
export type Column =
  | {
      readonly kind: 'number';
      readonly id: string;
      readonly label: string;
      readonly unit?: string;
      readonly group?: string;
      readonly values: Float64Array;
    }
  | {
      readonly kind: 'text';
      readonly id: string;
      readonly label: string;
      readonly group?: string;
      readonly values: readonly (string | null)[];
    }
  | {
      readonly kind: 'flag';
      readonly id: string;
      readonly label: string;
      readonly group?: string;
      readonly values: Uint8Array;
    };

/** One quantity a run can record for every element of a class. */
export interface Signal {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  /** Whether a run of this model records the signal. */
  readonly recorded: boolean;
}

/** One element class: what is always known about it before its data loads. */
export interface ClassSpec {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  /**
   * Where each element sits on the topology: `index[i]` is the vertex or edge of element `i`, or
   * `0xffffffff` when element `i` has no place. An owner class (see `Model.owners`) is anchored by
   * identity and must not declare one; a class with no place on the canvas omits it.
   */
  readonly anchor?: { readonly kind: 'vertex' | 'edge'; readonly index: Uint32Array };
  readonly signals: readonly Signal[];
}

/** One element class's data: a display label per element and its attribute columns. */
export interface ClassData {
  readonly labels: readonly string[];
  readonly columns: readonly Column[];
}

/** What a model loads lazily: class data on demand and the vendor's canonical bytes. */
export interface Loader {
  /** Resolve one class's data. */
  load(classId: string, signal?: AbortSignal): Promise<ClassData>;
  /** The vendor's canonical bytes, for editing and for engines. */
  bytes(signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * A network with element classes.
 *
 * @remarks
 * Immutable. `owners` names the class whose element `i` is vertex `i` and the class whose element
 * `i` is edge `i`; either may be absent. `load` caches, coalesces concurrent callers, and lets
 * each caller abort independently; it rejects for an unknown class.
 */
export interface Model extends Loader {
  readonly vendor: string;
  readonly id: string;
  readonly name: string;
  readonly meta: Readonly<Record<string, number | string | boolean | null>>;
  readonly topology: Topology;
  readonly owners: { readonly vertex?: string; readonly edge?: string };
  readonly classes: readonly ClassSpec[];
}

const NONE = 0xffffffff;

type Data = Omit<Model, keyof Loader>;

interface Pending {
  readonly controller: AbortController;
  readonly promise: Promise<ClassData>;
  subscribers: number;
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

function validateTopology(topology: Topology): void {
  const vertexCount = nonNegativeInteger(topology.vertexCount, 'vertexCount');
  const coords = topology.vertexCoords;
  if (coords !== undefined) {
    if (!isTypedArray(coords, 'Float32Array')) throw new Error('vertexCoords must be Float32Array');
    if (coords.length !== 0 && coords.length !== vertexCount * 2) {
      throw new Error('invalid vertexCoords length');
    }
  }
  const space = topology.coordinateSpace;
  if (space !== undefined && space !== 'cartesian' && space !== 'geographic') {
    throw new Error('invalid coordinateSpace');
  }
  const edges = topology.edges;
  if (!isTypedArray(edges, 'Uint32Array')) throw new Error('edges must be Uint32Array');
  if (edges.length % 2 !== 0) throw new Error('invalid edges length');
  for (const endpoint of edges) {
    if (endpoint >= vertexCount) throw new Error('edge endpoint out of range');
  }
  const edgeCount = edges.length / 2;
  const points = topology.polylinePoints;
  if (points !== undefined && !isTypedArray(points, 'Float32Array')) {
    throw new Error('polylinePoints must be Float32Array');
  }
  const pointLength = points?.length ?? 0;
  if (pointLength % 2 !== 0) throw new Error('invalid polylinePoints length');
  const start = topology.polylineStart;
  if (!isTypedArray(start, 'Uint32Array')) throw new Error('polylineStart must be Uint32Array');
  if (start.length !== edgeCount + 1) throw new Error('invalid polylineStart length');
  if (start[0] !== 0) throw new Error('polylineStart must begin at zero');
  if (start[edgeCount] !== pointLength / 2) throw new Error('polylineStart terminal mismatch');
  for (let edge = 0; edge < edgeCount; edge++) {
    if (start[edge + 1]! < start[edge]!) throw new Error('polylineStart is not monotonic');
  }
}

function validateSpec(spec: ClassSpec, topology: Topology, owner: 'vertex' | 'edge' | null): void {
  const id = nonEmptyString(spec.id, 'class id');
  if (typeof spec.label !== 'string') throw new Error(`class '${id}' label must be a string`);
  const count = nonNegativeInteger(spec.count, `class '${id}' count`);
  if (!Array.isArray(spec.signals as unknown)) {
    throw new Error(`class '${id}' signals must be an array`);
  }
  const ids = new Set<string>();
  for (const signal of spec.signals) {
    const signalId = nonEmptyString(signal.id, `class '${id}' signal id`);
    if (ids.has(signalId)) throw new Error(`class '${id}' repeats signal '${signalId}'`);
    ids.add(signalId);
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

function validateData(spec: ClassSpec, data: ClassData): void {
  if (!Array.isArray(data.labels) || data.labels.length !== spec.count) {
    throw new Error(`class '${spec.id}' data must carry one label per element`);
  }
  if (!Array.isArray(data.columns as unknown)) {
    throw new Error(`class '${spec.id}' columns must be an array`);
  }
  const ids = new Set<string>();
  for (const column of data.columns) {
    const id = nonEmptyString(column.id, `class '${spec.id}' column id`);
    if (ids.has(id)) throw new Error(`class '${spec.id}' repeats column '${id}'`);
    ids.add(id);
    const ok =
      column.kind === 'number'
        ? isTypedArray(column.values, 'Float64Array')
        : column.kind === 'text'
          ? Array.isArray(column.values)
          : column.kind === 'flag' && isTypedArray(column.values, 'Uint8Array');
    if (!ok || column.values.length !== spec.count) {
      throw new Error(`class '${spec.id}' column '${id}' has the wrong kind or length`);
    }
    if (column.kind === 'flag' && column.values.some((flag) => flag > 1)) {
      throw new Error(`class '${spec.id}' flag column '${id}' must hold only 0 or 1`);
    }
  }
}

/**
 * Build a model from its data and its loader.
 *
 * @remarks
 * The one place a model is validated: unique ids, anchors within the topology, owners with one
 * element per item, a consistent topology, and every loaded class the shape its spec promised.
 * Vendors and the unpacker both build models here.
 *
 * @throws Error when the data is inconsistent.
 */
export function createModel(model: Data, loader: Loader): Model {
  nonEmptyString(model.vendor, 'model vendor');
  nonEmptyString(model.id, 'model id');
  if (typeof model.name !== 'string') throw new Error('model name must be a string');
  for (const [key, value] of Object.entries(model.meta)) {
    if (value !== null && !['number', 'string', 'boolean'].includes(typeof value)) {
      throw new Error(`meta '${key}' must be a number, string, boolean, or null`);
    }
  }
  validateTopology(model.topology);
  if (!Array.isArray(model.classes as unknown)) throw new Error('classes must be an array');
  const owners: Record<'vertex' | 'edge', string | null> = { vertex: null, edge: null };
  for (const kind of ['vertex', 'edge'] as const) {
    const owner = model.owners[kind];
    if (owner === undefined) continue;
    if (!model.classes.some((spec) => spec.id === owner)) {
      throw new Error(`${kind} owner '${String(owner)}' is not a class`);
    }
    owners[kind] = owner;
  }
  const byId = new Map<string, ClassSpec>();
  for (const spec of model.classes) {
    if (byId.has(spec.id)) throw new Error(`duplicate class id '${spec.id}'`);
    const owner = owners.vertex === spec.id ? 'vertex' : owners.edge === spec.id ? 'edge' : null;
    validateSpec(spec, model.topology, owner);
    byId.set(spec.id, spec);
  }

  const loaded = new Map<string, ClassData>();
  const pending = new Map<string, Pending>();

  function begin(spec: ClassSpec): Pending {
    const controller = new AbortController();
    const settle = (): void => {
      if (pending.get(spec.id) === entry) pending.delete(spec.id);
    };
    const entry: Pending = {
      controller,
      subscribers: 0,
      promise: loader.load(spec.id, controller.signal).then(
        (data) => {
          controller.signal.throwIfAborted();
          validateData(spec, data);
          loaded.set(spec.id, data);
          settle();
          return data;
        },
        (error: unknown) => {
          settle();
          throw error;
        },
      ),
    };
    pending.set(spec.id, entry);
    return entry;
  }

  /** One shared load per class; each caller may abort without cancelling the others. */
  function subscribe(classId: string, entry: Pending, signal?: AbortSignal): Promise<ClassData> {
    entry.subscribers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = (): void => {
        signal?.removeEventListener('abort', abort);
        entry.subscribers--;
        if (entry.subscribers === 0 && pending.get(classId) === entry) entry.controller.abort();
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

  return {
    vendor: model.vendor,
    id: model.id,
    name: model.name,
    meta: model.meta,
    topology: model.topology,
    owners: model.owners,
    classes: model.classes,
    load(classId, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      const data = loaded.get(classId);
      if (data) return Promise.resolve(data);
      const spec = byId.get(classId);
      if (!spec) return Promise.reject(new Error(`unknown class '${classId}'`));
      let entry = pending.get(classId);
      if (!entry || entry.controller.signal.aborted) entry = begin(spec);
      return subscribe(classId, entry, signal);
    },
    bytes: (signal) => loader.bytes(signal),
  };
}

/** The element a picked item is, through the model's owners; null when nothing owns that kind. */
export function elementAt(model: Pick<Model, 'owners' | 'classes'>, item: Item): ElementRef | null {
  const classId = model.owners[item.kind];
  if (classId === undefined) return null;
  const spec = model.classes.find((candidate) => candidate.id === classId);
  if (!spec || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= spec.count) {
    return null;
  }
  return { classId, index: item.index };
}

/** Where an element sits on the topology: by identity for an owner class, else through its
 *  class's anchor; null when it has no place. */
export function itemOf(model: Pick<Model, 'owners' | 'classes'>, ref: ElementRef): Item | null {
  const spec = model.classes.find((candidate) => candidate.id === ref.classId);
  if (!spec || !Number.isSafeInteger(ref.index) || ref.index < 0 || ref.index >= spec.count) {
    return null;
  }
  for (const kind of ['vertex', 'edge'] as const) {
    if (model.owners[kind] === ref.classId) return { kind, index: ref.index };
  }
  if (!spec.anchor) return null;
  const index = spec.anchor.index[ref.index]!;
  return index === NONE ? null : { kind: spec.anchor.kind, index };
}
