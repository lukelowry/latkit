/** WASM-backed data and rendering, loaded only by loadLatkit(). */

import init, * as wasm from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import { jobs } from './jobs.js';
import type { LoadOptions } from './load.js';
import type { Budget, Camera, Colormap, Fit, Id, Query, Row, Scene } from './forms.js';
import type {
  Description,
  Envelope,
  Hit,
  Ids,
  LatkitError,
  Reference,
  Rows,
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

  /**
   * The patches arriving back to back in `stream`, each as soon as its last byte does: a response
   * body, a file, or a socket's messages. A patch longer than `limit` bytes (256 MiB unless given)
   * throws once its lengths say so, so an untrusted stream never buffers more. Each byte is copied
   * about twice, however the stream splits them.
   *
   * ```ts
   * for await (const patch of Patch.stream((await fetch('/feed')).body!)) view.setData((data = data.apply(patch)));
   * ```
   */
  static async *stream(
    stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    { limit = 1 << 28 }: { limit?: number } = {},
  ): AsyncGenerator<Patch> {
    let buffer = new Uint8Array(1 << 16);
    let [start, end, wanted] = [0, 0, 0];
    // A patch arriving in many chunks is tried again once its bytes double, so trying stays linear.
    const take = function* (): Generator<Patch> {
      while (end > start && end - start >= wanted) {
        const decoded = wasm.Patch.decode(buffer.subarray(start, end), limit) as {
          patch: wasm.Patch;
          used: number;
        } | null;
        if (!decoded) {
          wanted = 2 * (end - start);
          return;
        }
        start += decoded.used;
        wanted = 0;
        yield new Patch(decoded.patch);
      }
    };
    for await (const chunk of chunks(stream)) {
      if (end + chunk.length > buffer.length) {
        const kept = end - start;
        const grown = new Uint8Array(Math.max(buffer.length, 2 * (kept + chunk.length)));
        grown.set(buffer.subarray(start, end));
        [buffer, start, end] = [grown, 0, kept];
      }
      buffer.set(chunk, end);
      end += chunk.length;
      yield* take();
    }
    wanted = 0;
    yield* take();
    if (end > start) throw new Error('the stream ended inside a patch');
  }

  /**
   * The patch its JSON makes: a list of changes, each named by its method with its parameters by
   * name, such as `[{"set": {"table": "Bus", "ids": [1], "fields": {"kv": [345]}}}]`. Slices of
   * binary files, `{file, dtype, offset, count}`, are fetched at once, relative to `base`, the
   * document's own URL.
   */
  static async load(json: string, base = ''): Promise<Patch> {
    return new Patch((await wasm.Patch.load(json, base)) as wasm.Patch);
  }

  /** Names the axis sampled fields are recorded over, such as `('time', 's')`. */
  axis(name: string, unit: string): this {
    return this.#push({ axis: { name, unit } });
  }

  /** Writes `fields` for rows `ids` of `table`: known ids change, others are added. */
  set(table: string, ids: Ids, fields: Record<string, Values | Reference>): this {
    return this.#push({ set: { table, ids: bytes(ids), fields: columns(fields) } });
  }

  /** Replaces `table` with these rows and fields. */
  put(table: string, ids: Ids, fields: Record<string, Values | Reference>): this {
    return this.#push({ put: { table, ids: bytes(ids), fields: columns(fields) } });
  }

  /** Removes the rows of `table` with `ids`. */
  remove(table: string, ids: Ids): this {
    return this.#push({ remove: { table, ids: bytes(ids) } });
  }

  /** Records a frame at each axis coordinate of `at`: values per row of `table`, frame-major. */
  append(at: number | readonly number[], table: string, fields: Record<string, Values>): this {
    return this.#push({ append: { at, table, fields: columns(fields) } });
  }

  /** Forgets every sampled field's frames before axis coordinate `before`. */
  forget(before: number): this {
    return this.#push({ forget: { before } });
  }

  /** Appends a change in the JSON form {@link Patch.load} reads, decoded by the same code. */
  #push(op: object): this {
    this.inner.push([op]);
    return this;
  }

  toBytes(): Uint8Array {
    return this.inner.toBytes();
  }
}

/** The dtype of each typed array a column or ids can be: little endian, as every browser stores them. */
const dtypes = new Map<unknown, string>([
  [Float64Array, 'f64le'],
  [Float32Array, 'f32le'],
  [Int32Array, 'i32le'],
  [Uint32Array, 'u32le'],
  [Uint8Array, 'u8'],
]);

/** Values or ids as decoded: a typed array as `{ dtype, bytes }`, which copies once. */
function bytes<T>(values: T): T | { dtype: string; bytes: Uint8Array } {
  if (!ArrayBuffer.isView(values)) return values;
  const dtype = dtypes.get(values.constructor);
  if (!dtype) throw new TypeError(`${values.constructor.name} is not a column's typed array`);
  return { dtype, bytes: new Uint8Array(values.buffer, values.byteOffset, values.byteLength) };
}

/** Fields as decoded: values as {@link bytes}, a reference's ids too. */
function columns(fields: Record<string, Values | Reference>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    out[name] =
      'reference' in field ? { reference: field.reference, ids: bytes(field.ids) } : bytes(field);
  }
  return out;
}

/** The chunks of a stream, read with a reader where async iteration is missing. */
async function* chunks(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (!('getReader' in stream)) {
    yield* stream;
    return;
  }
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
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

  /**
   * The dataset its JSON document builds, `{"name": ..., "patch": [...]}`: the patch loading as
   * {@link Patch.load} loads one.
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

  /** What the dataset holds: tables, rows, fields and their kinds, the axis and its span. */
  describe(): Description {
    return JSON.parse(this.inner.describe()) as Description;
  }

  /**
   * The rows of a table `query` asks for, in the forms {@link Patch.put} takes, sampled fields read
   * at its coordinate. Runs on the CPU through the expressions marks draw with.
   */
  query(query: Query): Rows {
    return this.inner.query(JSON.stringify(query)) as Rows;
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
    ids?: Ids,
  ): Envelope {
    return this.inner.envelope(
      table,
      field,
      Float64Array.from(range),
      spans,
      bytes(ids),
    ) as Envelope;
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

  /** Requests a WebGPU device. */
  static async create(): Promise<Gpu> {
    return new Gpu(await wasm.Gpu.create());
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

  /** Releases this GPU's canvases, views, and frame listeners. Other GPUs and data handles remain usable. */
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

/** A view's part of a canvas or a picture: `[x, y, width, height]` as fractions of it. */
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
    return JSON.parse(this.inner.selection) as Row[];
  }

  /** Selects `rows`, and no others. Like every setter it tells nothing: `select` events tell what
   * the user and the data changed. */
  select(rows: Row[]): void {
    this.inner.select(JSON.stringify(rows));
  }

  /** What the user points at: the row under the pointer, or the row the keys stepped to. */
  get hovered(): Hit | null {
    return JSON.parse(this.inner.hovered) as Hit | null;
  }

  /** Every mark that draws nothing because its data no longer fits it, and why. */
  get failures(): LatkitError[] {
    return (JSON.parse(this.inner.failures) as Failure[]).map(failure);
  }

  /** Eases to `camera`. */
  fly(camera: Camera): void {
    this.inner.fly(JSON.stringify(camera));
  }

  /** Every row of a mark that picks within `radius` CSS pixels of `point`, nearest first. */
  async pick(point: [number, number], radius: number): Promise<Hit[]> {
    return JSON.parse((await this.inner.pick(Float32Array.from(point), radius)) as string) as Hit[];
  }

  /** Where `row` lies on screen, CSS pixels from the top left, or `null` when no mark draws it in view. */
  locate(row: Row): Promise<[number, number] | null> {
    return this.inner.locate(JSON.stringify(row)) as Promise<[number, number] | null>;
  }

  /** The rows joined to `row`: a vertex's neighbors across edges and nets, or an edge's or a net's vertices. */
  neighbors(row: Row): Row[] {
    return JSON.parse(this.inner.neighbors(JSON.stringify(row))) as Row[];
  }

  /** Frames what `fit` names on the next frame, keeping pitch and bearing. */
  fit(fit: Fit = 'all'): void {
    this.inner.fit(JSON.stringify(fit));
  }

  /**
   * Lays every vertex row without a position out again by the scene's layout: a diagram's blocks, or
   * points on a plane or the earth. Places a layout gave otherwise hold, so rows added later are
   * placed around the rest. Once the layout lands, answers a patch for each dataset writing each row
   * laid out into its mark's position fields; applied, the places are the data's own.
   *
   * ```ts
   * for (const [name, patch] of await view.arrange()) if (name === data.name) data = data.apply(patch);
   * ```
   */
  async arrange(): Promise<[string, Patch][]> {
    const pairs = (await this.inner.arrange()) as [string, wasm.Patch][];
    return pairs.map(([name, patch]) => [name, new Patch(patch)]);
  }

  get stats(): Stats {
    return JSON.parse(this.inner.stats) as Stats;
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
    for (const told of JSON.parse(json) as Told[]) {
      const listeners = this.#listeners.get(told.type) as Set<(event: unknown) => void> | undefined;
      if (!listeners?.size) continue;
      const event = told.type === 'error' ? failure(told.detail) : told.detail;
      for (const listener of listeners) listener(event);
    }
  }

  /** Frees the view; a canvas showing it keeps its last frame. */
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

/** A view's event as it crosses from WASM: its type, and its detail, an error's as plain data. */
type Told = {
  [T in keyof ViewEvents]: { type: T; detail: T extends 'error' ? Failure : ViewEvents[T] };
}[keyof ViewEvents];

/** An error as it crosses from WASM. */
interface Failure {
  code: LatkitError['code'];
  message: string;
  path?: string;
}

/** The error `failure` describes, as latkit throws them. */
function failure({ code, message, path }: Failure): LatkitError {
  return Object.assign(new Error(message), path === undefined ? { code } : { code, path });
}

/**
 * A picture of views, each drawn into its part of `size` pixels at `scale` pixels per CSS pixel:
 * plain data, like a scene. A view a shot draws holds its canvas's last frame meanwhile.
 *
 * ```ts
 * const png = await (await new Shot([3840, 2160]).scale(2).image([view])).encode('png');
 * ```
 */
export class Shot {
  /** @internal */
  constructor(
    readonly size: readonly [number, number],
    /** @internal */
    readonly settings: Readonly<{
      scale: number;
      panels: readonly Panel[];
      transparent: boolean;
      deadline: number;
      elapsed?: number;
    }> = { scale: 1, panels: [], transparent: false, deadline: 30 },
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

  /** The capture deadline in seconds, including readback; rejects on timeout. Defaults to 30. */
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
    const video = new Video(
      gpu.inner.video(this.#config(), fps, options.bitrate),
      output.getWriter(),
      fps,
    );
    options.signal?.addEventListener('abort', () => void video.abort(options.signal?.reason), {
      once: true,
    });
    return video;
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
      throw Object.assign(new Error(`the image could not be written as ${format}`), {
        code: 'invalid',
      });
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
  #aborted: unknown;

  /** @internal */
  constructor(
    inner: wasm.Video,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
    private readonly fps: number,
  ) {
    this.#inner = inner;
  }

  private get inner(): wasm.Video {
    if (!this.#inner)
      throw Object.assign(new Error('this Video was finished or aborted'), {
        code: 'cancelled',
        cause: this.#aborted,
      });
    return this.#inner;
  }

  /** Seconds into the video the next frame shows at. */
  get time(): number {
    return this.#inner?.time ?? 0;
  }

  /** Frames drawn or held so far. */
  get frames(): number {
    return this.#inner?.frames ?? 0;
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

  /**
   * Records `views` frame after frame: before each, `step` moves them to the frame's time, in
   * seconds, and says whether to draw it, waiting first if it needs to; once it says no, the video
   * is finished. `onProgress` hears the frames written and the time reached after each.
   */
  async record(
    views: readonly View[],
    step: (time: number) => boolean | Promise<boolean>,
    onProgress?: (progress: { frames: number; time: number }) => void,
  ): Promise<void> {
    while (await step(this.frames / this.fps)) {
      await this.frame(views);
      onProgress?.({ frames: this.frames, time: this.time });
    }
    await this.finish();
  }

  /** Encodes every frame under way, writes the end of the file, closes the output, and gives the views back. */
  async finish(): Promise<void> {
    const bytes = (await this.inner.finish()) as Uint8Array;
    this.#inner?.free();
    this.#inner = undefined;
    if (bytes.length) await this.writer.write(bytes);
    await this.writer.close();
  }

  /** Stops the video: drops what was not written, aborts the output, and gives the views back. */
  async abort(reason?: unknown): Promise<void> {
    if (!this.#inner) return;
    this.#aborted = reason;
    this.#inner.free();
    this.#inner = undefined;
    await this.writer.abort(reason).catch(() => {});
  }
}

/**
 * A CSS gradient through `map`, a catalog name or colors of your own, for legends: the colors the
 * GPU draws, a band each for a categorical map's categories.
 */
export function colormapCss(map: Colormap, direction = 'to right'): string {
  return wasm.colormapCss(map, direction);
}
