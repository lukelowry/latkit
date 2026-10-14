/**
 * latkit: columnar data drawn as vertices, edges, faces, lines, and areas with WebGPU.
 *
 * A {@link Data} is a named, immutable collection of tables, changed only by {@link Patch}es. A
 * {@link Scene} describes what to draw and how it answers input: marks that name tables of data, in a
 * space, with a theme and controls. A {@link View} draws a scene into a canvas, is given the data by
 * name, and tells its listeners what the pointer does.
 */

import init, * as wasm from '../pkg/latkit.js';
import { jobs } from './jobs.js';
import type { ColormapName, Scene } from './scene.js';

export * from './scene.js';

await init();
// Work too large for a frame, such as laying out ranks, routing wires, cutting areas into triangles,
// and decoding tiles, runs in workers.
const run = typeof Worker === 'function' ? jobs(wasm.module() as WebAssembly.Module) : undefined;
if (run) wasm.setJobs(run);

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
export type Ids =
  number | Uint32Array | Float64Array | readonly (number | null)[] | readonly (string | null)[];

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
  /** The port hit, when a vertex's port was. */
  port?: string;
  /** The sample hit, when a line tracing a sampled field was. */
  sample?: Sample;
}

/** A sample of a traced field: its frame, the axis coordinate it was recorded at, and its value. */
export interface Sample {
  frame: number;
  at: number;
  value: number;
}

/** Keys held. */
export interface Modifiers {
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** A vertex a connection ends at, and its port when it has the one the connection meets. */
export interface End {
  row: Row;
  port?: string;
}

/** What lies under a secondary click or the menu key's point, for a menu of what to do with it. */
export interface Menu {
  /** CSS pixels from the top left: the pointer, or for the key the view's middle. */
  point: [number, number];
  /** What lies under it, nearest first. */
  hits: Hit[];
  /** Whether the menu key asked. */
  keyboard: boolean;
  modifiers: Modifiers;
}

/** A connection drawn from a port, an Alt-held vertex, or an edge whose end was dragged off it. */
export interface Connect {
  /** The end it was drawn from: for an edge, the end that stayed. */
  from: End;
  /** The vertex it was released over, if any. */
  to: End | null;
  /** The edge whose other end was dragged, which `to` replaces. */
  edge: Row | null;
  /** Where it was released, CSS pixels from the top left. */
  point: [number, number];
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
  /** The secondary button clicked, or the menu key pressed. */
  menu: Menu;
  /** A connection was drawn, with `controls.connect` on. */
  connect: Connect;
  /** Delete or Backspace with rows selected, with `controls.delete` on. */
  delete: Row[];
  /** The camera moved. */
  camera: Camera;
  /** A mark does not fit its data and draws nothing until a scene or data fixes it. */
  error: LatkitError;
}

/**
 * Where a view looks. On the earth, a plane, or a diagram: the point looked at and turned about
 * (`[x, y]` on the ground, or `[x, y, elevation]`), log₂ zoom, and degrees of pitch and bearing, which
 * a diagram keeps at 0. On a plot: the ranges shown, `y: null` fitting the values in view.
 */
export type Camera =
  | {
      center: [number, number] | [number, number, number];
      zoom: number;
      pitch: number;
      bearing: number;
    }
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

/**
 * A named, immutable collection of tables. `apply` gives its next version and leaves this one as it
 * was, so keeping earlier versions, as an undo history does, costs nothing but the pages they hold.
 */
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

  /** Every row's id of `table`, in row order. */
  ids(table: string): Id[] {
    return this.inner.ids(table) as Id[];
  }

  /** The names of `table`'s fields. */
  fields(table: string): string[] {
    return this.inner.fields(table);
  }

  /** The first and last axis coordinates the sampled fields span. */
  get span(): [number, number] | undefined {
    const span = this.inner.span;
    return span ? [span[0]!, span[1]!] : undefined;
  }

  /** The next version: every change of `patch`, or none of them when one is invalid. The patch is
   * spent. */
  apply(patch: Patch | Uint8Array): Data {
    return new Data(
      patch instanceof Uint8Array ? this.inner.applyBytes(patch) : this.inner.apply(patch.inner),
    );
  }

  /** The value of `field` for the row with `id` in `table`, at axis coordinate `at` when given. */
  get(table: string, id: Id, field: string, at?: number): unknown {
    return this.inner.get(table, id, field, at);
  }

  toBytes(): Uint8Array {
    return this.inner.toBytes();
  }
}

/**
 * The features of GeoJSON `bytes`, gzip-compressed or not, as dataset `name`, read in a worker:
 * points, line strings, and polygons as tables `points`, `lines`, and `polygons`, each with its
 * geometry as field `geometry` and its properties as fields.
 */
export async function geojson(name: string, bytes: Uint8Array): Promise<Data> {
  const job = wasm.geojsonJob(name, bytes);
  const answer = run ? await run(job) : wasm.job(job);
  if (answer.length === 0)
    throw Object.assign(new Error(`${name}: the bytes are not GeoJSON`), { code: 'invalid' });
  return new Data(name).apply(answer);
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

  /**
   * Gives the view `data`, replacing the dataset of its name. A mark it no longer fits draws nothing,
   * and the next frame reports why as an error, unless a scene shown before then replaces the mark.
   */
  setData(data: Data): void {
    this.inner.setData(data.inner);
  }

  removeData(name: string): void {
    this.inner.removeData(name);
  }

  /** The dataset named `name`: one given, or the tiles the view fetched. */
  data(name: string): Data | undefined {
    const data = this.inner.data(name);
    return data ? new Data(data) : undefined;
  }

  /**
   * Fetches the vector tiles at `url` as the camera asks for them, kept as dataset `name`, which the
   * view owns: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` template. Each layer is a
   * table of its features of the kind marks draw it as (areas polygons, lines lines, vertices points),
   * or named `layer:polygons`, `layer:lines`, or `layer:points`.
   */
  setTiles(name: string, url: string): void {
    this.inner.setTiles(name, url);
  }

  /** Stops fetching and drawing the tiles of dataset `name`. */
  removeTiles(name: string): void {
    this.inner.removeTiles(name);
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

  /** Where `position` (x, y, elevation) lands on screen, CSS pixels from the top left. */
  point(position: [number, number, number]): [number, number] | undefined {
    const point = this.inner.point(Float64Array.from(position));
    return point ? [point[0]!, point[1]!] : undefined;
  }

  /** The position on the ground under screen point `point`, if the view shows ground there. */
  ground(point: [number, number]): [number, number, number] | undefined {
    const position = this.inner.ground(Float32Array.from(point));
    return position ? [position[0]!, position[1]!, position[2]!] : undefined;
  }

  /** CSS pixels kept clear at the top, right, bottom, and left, as when panels cover the view. */
  get insets(): [number, number, number, number] {
    const [top, right, bottom, left] = this.inner.insets;
    return [top!, right!, bottom!, left!];
  }

  set insets(insets: [number, number, number, number]) {
    this.inner.insets = Float32Array.from(insets);
  }

  /** Degrees per second a map or plane turns around its center; 0 stops it. A diagram never turns. */
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

  /** Every row of a mark that picks within `radius` CSS pixels of `point`, nearest first. */
  pick(point: [number, number], radius: number): Promise<Hit[]> {
    return this.inner.pick(Float32Array.from(point), radius) as Promise<Hit[]>;
  }

  /** Where `row` lies on screen, CSS pixels from the top left, or `null` when no mark draws it in view. */
  locate(row: Row): Promise<[number, number] | null> {
    return this.inner.locate(row) as Promise<[number, number] | null>;
  }

  /** The rows joined to `row`: a vertex's neighbors across edges and nets, or an edge's or a net's vertices. */
  neighbors(row: Row): Row[] {
    return this.inner.neighbors(row) as Row[];
  }

  /** Frames what `fit` names on the next frame, keeping pitch and bearing. */
  fit(fit: Fit = 'all'): void {
    this.inner.fit(JSON.stringify(fit));
  }

  /** Lays every vertex without a position out again by the diagram's layout. Places a layout gave
   * otherwise hold, so rows added later are placed around the rest. */
  arrange(): void {
    this.inner.arrange();
  }

  get stats(): Stats {
    return this.inner.stats as Stats;
  }

  /** Calls `listener` with each event of `type`; returns a function that stops it. */
  on<T extends keyof ViewEvents>(type: T, listener: (event: ViewEvents[T]) => void): () => void {
    this.#handle ??= this.inner.on((event: { type: keyof ViewEvents; detail: unknown }) =>
      this.#emit(event),
    );
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
