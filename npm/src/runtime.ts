/// <reference lib="esnext.disposable" preserve="true" />
/** WebAssembly-backed data and drawing, loaded only by loadLatkit(). */

import init, * as wasm from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import type { Budget, Camera, Colormap, Fit, Id, Query, Row, Rows, Scene } from './inputs.js';
import { jobs } from './jobs.js';
import { takeAdapter, type LoadOptions } from './load.js';
import type { Description, Failure, Hit, Stats, Value, ViewEvent, Work } from './outputs.js';
import { Patch } from './patch.js';

let run: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined;
/** The page's first GPU, made as the runtime loads, until `Gpu.create()` takes it. */
let first: Promise<wasm.Gpu> | undefined;

/** @internal Initializes the bindings before returning their public API. */
export async function initialize(options: LoadOptions) {
  await init(options.wasm === undefined ? undefined : { module_or_path: options.wasm });
  if (options.createWorker || typeof Worker === 'function') {
    run = jobs(wasm.module() as WebAssembly.Module, options.createWorker);
    wasm.setJobs(run);
  }
  if (typeof VideoEncoder === 'function') wasm.setEncoder(encoder);
  // The page's first GPU is made now, so the page does not wait for its device when it draws.
  if ((globalThis.navigator as { gpu?: unknown } | undefined)?.gpu) {
    first = made();
    first.catch(() => {});
  }
  return Object.freeze({ Data, Gpu, Shot, colormapCss });
}

/**
 * A GPU, on the adapter asked for as the runtime loaded while that one is left: latkit's own request
 * for an adapter, a moment from now, finds it instead of asking the browser again.
 */
async function made(): Promise<wasm.Gpu> {
  const adapter = takeAdapter();
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter?: unknown } } | undefined)?.gpu;
  if (!adapter || !gpu) return wasm.Gpu.create();
  gpu.requestAdapter = () => {
    delete gpu.requestAdapter;
    return adapter;
  };
  try {
    return await wasm.Gpu.create();
  } finally {
    delete gpu.requestAdapter;
  }
}

/** @internal The bytes of the patch its JSON makes, for `Patch.load`. */
export async function readPatch(json: string, base: string): Promise<Uint8Array> {
  return (await wasm.loadPatch(json, base)) as Uint8Array;
}

/**
 * What latkit throws: an `Error` with a `code`, and for invalid input the `path` to the part, such
 * as `marks[2].vertices.color`.
 */
export interface LatkitError extends Error {
  code: Failure['code'];
  path?: string;
}

/**
 * What a view tells its listeners, by type. Intents (`click`, `open`, `menu`, `drag`, `connect`,
 * `delete`) are told once each, in the order the user acted. Changes (`hover`, `select`, `camera`,
 * `waiting`) tell only their latest, and their state can always be read. A view tells only what the
 * application did not do itself: its setters change state silently.
 */
export type ViewEvents = {
  [E in ViewEvent as E['type']]: E extends { type: 'error' } ? LatkitError : E['detail'];
};

/** The error `failure` describes, as latkit throws them. */
function thrown({ code, message, path }: Failure): LatkitError {
  return Object.assign(new Error(message), path === undefined ? { code } : { code, path });
}

/** `promise`, or a `timeout` error once `seconds` pass first. */
function deadline<T>(promise: Promise<T>, seconds: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          thrown({
            code: 'timeout',
            message: `${what} took over ${seconds} s: is the view drawn?`,
          }),
        ),
      seconds * 1000,
    );
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * The rows a query keeps, in the forms a patch writes: numbers as a `Float64Array` (missing NaN),
 * other values as arrays (missing `null`), a reference as its target ids.
 */
export interface Table {
  table: string;
  ids: Id[];
  fields: Record<string, Float64Array | Value[] | { reference: string; ids: (Id | null)[] }>;
  /** The rows the query kept before paging. */
  total: number;
}

/** Rows' least and greatest values over spans of the axis: `at` holds one more edge than spans. */
export interface Envelope {
  at: Float64Array;
  least: Float32Array;
  greatest: Float32Array;
}

/**
 * A named collection of tables, changed in place by patches. A snapshot keeps a version, sharing
 * every page with it, so keeping earlier versions, as an undo history does, costs only the pages
 * they hold apart. A view draws the version it was given until it is given another.
 */
export class Data {
  #inner?: wasm.Data;

  /** @internal */
  get inner(): wasm.Data {
    if (!this.#inner) throw new Error('this Data has been destroyed');
    return this.#inner;
  }

  constructor(name: string);
  /** @internal */
  constructor(name: wasm.Data);
  constructor(name: string | wasm.Data) {
    this.#inner = typeof name === 'string' ? new wasm.Data(name) : name;
  }

  /** Releases this handle. Views and snapshots keep the versions they hold. */
  destroy(): void {
    this.#inner?.free();
    this.#inner = undefined;
  }

  [Symbol.dispose](): void {
    this.destroy();
  }

  /**
   * The dataset `bytes` hold: latkit's bytes, renamed `name` when given, or GeoJSON, gzip-compressed
   * or not, read in a worker as dataset `name`: points, line strings, and polygons as tables
   * `points`, `lines`, and `polygons`, each with its geometry as field `geometry` and its properties
   * as fields.
   */
  static async read(bytes: Uint8Array, name?: string): Promise<Data> {
    if ([0x4c, 0x41, 0x54, 0x4b].every((b, i) => bytes[i] === b))
      return new Data(wasm.Data.read(bytes, name));
    if (name === undefined)
      throw thrown({ code: 'invalid', message: 'GeoJSON is read as a named dataset' });
    const job = wasm.geojsonJob(name, bytes);
    const answer = run ? await run(job) : wasm.job(job);
    if (answer.length === 0)
      throw thrown({
        code: 'invalid',
        message: `${name}: the bytes are neither latkit's nor GeoJSON`,
      });
    return new Data(wasm.Data.read(answer, name));
  }

  /**
   * The dataset its JSON document builds, `{"name": ..., "patch": [...]}`, the patch loading as
   * `Patch.load` loads one.
   */
  static async load(json: string, base = ''): Promise<Data> {
    return new Data((await wasm.Data.load(json, base)) as wasm.Data);
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

  /** Applies every change of `patch`, or none when one is invalid. */
  apply(patch: Patch | Uint8Array): this {
    this.inner.apply(patch instanceof Patch ? patch.frame() : patch);
    return this;
  }

  /** This version, kept while `apply` changes this one: O(1). */
  snapshot(): Data {
    return new Data(this.inner.snapshot());
  }

  /** The value of `field` for the row with `id` in `table`, at axis coordinate `at` when given. */
  get(table: string, id: Id, field: string, at?: number): Value {
    return JSON.parse(this.inner.get(table, id, field, at)) as Value;
  }

  /** What the dataset holds: tables, rows, fields and their kinds, the axis and its span. */
  describe(): Description {
    return JSON.parse(this.inner.describe()) as Description;
  }

  /**
   * The rows of a table `query` keeps, filtered, sorted, and paged, sampled fields read at its
   * coordinate, on the CPU through the expressions marks draw with.
   */
  query(query: Query): Table {
    return this.inner.query(JSON.stringify(query)) as Table;
  }

  /**
   * Each row's least and greatest value of sampled `field` of `table` over `spans` equal spans of
   * `range`, of every row or of rows `ids`: row after row, NaN where a span holds no frame. Reads the
   * coarsest levels of detail that fit, so a span costs a few reads however many frames it covers.
   */
  envelope(
    table: string,
    field: string,
    range: [number, number],
    spans: number,
    ids?: readonly Id[],
  ): Envelope {
    const listed = ids === undefined ? undefined : JSON.stringify(ids);
    return this.inner.envelope(table, field, Float64Array.from(range), spans, listed) as Envelope;
  }

  /** The dataset as latkit's bytes: the patch that builds it. */
  toBytes(): Uint8Array {
    return this.inner.toBytes();
  }
}

/** The GPU device views draw with. Views of one GPU draw in one animation frame. */
export class Gpu {
  #inner?: wasm.Gpu;
  #views = new Set<View>();
  #canvases = new Set<Canvas>();
  #listeners = new Set<() => void>();

  private constructor(inner: wasm.Gpu) {
    this.#inner = inner;
  }

  /** @internal */
  get inner(): wasm.Gpu {
    if (!this.#inner) throw new Error('this Gpu has been destroyed');
    return this.#inner;
  }

  /** Requests a WebGPU device: the first call takes the one made as latkit loaded. */
  static async create(): Promise<Gpu> {
    const inner = first ?? made();
    first = undefined;
    return new Gpu(await inner);
  }

  /**
   * A view of `scene`; its marks draw once {@link View.setData} gives their data. A {@link Canvas}
   * shows it, and a {@link Shot} draws it with or without one.
   */
  view(scene: Scene): View {
    const view: View = new View(
      (tell) => this.inner.view(JSON.stringify(scene), tell),
      () => this.#views.delete(view),
    );
    this.#views.add(view);
    return view;
  }

  /**
   * A canvas showing views in `panels` of `target`: a `<canvas>` element, which sizes itself to its
   * CSS box and passes each view the input landing on its panel, or an `OffscreenCanvas` in a
   * worker, which keeps the size it is given at `pixelRatio` pixels a CSS pixel. Panels are
   * `[x, y, width, height]` fractions, one per view; by default one view fills the canvas.
   */
  canvas(
    target: HTMLCanvasElement | OffscreenCanvas,
    options: { panels?: readonly Panel[]; pixelRatio?: number } = {},
  ): Canvas {
    const canvas: Canvas = new Canvas(
      this.inner.canvas(target, JSON.stringify(options.panels ?? []), options.pixelRatio),
      () => this.#canvases.delete(canvas),
    );
    this.#canvases.add(canvas);
    return canvas;
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
    return JSON.parse(this.inner.budget) as Budget;
  }

  set budget(budget: Budget) {
    this.inner.setBudget(JSON.stringify(budget));
  }

  /** What this GPU did since it was created, counted exactly; see {@link Work}. */
  get work(): Work {
    return JSON.parse(this.inner.work) as Work;
  }

  /**
   * Draws one frame now at `now`, milliseconds on the clock animation frames give: the frame
   * listeners, then every canvas that needs a frame. From the first step no animation frames are
   * asked for: a harness, as tests and benchmarks are, steps every frame itself, so a run draws the
   * same frames however fast the device is.
   */
  step(now: number): void {
    this.inner.step(now);
  }

  /**
   * Resolves once the GPU finished the work submitted to it, every readback landed, and every
   * pipeline a view or shot asked for compiled: a frame stepped then draws all of it. A `timeout`
   * error after `deadline` seconds.
   */
  async done({ deadline: seconds = 30 } = {}): Promise<void> {
    await deadline(this.inner.done() as Promise<void>, seconds, 'the GPU');
  }

  /**
   * Resolves when work a view waits on lands after this call (a readback, a compile, a job, a text,
   * a fetch), or a view asks for a frame. A `timeout` error after `deadline` seconds.
   */
  async landed({ deadline: seconds = 30 } = {}): Promise<void> {
    await deadline(this.inner.landed() as Promise<void>, seconds, 'work landing');
  }

  /** Releases this GPU's canvases, views, and frame listeners. Other GPUs and data stay usable. */
  destroy(): void {
    if (!this.#inner) return;
    for (const canvas of this.#canvases) canvas.destroy();
    for (const view of this.#views) view.destroy();
    for (const stop of this.#listeners) stop();
    this.#inner.free();
    this.#inner = undefined;
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/** A view's panel of a canvas or a picture: `[x, y, width, height]` as fractions of it. */
export type Panel = readonly [number, number, number, number];

/** Views shown in the panels of a `<canvas>` or an `OffscreenCanvas`. */
export class Canvas {
  #inner?: wasm.Canvas;

  /** @internal */
  constructor(
    inner: wasm.Canvas,
    private readonly released: () => void,
  ) {
    this.#inner = inner;
  }

  /** Shows `views`, one per panel, in place of those it showed. A view shows in one canvas at a time. */
  show(views: readonly View[]): this {
    if (!this.#inner) throw new Error('this Canvas has been destroyed');
    this.#inner.show(views.map((v) => v.handle()));
    return this;
  }

  /** Stops drawing; the views remain, and the element keeps its last frame. */
  destroy(): void {
    if (!this.#inner) return;
    this.#inner.free();
    this.#inner = undefined;
    this.released();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/** A scene drawn from data it is given by name: shown by a canvas, which passes it input, or drawn by shots. */
export class View {
  #listeners = new Map<keyof ViewEvents, Set<(event: never) => void>>();
  #inner?: wasm.View;

  /** @internal Makes the view with what takes its events, a JSON batch at a time, from the start. */
  constructor(
    make: (tell: (json: string) => void) => wasm.View,
    private readonly released: () => void,
  ) {
    this.#inner = make((json) => this.#tell(json));
  }

  private get inner(): wasm.View {
    if (!this.#inner) throw new Error('this View has been destroyed');
    return this.#inner;
  }

  /** @internal The view, for a canvas to show or a shot to draw. */
  handle(): wasm.Handle {
    return this.inner.handle();
  }

  /** Draws `scene` instead; an invalid scene throws and changes nothing. */
  show(scene: Scene): void {
    this.inner.show(JSON.stringify(scene));
  }

  /**
   * Gives the view `data` as it is now, replacing the dataset of its name: give it again after
   * applying patches. A mark it no longer fits draws nothing, and the next frame reports why as an
   * error, unless a scene shown before then replaces the mark.
   */
  setData(data: Data): void {
    this.inner.setData(data.inner);
  }

  /**
   * Fetches the data at `url` in pieces as the view asks for them, kept as dataset `name`, which the
   * view owns; the source's first bytes say what it is.
   *
   * - Time tiles, a `frames.json` manifest as `latkit tile` writes it: a dataset whose sampled
   *   fields' histories are fetched in spans. A line tracing a field fetches the detail its plot
   *   window draws, a mark showing one the frames about the view's coordinate, and a span still
   *   loading draws the coarser span above it.
   * - Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` template, fetched as
   *   the camera asks. Each layer is a table of its features of the kind marks draw it as (areas
   *   polygons, lines lines, vertices points), or named `layer:polygons`, `layer:lines`, or
   *   `layer:points`.
   */
  setTiles(name: string, url: string): void {
    this.inner.setTiles(name, url);
  }

  /** Stops drawing the dataset named `name`, given or fetched as tiles. */
  removeData(name: string): void {
    this.inner.removeData(name);
  }

  /** The dataset named `name`, as given or as the view fetched it, as a snapshot. */
  data(name: string): Data | undefined {
    const data = this.inner.data(name);
    return data ? new Data(data) : undefined;
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

  /** Frames what `fit` names on the next frame, keeping pitch and bearing. */
  fit(fit: Fit = 'all'): void {
    this.inner.fit(JSON.stringify(fit));
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

  /** The rows selected, a set per table. */
  get selection(): Rows[] {
    return JSON.parse(this.inner.selection) as Rows[];
  }

  /**
   * Selects `rows`, and no others. Like every setter it tells nothing: `select` events tell what
   * the user and the data changed.
   */
  select(rows: readonly Rows[]): void {
    this.inner.select(JSON.stringify(rows));
  }

  /** What the user points at: the row under the pointer, or the row the keys stepped to. */
  get hovered(): Hit | null {
    return JSON.parse(this.inner.hovered) as Hit | null;
  }

  /** Every mark that draws nothing because its data no longer fits it, and why. */
  get failures(): LatkitError[] {
    return (JSON.parse(this.inner.failures) as Failure[]).map(thrown);
  }

  /**
   * Every row of a mark that picks within `radius` CSS pixels of `point`, nearest first, once a frame
   * draws the view: a `timeout` error after `deadline` seconds without one.
   */
  async pick(
    point: [number, number],
    radius: number,
    { deadline: seconds = 5 } = {},
  ): Promise<Hit[]> {
    const hits = this.inner.pick(Float32Array.from(point), radius) as Promise<string>;
    return JSON.parse(await deadline(hits, seconds, 'a pick')) as Hit[];
  }

  /**
   * Where `row` lies on screen, CSS pixels from the top left, or `null` when no mark draws it in
   * view, once a frame draws the view: a `timeout` error after `deadline` seconds without one.
   */
  locate(row: Row, { deadline: seconds = 5 } = {}): Promise<[number, number] | null> {
    const point = this.inner.locate(JSON.stringify(row)) as Promise<[number, number] | null>;
    return deadline(point, seconds, 'locating a row');
  }

  /** The rows joined to `row`, a set per table: a vertex's neighbors across edges and nets, or an
   * edge's or a net's vertices. */
  neighbors(row: Row): Rows[] {
    return JSON.parse(this.inner.neighbors(JSON.stringify(row))) as Rows[];
  }

  /**
   * Lays every vertex row without a position out again by the scene's layout: a diagram's blocks, or
   * points on a plane or the earth. Places a layout gave otherwise hold, so rows added later are
   * placed around the rest. Once the layout lands, answers a patch to each dataset writing each row
   * laid out into its mark's position fields; applied, the places are the data's own. A `timeout`
   * error after `deadline` seconds without it.
   *
   * ```ts
   * for (const patch of await view.arrange()) if (patch.data === data.name) data.apply(patch);
   * ```
   */
  async arrange({ deadline: seconds = 60 } = {}): Promise<Patch[]> {
    const frames = (await deadline(this.inner.arrange(), seconds, 'arranging')) as Uint8Array[];
    return frames.map((frame) => Patch.fromBytes(frame));
  }

  get stats(): Stats {
    return JSON.parse(this.inner.stats) as Stats;
  }

  /** Whether the view wants a frame: it changed, or work it waited on landed. */
  get wantsFrame(): boolean {
    return this.inner.wantsFrame;
  }

  /**
   * Calls `listener` with each event of `type` told while it listens; returns a function that
   * stops it. What lasts is state to read: `hovered`, `selection`, `camera`, `stats.waiting`, and
   * `failures`.
   */
  on<T extends keyof ViewEvents>(type: T, listener: (event: ViewEvents[T]) => void): () => void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Hands a batch of the view's events to the listeners of each one's type. */
  #tell(json: string): void {
    if (this.#listeners.size === 0) return;
    for (const told of JSON.parse(json) as ViewEvent[]) {
      const listeners = this.#listeners.get(told.type) as Set<(event: unknown) => void> | undefined;
      if (!listeners?.size) continue;
      const event = told.type === 'error' ? thrown(told.detail) : told.detail;
      for (const listener of listeners) listener(event);
    }
  }

  /** Frees the view, and rejects what it was asked and has not answered; a canvas showing it keeps
   * its last frame. */
  destroy(): void {
    if (!this.#inner) return;
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

type ShotSettings = Readonly<{
  scale: number;
  panels: readonly Panel[];
  transparent: boolean;
  deadline: number;
  elapsed?: number;
}>;

/**
 * A picture of views, each drawn into its panel of `size` pixels at `scale` pixels per CSS pixel:
 * plain data, like a scene. A view a shot draws holds its canvas's last frame meanwhile.
 *
 * ```ts
 * const png = await (await new Shot([3840, 2160]).scale(2).image([view])).encode('png');
 * ```
 */
export class Shot {
  /** A picture with width and height in pixels. */
  constructor(size: readonly [number, number]);
  /** @internal */
  constructor(size: readonly [number, number], settings: ShotSettings);
  constructor(
    readonly size: readonly [number, number],
    /** @internal */
    readonly settings: ShotSettings = { scale: 1, panels: [], transparent: false, deadline: 30 },
  ) {}

  /** Draws `scale` pixels per CSS pixel: a view lays out `size / scale` CSS pixels. */
  scale(scale: number): Shot {
    return new Shot(this.size, { ...this.settings, scale });
  }

  /** Where each view draws, `[x, y, width, height]` as fractions, one per view in order; by default one fills it. */
  panels(panels: readonly Panel[]): Shot {
    return new Shot(this.size, { ...this.settings, panels });
  }

  /** Keeps the picture's alpha: views clear to transparent where their themes' backgrounds are. */
  transparent(): Shot {
    return new Shot(this.size, { ...this.settings, transparent: true });
  }

  /** The shot's deadline in seconds, including readback; rejects on timeout. Defaults to 30. */
  deadline(seconds: number): Shot {
    return new Shot(this.size, { ...this.settings, deadline: seconds });
  }

  /** Fixes elapsed-time expressions and drawing effects at `seconds` while transitions settle. */
  elapsed(seconds: number): Shot {
    return new Shot(this.size, { ...this.settings, elapsed: seconds });
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
   * multiples of 4 and 2. `signal` aborts it: the output is aborted and the views are given back.
   */
  video(
    gpu: Gpu,
    fps: number,
    output: WritableStream<Uint8Array>,
    options: { bitrate?: number; signal?: AbortSignal } = {},
  ): Video {
    options.signal?.throwIfAborted();
    const writer = output.getWriter();
    try {
      return new Video(
        gpu.inner.video(this.#config(), fps, options.bitrate),
        writer,
        fps,
        options.signal,
      );
    } catch (error) {
      writer.releaseLock();
      throw error;
    }
  }

  /** The shot as the crate reads it: JSON, times in seconds. */
  #config(): string {
    return JSON.stringify({ size: [...this.size], ...this.settings });
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

  /**
   * The image as a file, written in a worker: PNG, lossless with alpha; JPEG at `quality` from 1 to
   * 100 (90 by default), small, its alpha dropped; or WebP, lossless with alpha, smaller than PNG.
   */
  async encode(format: ImageFormat, options: { quality?: number } = {}): Promise<Uint8Array> {
    const job = this.inner.encodeJob(format, options.quality);
    const file = run ? await run(job) : wasm.job(job);
    if (file.length === 0)
      throw thrown({ code: 'invalid', message: `the image could not be written as ${format}` });
    return file;
  }

  destroy(): void {
    this.#inner?.free();
    this.#inner = undefined;
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/** How an image is written as a file. */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** A video being drawn, encoded, and written. */
export class Video {
  #inner?: wasm.Video;
  #state: 'open' | 'finishing' | 'aborting' | 'closed' = 'open';
  #operation?: Promise<void>;
  #finished?: Promise<void>;
  #aborted?: Promise<void>;
  #reason: unknown;
  #frames = 0;
  #removeAbort?: () => void;

  /** @internal */
  constructor(
    inner: wasm.Video,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
    private readonly fps: number,
    signal?: AbortSignal,
  ) {
    this.#inner = inner;
    if (signal) {
      const abort = () => {
        void this.abort(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.#removeAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
  }

  #check(): wasm.Video {
    if (!this.#inner || this.#state === 'aborting' || this.#state === 'closed')
      throw Object.assign(
        thrown({ code: 'cancelled', message: 'this Video was finished or aborted' }),
        { cause: this.#reason },
      );
    return this.#inner;
  }

  /** Seconds into the video the next frame shows at; retained after completion. */
  get time(): number {
    return this.frames / this.fps;
  }

  /** Frames drawn or held so far; retained after completion. */
  get frames(): number {
    return this.#inner?.frames ?? this.#frames;
  }

  /** Draws and writes one frame, waiting for output backpressure. Only one frame may run at a time. */
  frame(views: readonly View[]): Promise<void> {
    if (this.#state !== 'open' || this.#operation)
      return Promise.reject(new Error('a Video draws one frame at a time, before finish'));
    const operation = (async () => {
      const bytes = (await this.#check().frame(views.map((v) => v.handle()))) as Uint8Array;
      this.#frames = this.#check().frames;
      if (bytes.length) await this.writer.write(bytes);
    })();
    this.#operation = operation;
    return operation
      .catch(async (error: unknown) => {
        await this.abort(error);
        throw error;
      })
      .finally(() => {
        if (this.#operation === operation) this.#operation = undefined;
      });
  }

  /** Records until `step(time)` returns false; any step, drawing, output, or progress error aborts it. */
  async record(
    views: readonly View[],
    step: (time: number) => boolean | Promise<boolean>,
    onProgress?: (progress: { frames: number; time: number }) => void,
  ): Promise<void> {
    try {
      while (await step(this.time)) {
        await this.frame(views);
        onProgress?.({ frames: this.frames, time: this.time });
      }
      await this.finish();
    } catch (error) {
      await this.abort(error);
      throw error;
    }
  }

  /** Finishes pending work, writes the end of the file, and closes and unlocks the output. Idempotent. */
  finish(): Promise<void> {
    if (this.#finished) return this.#finished;
    if (this.#state !== 'open') return Promise.reject(new Error('this Video was aborted'));
    this.#state = 'finishing';
    const frame = this.#operation;
    const operation = (async () => {
      await frame;
      const bytes = (await this.#check().finish()) as Uint8Array;
      this.#check();
      if (bytes.length) await this.writer.write(bytes);
      this.#check();
      await this.writer.close();
    })();
    this.#operation = operation;
    this.#finished = operation
      .then(() => {
        if (this.#state === 'finishing') this.#release();
      })
      .catch(async (error: unknown) => {
        await this.abort(error);
        throw error;
      });
    return this.#finished;
  }

  /** Cancels drawing and encoding, aborts the output, and unlocks it after pending writes settle. Idempotent. */
  abort(reason?: unknown): Promise<void> {
    if (this.#aborted) return this.#aborted;
    if (this.#state === 'closed') return Promise.resolve();
    this.#state = 'aborting';
    this.#reason = reason;
    this.#frames = this.frames;
    this.#inner?.cancel();
    this.#aborted = Promise.allSettled([this.#operation, this.writer.abort(reason)]).then(() =>
      this.#release(),
    );
    return this.#aborted;
  }

  #release(): void {
    this.#frames = this.frames;
    this.#inner?.free();
    this.#inner = undefined;
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    this.writer.releaseLock();
    this.#state = 'closed';
  }
}
/**
 * A CSS gradient through `map`, a catalog name or colors of your own, for legends: the colors the
 * GPU draws, a band each for a categorical map's categories.
 */
export function colormapCss(map: Colormap, direction = 'to right'): string {
  return wasm.colormapCss(JSON.stringify(map), direction);
}
