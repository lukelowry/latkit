/**
 * latkit: columnar data drawn as vertices, edges, faces, lines, and areas with WebGPU.
 *
 * A {@link Data} is a named, immutable collection of tables, changed only by {@link Patch}es. A
 * {@link Scene} describes what to draw and how it answers input: marks that name tables of data, in a
 * space, with a theme and controls. A {@link View} draws a scene into a canvas, is given the data by
 * name, and tells its listeners what the pointer does.
 */

import init, * as wasm from '../pkg/latkit.js';
import type { ColormapName, Scene } from './scene.js';

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

/** A row of a table in a dataset. */
export interface Row {
  data: string;
  table: string;
  id: Id;
}

/** A row under a point, as the frame drew it. */
export interface Hit {
  row: Row;
  /** The index of the scene's mark that drew it. */
  mark: number;
  /** The row's point nearest the probe, CSS pixels from the top left. */
  point: [number, number];
  /** That point in the space's coordinates: x, y, and elevation. */
  position: [number, number, number];
  /** CSS pixels from the probe to the row. */
  distance: number;
}

/** A row of a draggable mark following the pointer. */
export interface Drag {
  phase: 'start' | 'move' | 'end';
  /** The row dragged, as it was hit. */
  hit: Hit;
  /** The pointer, CSS pixels from the top left. */
  point: [number, number];
  /** The point under the pointer at the depth the drag started: x, y, and elevation. */
  position: [number, number, number];
}

/** What a view tells its listeners, by type. */
export interface ViewEvents {
  /** The row under the pointer changed; `null` when it left every row. */
  hover: Hit | null;
  click: Hit;
  /** A row was double clicked. */
  open: Hit;
  /** The selection changed. */
  select: Row[];
  drag: Drag;
  /** The camera moved. */
  camera: Camera;
  /** A mark does not fit its data and draws nothing until a scene or data fixes it. */
  error: LatkitError;
}

/** Where a view looks: on the earth or a plane, or on a plot. */
export type Camera =
  | { center: [number, number]; zoom: number; pitch: number; bearing: number }
  | { x: [number, number]; y: [number, number] | null };

/** What {@link View.fit} frames: everything, some rows, one row kept in view, or a box. */
export type Fit =
  | 'all'
  | { rows: Row[] }
  | { reveal: Row }
  | { bounds: { min: [number, number, number]; max: [number, number, number] } };

/** What a view does each frame. */
export interface Stats {
  frames: number;
  rows: number;
  /** Bytes of data waiting to upload. */
  uploading: number;
  /** Bytes of data resident on the GPU. */
  gpuBytes: number;
  /** Milliseconds the last frame took to record. */
  cpuMs: number;
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

  /** Forgets every sampled field's frames before axis coordinate `before`. */
  forget(before: number): this {
    this.inner.forget(before);
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

  /** The first and last axis coordinates the sampled fields span. */
  get span(): [number, number] | undefined {
    const span = this.inner.span;
    return span ? [span[0]!, span[1]!] : undefined;
  }

  /** Applies every change of `patch`, or none of them when one is invalid. The patch is spent. */
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

/** The GPU device views draw with. Views of one GPU draw in one animation frame. */
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

  /**
   * Calls `listener` with the frame's timestamp every animation frame, before the views draw, so
   * what it changes shows in that frame. Returns a function that stops it.
   */
  on(type: 'frame', listener: (now: number) => void): () => void {
    const handle = this.inner.onFrame(listener);
    return () => handle.free();
  }

  /** Whether the device was lost; a new `Gpu` is needed. */
  get lost(): boolean {
    return this.inner.lost;
  }

  destroy(): void {
    this.inner.free();
  }
}

/** A scene drawn into a canvas, from data it is given by name, answering the canvas's input. */
export class View {
  #listeners = new Map<keyof ViewEvents, Set<(event: never) => void>>();
  #handle?: wasm.Listener;

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

  /** CSS pixels kept clear at the top, right, bottom, and left, as when panels cover the view. */
  get insets(): [number, number, number, number] {
    const [top, right, bottom, left] = this.inner.insets;
    return [top!, right!, bottom!, left!];
  }

  set insets(insets: [number, number, number, number]) {
    this.inner.insets = Float32Array.from(insets);
  }

  /** Degrees per second a map or plane turns around its center; 0 stops it. */
  get orbit(): number {
    return this.inner.orbit;
  }

  set orbit(degreesPerSecond: number) {
    this.inner.orbit = degreesPerSecond;
  }

  /** The rows selected. */
  get selection(): Row[] {
    return this.inner.selection as Row[];
  }

  /** Selects `rows`, and no others. */
  select(rows: Row[]): void {
    this.inner.select(rows);
  }

  /** Eases to `camera`. */
  fly(camera: Camera): void {
    this.inner.fly(JSON.stringify(camera));
  }

  /** Frames what `fit` names on the next frame, keeping pitch and bearing. */
  fit(fit: Fit = 'all'): void {
    this.inner.fit(JSON.stringify(fit));
  }

  get stats(): Stats {
    return this.inner.stats as Stats;
  }

  /** Calls `listener` with each event of `type`; returns a function that stops it. */
  on<T extends keyof ViewEvents>(type: T, listener: (event: ViewEvents[T]) => void): () => void {
    this.#handle ??= this.inner.on((event: { type: keyof ViewEvents; detail: unknown }) => this.#emit(event));
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  #emit({ type, detail }: { type: keyof ViewEvents; detail: unknown }): void {
    const listeners = this.#listeners.get(type) as Set<(event: unknown) => void> | undefined;
    if (!listeners?.size) return;
    const event = type === 'camera' ? this.camera : detail;
    for (const listener of listeners) listener(event);
  }

  /** Stops drawing and frees the view; the canvas keeps its last frame. */
  destroy(): void {
    this.#handle?.free();
    this.#handle = undefined;
    this.inner.free();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/** A CSS gradient through a catalog colormap, for legends. */
export function colormapCss(name: ColormapName, direction = 'to right'): string {
  const texels = wasm.colormap(name);
  if (!texels) throw new Error(`no colormap named ${name}`);
  const stops = Array.from({ length: 17 }, (_, i) => {
    const t = Math.min(255, Math.round((i / 16) * 255)) * 4;
    return `rgba(${texels[t]}, ${texels[t + 1]}, ${texels[t + 2]}, ${(texels[t + 3]! / 255).toFixed(3)}) ${(i / 16) * 100}%`;
  });
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}
