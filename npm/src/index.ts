/**
 * latkit: columnar data drawn as vertices, edges, lines, and areas with WebGPU.
 *
 * A {@link Data} is a named, immutable collection of tables, changed only by {@link Patch}es. A
 * {@link Scene} describes what to draw: marks that name tables of data, in a space, with a theme. A
 * {@link View} draws a scene into a canvas and is given the data by name.
 */

import init, * as wasm from '../pkg/latkit.js';
import type { Scene } from './scene.js';

export * from './scene.js';

await init();

/**
 * What latkit throws: an `Error` with a `code`, and for invalid input the `path` to the part, such
 * as `marks[2].color`.
 */
export interface LatkitError extends Error {
  code: 'invalid' | 'unsupported' | 'limit' | 'load' | 'device-lost';
  path?: string;
}

/** A row's id. */
export type Id = number | string;

/** Row ids: a count for rows `0..n`, or numbers or texts. */
export type Ids = number | Uint32Array | Float64Array | readonly (number | null)[] | readonly (string | null)[];

/** One column of values; `null` is missing. */
export type Values =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | readonly (number | null)[]
  | readonly (boolean | null)[]
  | readonly (string | null)[]
  | readonly [number, number][]
  | readonly [number, number][][]
  | readonly [number, number][][][]
  | readonly [number, number][][][][];

/** A field naming rows of another table by id. */
export interface Reference {
  reference: string;
  ids: Ids;
}

/** Values of a field naming rows of `table` by id. */
export function reference(table: string, ids: Ids): Reference {
  return { reference: table, ids };
}

/** Changes to a dataset, applied in order and all at once by {@link Data.apply}. */
export class Patch {
  /** @internal */
  readonly inner: wasm.Patch;

  constructor(inner?: wasm.Patch) {
    this.inner = inner ?? new wasm.Patch();
  }

  /** A patch received as bytes. */
  static fromBytes(bytes: Uint8Array): Patch {
    return new Patch(wasm.Patch.fromBytes(bytes));
  }

  /** Names the axis sampled fields are recorded over, such as `('time', 's')`. */
  axis(name: string, unit: string): this {
    this.inner.axis(name, unit);
    return this;
  }

  /** Writes `fields` for rows `ids` of `table`: known ids change, others are added. */
  set(table: string, ids: Ids, fields: Record<string, Values | Reference>): this {
    this.inner.set(table, ids, fields);
    return this;
  }

  /** Replaces `table` with these rows and fields. */
  put(table: string, ids: Ids, fields: Record<string, Values | Reference>): this {
    this.inner.put(table, ids, fields);
    return this;
  }

  /** Removes the rows of `table` with `ids`. */
  remove(table: string, ids: Ids): this {
    this.inner.remove(table, ids);
    return this;
  }

  /** Records one frame at axis coordinate `at`: one value per row of `table` for each field. */
  append(at: number, table: string, fields: Record<string, Values>): this {
    this.inner.append(at, table, fields);
    return this;
  }

  toBytes(): Uint8Array {
    return this.inner.toBytes();
  }
}

/** A named collection of tables. `apply` moves it to its next version. */
export class Data {
  /** @internal */
  readonly inner: wasm.Data;

  constructor(name: string | wasm.Data) {
    this.inner = typeof name === 'string' ? new wasm.Data(name) : name;
  }

  /** A dataset from {@link Data.toBytes}. */
  static fromBytes(bytes: Uint8Array): Data {
    return new Data(wasm.Data.fromBytes(bytes));
  }

  get name(): string {
    return this.inner.name;
  }

  /** The names of the tables. */
  get tables(): string[] {
    return this.inner.tables();
  }

  /** Applies every change of `patch`, or none of them when one is invalid. */
  apply(patch: Patch | Uint8Array): this {
    if (patch instanceof Uint8Array) this.inner.applyBytes(patch);
    else this.inner.apply(patch.inner);
    return this;
  }

  /** The value of `field` for the row with `id` in `table`, at axis coordinate `at` when given. */
  get(table: string, id: Id, field: string, at?: number): unknown {
    return this.inner.get(table, id, field, at);
  }

  toBytes(): Uint8Array {
    return this.inner.toBytes();
  }
}

/** Where a view looks: on the earth or a plane, or on a plot. */
export type Camera =
  | { center: [number, number]; zoom: number; pitch: number; bearing: number }
  | { x: [number, number]; y: [number, number] | null };

/** The GPU device views draw with. */
export class Gpu {
  private constructor(private readonly inner: wasm.Gpu) {}

  /** Requests a WebGPU device. */
  static async create(): Promise<Gpu> {
    return new Gpu(await wasm.Gpu.create());
  }

  /** A view drawing `scene` into `canvas`; its marks draw once {@link View.setData} gives their data. */
  view(canvas: HTMLCanvasElement, scene: Scene): View {
    return new View(this.inner.view(canvas, JSON.stringify(scene)));
  }
}

/** A scene drawn into a canvas, from data it is given by name. */
export class View {
  /** @internal */
  constructor(private readonly inner: wasm.View) {}

  /** Draws `scene` instead; an invalid scene throws and changes nothing. */
  show(scene: Scene): void {
    this.inner.show(JSON.stringify(scene));
  }

  /** Gives the view `data`, replacing the dataset of its name. */
  setData(data: Data): void {
    this.inner.setData(data.inner);
  }

  removeData(name: string): void {
    this.inner.removeData(name);
  }

  /** The axis coordinate shown: sampled fields read their last frame at or before it. */
  get at(): number {
    return this.inner.at;
  }

  set at(at: number) {
    this.inner.at = at;
  }

  get camera(): Camera {
    return JSON.parse(this.inner.camera) as Camera;
  }

  set camera(camera: Camera) {
    this.inner.setCamera(JSON.stringify(camera));
  }

  /** Eases to `camera`. */
  fly(camera: Camera): void {
    this.inner.fly(JSON.stringify(camera));
  }

  /** Frames everything drawn. */
  fit(): void {
    this.inner.fit();
  }
}
