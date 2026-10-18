/** WASM-backed data and rendering, loaded only by loadLatkit(). */

import init, * as wasm from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import { jobs } from './jobs.js';
import type { LoadOptions } from './load.js';
import type { ColormapName, Scene } from './scene.js';
import type {
  Budget,
  Camera,
  Fit,
  Hit,
  Id,
  Ids,
  Reference,
  Row,
  Stats,
  Values,
  ViewEvents,
  Work,
} from './types.js';

let run: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined;

/** @internal Initializes the bindings before returning their public API. */
export async function initialize(options: LoadOptions) {
  await init(options.wasm === undefined ? undefined : { module_or_path: options.wasm });
  if (options.createWorker || typeof Worker === 'function') {
    run = jobs(wasm.module() as WebAssembly.Module, options.createWorker);
    wasm.setJobs(run);
  }
  if (typeof VideoEncoder === 'function') wasm.setEncoder(encoder);
  return Object.freeze({ Data, Patch, Gpu, Shot, geojson, colormapCss });
}

/** Changes to a dataset, applied in order and all at once by {@link Data.apply}. */
export class Patch {
  #inner?: wasm.Patch;

  /** @internal */
  get inner(): wasm.Patch {
    if (!this.#inner) throw new Error('this Patch has been applied or destroyed');
    return this.#inner;
  }

  constructor(inner?: wasm.Patch) {
    this.#inner = inner ?? new wasm.Patch();
  }

  /** @internal Transfers the patch to Rust, which consumes it even when applying it fails. */
  take(): wasm.Patch {
    const inner = this.inner;
    this.#inner = undefined;
    return inner;
  }

  /** Releases an unapplied patch. Safe to call again or after applying it. */
  destroy(): void {
    this.#inner?.free();
    this.#inner = undefined;
  }

  [Symbol.dispose](): void {
    this.destroy();
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
  #inner?: wasm.Data;

  /** @internal */
  get inner(): wasm.Data {
    if (!this.#inner) throw new Error('this Data has been destroyed');
    return this.#inner;
  }

  constructor(name: string | wasm.Data) {
    this.#inner = typeof name === 'string' ? new wasm.Data(name) : name;
  }

  /** Releases this handle. Views and other snapshots keep their independently held data. */
  destroy(): void {
    this.#inner?.free();
    this.#inner = undefined;
  }

  [Symbol.dispose](): void {
    this.destroy();
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
      patch instanceof Uint8Array ? this.inner.applyBytes(patch) : this.inner.apply(patch.take()),
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
  const empty = new Data(name);
  try {
    return empty.apply(answer);
  } finally {
    empty.destroy();
  }
}

/** The GPU device views draw with. Views of one GPU draw in one animation frame. */
export class Gpu {
  #inner?: wasm.Gpu;
  #views = new Set<View>();
  #listeners = new Set<() => void>();

  private constructor(inner: wasm.Gpu) {
    this.#inner = inner;
  }

  /** @internal */
  get inner(): wasm.Gpu {
    if (!this.#inner) throw new Error('this Gpu has been destroyed');
    return this.#inner;
  }

  /** Requests a WebGPU device. */
  static async create(): Promise<Gpu> {
    return new Gpu(await wasm.Gpu.create());
  }

  /** A view drawing `scene` into `canvas`; its marks draw once {@link View.setData} gives their data. */
  view(canvas: HTMLCanvasElement, scene: Scene): View {
    const view = new View(this.inner.view(canvas, JSON.stringify(scene)), () =>
      this.#views.delete(view),
    );
    this.#views.add(view);
    return view;
  }

  /**
   * Calls `listener` with the frame's timestamp every animation frame, before the views draw, so
   * what it changes shows in that frame. Returns a function that stops it.
   */
  on(type: 'frame', listener: (now: number) => void): () => void {
    const handle = this.inner.onFrame(listener);
    const stop = (): void => {
      if (this.#listeners.delete(stop)) handle.free();
    };
    this.#listeners.add(stop);
    return stop;
  }

  /** Whether the device was lost; a new `Gpu` is needed. */
  get lost(): boolean {
    return this.inner.lost;
  }

  /** How much GPU memory data takes. */
  get budget(): Budget {
    return this.inner.budget as Budget;
  }

  set budget(budget: Budget) {
    this.inner.setBudget(budget.bytes, budget.uploadPerFrame);
  }

  /** What this GPU did since it was created, counted exactly; see {@link Work}. */
  get work(): Work {
    return this.inner.work as Work;
  }

  /** Releases this GPU's views and frame listeners. Other GPUs and data handles remain usable. */
  destroy(): void {
    if (!this.#inner) return;
    for (const view of this.#views) view.destroy();
    for (const stop of this.#listeners) stop();
    this.#inner.free();
    this.#inner = undefined;
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/** A scene drawn into a canvas, from data it is given by name, answering the canvas's input. */
export class View {
  #listeners = new Map<keyof ViewEvents, Set<(event: never) => void>>();
  #handle?: wasm.Listener;
  #inner?: wasm.View;

  /** @internal */
  constructor(
    inner: wasm.View,
    private readonly released: () => void,
  ) {
    this.#inner = inner;
  }

  private get inner(): wasm.View {
    if (!this.#inner) throw new Error('this View has been destroyed');
    return this.#inner;
  }

  /** @internal The view's canvas, lent to a shot for one call. */
  handle(): wasm.Handle {
    return this.inner.handle();
  }

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
    if (!this.#inner) return;
    this.#handle?.free();
    this.#handle = undefined;
    for (const listeners of this.#listeners.values()) listeners.clear();
    this.#listeners.clear();
    this.#inner.free();
    this.#inner = undefined;
    this.released();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/**
 * A picture of views, each drawn into its part of `size` pixels at `scale` pixels per CSS pixel:
 * plain data, like a scene. A view a shot draws holds its canvas's last frame meanwhile.
 *
 * ```ts
 * const png = await (await new Shot([3840, 2160]).scale(2).image([view])).png();
 * ```
 */
export class Shot {
  /** @internal */
  constructor(
    readonly size: readonly [number, number],
    /** @internal */
    readonly settings: Readonly<{
      scale: number;
      panels: readonly (readonly [number, number, number, number])[];
      transparent: boolean;
      deadline: number;
    }> = { scale: 1, panels: [], transparent: false, deadline: 30_000 },
  ) {}

  /** Draws `scale` pixels per CSS pixel: a view lays out `size / scale` CSS pixels. */
  scale(scale: number): Shot {
    return new Shot(this.size, { ...this.settings, scale });
  }

  /** Adds a view's part of the picture, `[x, y, width, height]` as fractions; views fill parts in order. */
  panel(part: readonly [number, number, number, number]): Shot {
    return new Shot(this.size, { ...this.settings, panels: [...this.settings.panels, part] });
  }

  /** Keeps the picture's alpha: views clear to transparent where their themes' backgrounds are. */
  transparent(): Shot {
    return new Shot(this.size, { ...this.settings, transparent: true });
  }

  /** The longest, in milliseconds, a picture waits for its views to complete: 30 seconds unless set. */
  deadline(ms: number): Shot {
    return new Shot(this.size, { ...this.settings, deadline: ms });
  }

  /** The picture of `views`, one per panel, once every one is complete and still. */
  async image(views: readonly View[]): Promise<Image> {
    return new Image(
      (await wasm.image(
        this.#config(),
        views.map((v) => v.handle()),
      )) as wasm.Image,
    );
  }

  /**
   * A video of these pictures at `fps` frames a second, H.264 in MP4, written to `output` as it is
   * drawn, at `bitrate` bits a second or about 0.15 bits a pixel a frame. Width and height are
   * multiples of 4 and 2.
   */
  video(
    gpu: Gpu,
    fps: number,
    output: WritableStream<Uint8Array>,
    options: { bitrate?: number } = {},
  ): Video {
    return new Video(gpu.inner.video(this.#config(), fps, options.bitrate), output.getWriter());
  }

  #config() {
    return { size: [...this.size], ...this.settings };
  }
}

/** RGBA pixels, straight alpha, rows top to bottom. */
export class Image {
  #inner?: wasm.Image;

  /** @internal */
  constructor(inner: wasm.Image) {
    this.#inner = inner;
  }

  private get inner(): wasm.Image {
    if (!this.#inner) throw new Error('this Image has been destroyed');
    return this.#inner;
  }

  get width(): number {
    return this.inner.width;
  }

  get height(): number {
    return this.inner.height;
  }

  /** The pixels, copied. */
  get rgba(): Uint8Array {
    return this.inner.rgba;
  }

  /** The image as a PNG file, written in a worker. */
  async png(): Promise<Uint8Array> {
    const job = this.inner.pngJob();
    return run ? await run(job) : wasm.job(job);
  }

  destroy(): void {
    this.#inner?.free();
    this.#inner = undefined;
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/** A video being drawn, encoded, and written. */
export class Video {
  /** @internal */
  constructor(
    private readonly inner: wasm.Video,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  /** Seconds into the video the next frame shows at. */
  get time(): number {
    return this.inner.time;
  }

  /** Frames drawn or held so far. */
  get frames(): number {
    return this.inner.frames;
  }

  /**
   * Draws the next frame of `views`, one per panel, at its time once they are complete, and writes
   * what is encoded. It resolves once there is room for another frame; a frame where nothing moved
   * is held, not drawn.
   */
  async frame(views: readonly View[]): Promise<void> {
    const bytes = (await this.inner.frame(views.map((v) => v.handle()))) as Uint8Array;
    if (bytes.length) await this.writer.write(bytes);
  }

  /** Encodes every frame under way, writes the end of the file, and closes the output. */
  async finish(): Promise<void> {
    const bytes = (await this.inner.finish()) as Uint8Array;
    if (bytes.length) await this.writer.write(bytes);
    await this.writer.close();
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
