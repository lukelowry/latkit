# JavaScript API

Generated from the shipped declarations. `loadLatkit()` returns `Data`, `Gpu`, `Shot`, and
`colormapCss`; builders and patches need no WebAssembly. Options take the [scene and result
types](types.md).

## Loading

Load the runtime once a page.

### loadLatkit

```ts
/**
 * Loads the runtime once per page. Concurrent calls share one promise; a failed load can be retried.
 * Options explicitly supplied after the first call must match that call. Importing the package alone
 * neither initializes WASM nor requests a GPU or worker; loading asks for the page's GPU adapter
 * while the WASM compiles.
 */
function loadLatkit(options?: LoadOptions): Promise<Latkit>;
```

### LoadOptions

```ts
/** Options for the page's shared WASM runtime. Omitted options reuse its existing configuration. */
interface LoadOptions {
  /** The matching package's WASM asset, or an already compiled module. Defaults to the bundled asset. */
  wasm?: string | URL | WebAssembly.Module;
  /** Creates a worker running the standalone `latkit/worker` bundle. Defaults to the bundled worker. */
  createWorker?: () => Worker;
}
```

### Latkit

```ts
/**
 * The initialized data and rendering API. In a browser the page's first GPU is made as the runtime
 * loads, and the first `Gpu.create()` takes it; later calls request devices of their own.
 */
interface Latkit {
  Data: typeof import('./runtime.js').Data;
  Gpu: typeof import('./runtime.js').Gpu;
  Shot: typeof import('./runtime.js').Shot;
  colormapCss: typeof import('./runtime.js').colormapCss;
}
```

### LatkitError

```ts
/**
 * What latkit throws: an `Error` with a `code`, and for invalid input the `path` to the part, such
 * as `marks[2].vertices.color`.
 */
interface LatkitError extends Error {
  code: Failure['code'];
  path?: string;
}
```

## Data and patches

Datasets of named tables, changed by patches written without WebAssembly.

### Data

```ts
/**
 * A named collection of tables, changed in place by patches. A snapshot keeps a version, sharing
 * every page with it, so keeping earlier versions, as an undo history does, costs only the pages
 * they hold apart. A view draws the version it was given until it is given another.
 */
class Data {
  constructor(name: string);
  /** Releases this handle. Views and snapshots keep the versions they hold. */
  destroy(): void;
  [Symbol.dispose](): void;
  /**
   * The dataset `bytes` hold: latkit's bytes, renamed `name` when given, or GeoJSON, gzip-compressed
   * or not, read in a worker as dataset `name`: points, line strings, and polygons as tables
   * `points`, `lines`, and `polygons`, each with its geometry as field `geometry` and its properties
   * as fields.
   */
  static read(bytes: Uint8Array, name?: string): Promise<Data>;
  /**
   * The dataset its JSON document builds, `{"name": ..., "patch": [...]}`, the patch loading as
   * `Patch.load` loads one.
   */
  static load(json: string, base?: string): Promise<Data>;
  get name(): string;
  /** The names of the tables. */
  get tables(): string[];
  /** Every row's id of `table`, in row order. */
  ids(table: string): Id[];
  /** The names of `table`'s fields. */
  fields(table: string): string[];
  /** The first and last axis coordinates the sampled fields span. */
  get span(): [number, number] | undefined;
  /** Applies every change of `patch`, or none when one is invalid. */
  apply(patch: Patch | Uint8Array): this;
  /** This version, kept while `apply` changes this one: O(1). */
  snapshot(): Data;
  /** The value of `field` for the row with `id` in `table`, at axis coordinate `at` when given. */
  get(table: string, id: Id, field: string, at?: number): Value;
  /** What the dataset holds: tables, rows, fields and their kinds, the axis and its span. */
  describe(): Description;
  /**
   * The rows of a table `query` keeps, filtered, sorted, and paged, sampled fields read at its
   * coordinate, on the CPU through the expressions marks draw with.
   */
  query(query: Query): Table;
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
  ): Envelope;
  /** The dataset as latkit's bytes: the patch that builds it. */
  toBytes(): Uint8Array;
}
```

### Table

```ts
/**
 * The rows a query keeps, in the forms a patch writes: numbers as a `Float64Array` (missing NaN),
 * other values as arrays (missing `null`), a reference as its target ids.
 */
interface Table {
  table: string;
  ids: Id[];
  fields: Record<
    string,
    | Float64Array
    | Value[]
    | {
        reference: string;
        ids: (Id | null)[];
      }
  >;
  /** The rows the query kept before paging. */
  total: number;
}
```

### Envelope

```ts
/** Rows' least and greatest values over spans of the axis: `at` holds one more edge than spans. */
interface Envelope {
  at: Float64Array;
  least: Float32Array;
  greatest: Float32Array;
}
```

### Patch

````ts
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
class Patch {
  /** The dataset the patch changes, when it names one; `Data.apply` refuses it for another. */
  readonly data: string | undefined;
  /** An empty patch, for whichever dataset it is applied to. */
  constructor(data?: string);
  /** An empty patch to dataset `data`. */
  static to(data: string): Patch;
  /** The patch `bytes` hold: one frame, as `toBytes` or a stream writes it. */
  static fromBytes(bytes: Uint8Array): Patch;
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
  static stream(
    stream: ReadableBytes | AsyncIterable<Uint8Array>,
    {
      limit,
    }?: {
      limit?: number;
    },
  ): AsyncGenerator<Patch>;
  /**
   * The patch its JSON makes: a list of changes, each named by its method with its parameters by
   * name, such as `{"set": {"table": "Bus", "ids": [1], "fields": {"kv": [345]}}}`. Slices of
   * binary files, `{file, dtype, offset, count}`, are fetched at once relative to `base`, the
   * document's own URL. Reading JSON takes latkit's WebAssembly, which this loads as
   * `loadLatkit()` does.
   */
  static load(json: string, base?: string): Promise<Patch>;
  /** Names the axis sampled fields are recorded over, such as `('time', 's')`. */
  axis(name: string, unit: string): this;
  /** Replaces table `table` with these rows and fields, or adds it. */
  replace(table: string, ids: RowIds, fields?: Fields): this;
  /**
   * Writes `fields` for rows `ids` of `table`: rows with known ids change, others are added, and
   * fields left out keep their values. Adds the table when there is none of its name.
   */
  set(table: string, ids: RowIds, fields?: Fields): this;
  /** Removes the rows of `table` with `ids`. */
  remove(table: string, ids: RowIds): this;
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
  ): this;
  /** Forgets every sampled field's frames before axis coordinate `before`. */
  forget(before: number): this;
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
    {
      level,
      first,
    }: {
      level?: number;
      first: number;
    },
    at: Float64Array | readonly number[],
    values: Float32Array | readonly number[],
  ): this;
  /** Appends `next`'s changes, to this patch's dataset. */
  extend(next: Patch): this;
  /** The patch as bytes: one frame, naming its dataset when it has one. */
  toBytes(): Uint8Array;
}
````

### RowIds

```ts
/** Row ids as a patch takes them: listed, `{ count }` for rows `0..count`, or a typed array. */
type RowIds = Ids | readonly (Id | null)[] | Uint32Array | Float64Array;
```

### Values

```ts
/**
 * One field's values, a value per row; `null` is missing. Typed arrays copy at once: numbers, or
 * in a `Uint8Array` booleans, nonzero true. Booleans, texts, and geometries also as arrays.
 */
type Values =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Uint8Array
  | readonly (number | null)[]
  | readonly (boolean | null)[]
  | readonly (string | null)[]
  | readonly (Geometry | null)[];
```

### Geometry

```ts
/** A point `[x, y]`, or a list of geometries one level shallower: a path, its parts, or polygons. */
type Geometry = readonly number[] | readonly Geometry[];
```

### Reference

```ts
/** A field naming rows of another table by id: `null` leaves a row unwired. */
interface Reference {
  reference: string;
  ids: RowIds;
}
```

### reference

```ts
/** Values of a field naming rows of `table` by id. */
function reference(table: string, ids: RowIds): Reference;
```

### Fields

```ts
/** A table's fields by name. */
type Fields = Readonly<Record<string, Values | Reference>>;
```

### ReadableBytes

```ts
/** A byte stream, structurally compatible with the browser and Node ReadableStream. */
interface ReadableBytes {
  getReader(): {
    read(): Promise<{
      done: boolean;
      value?: Uint8Array;
    }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}
```

## Expressions

What varies by row: builders writing the expressions scenes take.

### Expr

```ts
/** A value for every row of a mark: a constant, a field, view state, or arithmetic of them. */
class Expr {
  readonly node: ExprNode;
  /** An expression from its JSON form; use the builders for common operations. */
  constructor(node: ExprNode);
  toJSON(): ExprNode;
  /** Reads this expression's fields from `table` of dataset `data`, joined by row id. */
  of(data: string, table: string): Expr;
  /** Reads sampled fields at their last frame without interpolating. */
  step(): Expr;
  add(other: ExprInput): Expr;
  sub(other: ExprInput): Expr;
  mul(other: ExprInput): Expr;
  div(other: ExprInput): Expr;
  rem(other: ExprInput): Expr;
  pow(other: ExprInput): Expr;
  min(other: ExprInput): Expr;
  max(other: ExprInput): Expr;
  clamp(low: ExprInput, high: ExprInput): Expr;
  lt(other: ExprInput): Expr;
  le(other: ExprInput): Expr;
  gt(other: ExprInput): Expr;
  ge(other: ExprInput): Expr;
  eq(other: ExprInput): Expr;
  ne(other: ExprInput): Expr;
  and(other: ExprInput): Expr;
  or(other: ExprInput): Expr;
  not(): Expr;
  neg(): Expr;
  abs(): Expr;
  sqrt(): Expr;
  sin(): Expr;
  cos(): Expr;
  floor(): Expr;
  ln(): Expr;
  exp(): Expr;
  /** Whether a text field equals `text`. */
  is(text: string): Expr;
  /** Whether a text field holds `text`, ignoring case. Queries read it; marks do not. */
  contains(text: string): Expr;
  /** The value through `map`: a catalog name, or your own colors. */
  colormap(map: Colormap): Mapped;
  /** The value mapped linearly onto `[low, high]`, clamped. */
  scale(low: number, high: number): Mapped;
}
```

### ExprInput

```ts
/** What an expression is written as: an {@link Expr}, or its JSON form. */
type ExprInput = Expr | ExprNode;
```

### Color

```ts
/** A CSS color, such as `'#ffb000'` or `'rebeccapurple'`. Where an option takes an expression, a
 * string starting with `#` is a hex color and any other string names a field. */
type Color = string;
```

### field

```ts
/** The field `name` of each row. */
const field: (name: string) => Expr;
```

### color

```ts
/** A color constant. */
const color: (css: Color) => Expr;
```

### missing

```ts
/** A missing value: options that read one take the theme's. */
const missing: () => Expr;
```

### when

```ts
/** Starts a conditional: `when(c).then(a).when(d).then(b).otherwise(e)`. */
function when(condition: ExprInput): When;
```

### When

```ts
declare class When {
  constructor(cases: [ExprNode, ExprNode][], condition: ExprNode);
  then(value: ExprInput): Then;
}
```

### Then

```ts
declare class Then {
  constructor(cases: [ExprNode, ExprNode][]);
  when(condition: ExprInput): When;
  otherwise(value: ExprInput): Expr;
}
```

### Mapped

```ts
/** A value through a colormap or onto a range, whose domain can be set. */
class Mapped extends Expr {
  /** The input values that map to the ends; it fits the values shown unless set. */
  domain(low: number, high: number): Mapped;
}
```

### units

```ts
/**
 * A size in position units, so it scales as the view zooms, kept within `atLeast` and `atMost` CSS
 * pixels when given: `units('r', { atLeast: 2 })` grows with the map and never vanishes. A marker
 * keeps its proportions, its larger side held.
 */
const units: (
  size: ExprInput,
  px?: {
    atLeast?: number;
    atMost?: number;
  },
) => Size;
```

### selected

```ts
/** Whether the row is selected. */
const selected: () => Expr;
```

### hovered

```ts
/** Whether the pointer is over the row. */
const hovered: () => Expr;
```

### pointer

```ts
/** CSS pixels from a vertex to the pointer. */
const pointer: () => Expr;
```

### zoom

```ts
/** The camera's zoom: the web mercator level on the earth, log₂ CSS pixels per unit elsewhere. */
const zoom: () => Expr;
```

### elapsed

```ts
/** Seconds since the view was created. */
const elapsed: () => Expr;
```

### icon

```ts
/** An icon marker showing one of `images` for each row, picked by `index`. */
function icon(images: readonly RgbaImage[], index: ExprInput): Marker;
```

### RgbaImage

```ts
/** Straight-alpha RGBA pixels, compatible with browser ImageData and server-produced pixels. */
interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
```

### colormapCss

```ts
/**
 * A CSS gradient through `map`, a catalog name or colors of your own, for legends: the colors the
 * GPU draws, a band each for a categorical map's categories.
 */
function colormapCss(map: Colormap, direction?: string): string;
```

## Views

A GPU makes views, and canvases that show them.

### Gpu

```ts
/** The GPU device views draw with. Views of one GPU draw in one animation frame. */
class Gpu {
  /** Requests a WebGPU device: the first call takes the one made as latkit loaded. */
  static create(): Promise<Gpu>;
  /**
   * A view of `scene`; its marks draw once {@link View.setData} gives their data. A {@link Canvas}
   * shows it, and a {@link Shot} draws it with or without one.
   */
  view(scene: Scene): View;
  /**
   * A canvas showing views in `panels` of `target`: a `<canvas>` element, which sizes itself to its
   * CSS box and passes each view the input landing on its panel, or an `OffscreenCanvas` in a
   * worker, which keeps the size it is given at `pixelRatio` pixels a CSS pixel. Panels are
   * `[x, y, width, height]` fractions, one per view; by default one view fills the canvas.
   */
  canvas(
    target: HTMLCanvasElement | OffscreenCanvas,
    options?: {
      panels?: readonly Panel[];
      pixelRatio?: number;
    },
  ): Canvas;
  /**
   * Calls `listener` with the frame's timestamp every animation frame, before the views draw, so
   * what it changes shows in that frame. Returns a function that stops it.
   */
  on(type: 'frame', listener: (now: number) => void): () => void;
  /** Whether the device was lost; a new `Gpu` is needed. */
  get lost(): boolean;
  /** How much GPU memory data takes. */
  get budget(): Budget;
  set budget(budget: Budget);
  /** What this GPU did since it was created, counted exactly; see {@link Work}. */
  get work(): Work;
  /**
   * Draws one frame now at `now`, milliseconds on the clock animation frames give: the frame
   * listeners, then every canvas that needs a frame. From the first step no animation frames are
   * asked for: a harness, as tests and benchmarks are, steps every frame itself, so a run draws the
   * same frames however fast the device is.
   */
  step(now: number): void;
  /**
   * Resolves once the GPU finished the work submitted to it, every readback landed, and every
   * pipeline a view or shot asked for compiled: a frame stepped then draws all of it. A `timeout`
   * error after `deadline` seconds.
   */
  done({ deadline: seconds }?: { deadline?: number | undefined }): Promise<void>;
  /**
   * Resolves when work a view waits on lands after this call (a readback, a compile, a job, a text,
   * a fetch), or a view asks for a frame. A `timeout` error after `deadline` seconds.
   */
  landed({ deadline: seconds }?: { deadline?: number | undefined }): Promise<void>;
  /** Releases this GPU's canvases, views, and frame listeners. Other GPUs and data stay usable. */
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### View

````ts
/** A scene drawn from data it is given by name: shown by a canvas, which passes it input, or drawn by shots. */
class View {
  /** Draws `scene` instead; an invalid scene throws and changes nothing. */
  show(scene: Scene): void;
  /**
   * Gives the view `data` as it is now, replacing the dataset of its name: give it again after
   * applying patches. A mark it no longer fits draws nothing, and the next frame reports why as an
   * error, unless a scene shown before then replaces the mark.
   */
  setData(data: Data): void;
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
  setTiles(name: string, url: string): void;
  /** Stops drawing the dataset named `name`, given or fetched as tiles. */
  removeData(name: string): void;
  /** The dataset named `name`, as given or as the view fetched it, as a snapshot. */
  data(name: string): Data | undefined;
  /** The axis coordinate shown: sampled fields read their last frame at or before it. */
  get at(): number;
  set at(at: number);
  get camera(): Camera;
  set camera(camera: Camera);
  /** Eases to `camera`. */
  fly(camera: Camera): void;
  /** Frames what `fit` names on the next frame, keeping pitch and bearing. */
  fit(fit?: Fit): void;
  /** Where `position` (x, y, elevation) lands on screen, CSS pixels from the top left. */
  point(position: [number, number, number]): [number, number] | undefined;
  /** The position on the ground under screen point `point`, if the view shows ground there. */
  ground(point: [number, number]): [number, number, number] | undefined;
  /** CSS pixels kept clear at the top, right, bottom, and left, as when panels cover the view. */
  get insets(): [number, number, number, number];
  set insets(insets: [number, number, number, number]);
  /** Degrees per second a map or plane turns around its center; 0 stops it. A diagram never turns. */
  get orbit(): number;
  set orbit(degreesPerSecond: number);
  /** The rows selected, a set per table. */
  get selection(): Rows[];
  /**
   * Selects `rows`, and no others. Like every setter it tells nothing: `select` events tell what
   * the user and the data changed.
   */
  select(rows: readonly Rows[]): void;
  /** What the user points at: the row under the pointer, or the row the keys stepped to. */
  get hovered(): Hit | null;
  /** Every mark that draws nothing because its data no longer fits it, and why. */
  get failures(): LatkitError[];
  /**
   * Every row of a mark that picks within `radius` CSS pixels of `point`, nearest first, once a frame
   * draws the view: a `timeout` error after `deadline` seconds without one.
   */
  pick(
    point: [number, number],
    radius: number,
    {
      deadline: seconds,
    }?: {
      deadline?: number | undefined;
    },
  ): Promise<Hit[]>;
  /**
   * Where `row` lies on screen, CSS pixels from the top left, or `null` when no mark draws it in
   * view, once a frame draws the view: a `timeout` error after `deadline` seconds without one.
   */
  locate(
    row: Row,
    {
      deadline: seconds,
    }?: {
      deadline?: number | undefined;
    },
  ): Promise<[number, number] | null>;
  /** The rows joined to `row`, a set per table: a vertex's neighbors across edges and nets, or an
   * edge's or a net's vertices. */
  neighbors(row: Row): Rows[];
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
  arrange({ deadline: seconds }?: { deadline?: number | undefined }): Promise<Patch[]>;
  get stats(): Stats;
  /** Whether the view wants a frame: it changed, or work it waited on landed. */
  get wantsFrame(): boolean;
  /**
   * Calls `listener` with each event of `type` told while it listens; returns a function that
   * stops it. What lasts is state to read: `hovered`, `selection`, `camera`, `stats.waiting`, and
   * `failures`.
   */
  on<T extends keyof ViewEvents>(type: T, listener: (event: ViewEvents[T]) => void): () => void;
  /** Frees the view, and rejects what it was asked and has not answered; a canvas showing it keeps
   * its last frame. */
  destroy(): void;
  [Symbol.dispose](): void;
}
````

### ViewEvents

```ts
/**
 * What a view tells its listeners, by type. Intents (`click`, `open`, `menu`, `drag`, `connect`,
 * `delete`) are told once each, in the order the user acted. Changes (`hover`, `select`, `camera`,
 * `waiting`) tell only their latest, and their state can always be read. A view tells only what the
 * application did not do itself: its setters change state silently.
 */
type ViewEvents = {
  [E in ViewEvent as E['type']]: E extends {
    type: 'error';
  }
    ? LatkitError
    : E['detail'];
};
```

### Canvas

```ts
/** Views shown in the panels of a `<canvas>` or an `OffscreenCanvas`. */
class Canvas {
  /** Shows `views`, one per panel, in place of those it showed. A view shows in one canvas at a time. */
  show(views: readonly View[]): this;
  /** Stops drawing; the views remain, and the element keeps its last frame. */
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### Panel

```ts
/** A view's panel of a canvas or a picture: `[x, y, width, height]` as fractions of it. */
type Panel = readonly [number, number, number, number];
```

## Pictures and video

Shots draw views into images and video.

### Shot

````ts
/**
 * A picture of views, each drawn into its panel of `size` pixels at `scale` pixels per CSS pixel:
 * plain data, like a scene. A view a shot draws holds its canvas's last frame meanwhile.
 *
 * ```ts
 * const png = await (await new Shot([3840, 2160]).scale(2).image([view])).encode('png');
 * ```
 */
class Shot {
  readonly size: readonly [number, number];
  /** A picture with width and height in pixels. */
  constructor(size: readonly [number, number]);
  /** Draws `scale` pixels per CSS pixel: a view lays out `size / scale` CSS pixels. */
  scale(scale: number): Shot;
  /** Where each view draws, `[x, y, width, height]` as fractions, one per view in order; by default one fills it. */
  panels(panels: readonly Panel[]): Shot;
  /** Keeps the picture's alpha: views clear to transparent where their themes' backgrounds are. */
  transparent(): Shot;
  /** The shot's deadline in seconds, including readback; rejects on timeout. Defaults to 30. */
  deadline(seconds: number): Shot;
  /** Fixes elapsed-time expressions and drawing effects at `seconds` while transitions settle. */
  elapsed(seconds: number): Shot;
  /** The picture of `views`, one per panel, once every one is complete and still. */
  image(views: readonly View[]): Promise<Image>;
  /**
   * A video of these pictures at `fps` frames a second, H.264 in MP4, written to `output` as it is
   * drawn, at `bitrate` bits a second or about 0.15 bits a pixel a frame. Width and height are
   * multiples of 4 and 2. `signal` aborts it: the output is aborted and the views are given back.
   */
  video(
    gpu: Gpu,
    fps: number,
    output: WritableStream<Uint8Array>,
    options?: {
      bitrate?: number;
      signal?: AbortSignal;
    },
  ): Video;
}
````

### Image

```ts
/** RGBA pixels, straight alpha, rows top to bottom. */
class Image {
  get width(): number;
  get height(): number;
  /** The pixels, copied. */
  get rgba(): Uint8Array;
  /**
   * The image as a file, written in a worker: PNG, lossless with alpha; JPEG at `quality` from 1 to
   * 100 (90 by default), small, its alpha dropped; or WebP, lossless with alpha, smaller than PNG.
   */
  encode(
    format: ImageFormat,
    options?: {
      quality?: number;
    },
  ): Promise<Uint8Array>;
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### ImageFormat

```ts
/** How an image is written as a file. */
type ImageFormat = 'png' | 'jpeg' | 'webp';
```

### Video

```ts
/** A video being drawn, encoded, and written. */
class Video {
  /** Seconds into the video the next frame shows at; retained after completion. */
  get time(): number;
  /** Frames drawn or held so far; retained after completion. */
  get frames(): number;
  /** Draws and writes one frame, waiting for output backpressure. Only one frame may run at a time. */
  frame(views: readonly View[]): Promise<void>;
  /** Records until `step(time)` returns false; any step, drawing, output, or progress error aborts it. */
  record(
    views: readonly View[],
    step: (time: number) => boolean | Promise<boolean>,
    onProgress?: (progress: { frames: number; time: number }) => void,
  ): Promise<void>;
  /** Finishes pending work, writes the end of the file, and closes and unlocks the output. Idempotent. */
  finish(): Promise<void>;
  /** Cancels drawing and encoding, aborts the output, and unlocks it after pending writes settle. Idempotent. */
  abort(reason?: unknown): Promise<void>;
}
```
