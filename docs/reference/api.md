# JavaScript API

Generated from the shipped declarations. `load()` loads the WebAssembly that datasets, views,
and pictures are made with; scenes, expressions, and patches need none. Options take the [scene
and result types](types.md).

## Loading and waiting

Load the WebAssembly once a page; every wait ends at its signal.

### load

```ts
/**
 * Loads latkit's WebAssembly once a page: data, views, and pictures can be made once it resolves.
 * Concurrent calls share one load, and a failed one can be tried again; options given after the first
 * call must match it. Importing the package neither loads WebAssembly nor asks for a GPU; loading asks
 * for the page's GPU adapter while the WebAssembly compiles. `Gpu.create`, `Data.read`, and
 * `Patch.read` load it themselves.
 */
function load(options?: LoadOptions): Promise<void>;
```

### LoadOptions

```ts
/** Loading latkit's WebAssembly: once a page, before data, views, and pictures can be made. */
/** How latkit loads. Options left out keep what loading began with. */
interface LoadOptions {
  /** The matching package's WASM asset, or an already compiled module. Defaults to the bundled asset. */
  wasm?: string | URL | WebAssembly.Module;
  /** Makes a worker running the standalone `latkit/worker` bundle. Defaults to the bundled worker. */
  worker?: () => Worker;
}
```

### Wait

```ts
/** How long a promise may wait: until `signal` aborts, by default 30 seconds. */
interface Wait {
  signal?: AbortSignal;
}
```

### LatkitError

```ts
/**
 * What latkit throws: an `Error` with a `code`, and for invalid input the `path` to the part, such
 * as `marks[2].vertices.color`. `unloaded` is a call made before `await load()`.
 */
interface LatkitError extends Error {
  code: Failure['code'] | 'unloaded';
  path?: string;
}
```

## Data and patches

Datasets of named tables, changed by patches written without WebAssembly, and what views draw them from.

### Data

````ts
/**
 * A dataset that changes in place: named tables of columns, changed only by patches, every change
 * of one or none. A view given it draws its latest version, from the frame after a patch applies. A
 * snapshot keeps one version, sharing every page with it, so earlier versions kept, as an undo
 * history does, cost only the pages they hold apart.
 *
 * ```ts
 * const grid = new Data('grid').apply(new Patch().replace('Bus', [1, 2], { kv: [230, 115] }));
 * view.sources = [grid];
 * grid.apply(new Patch().set('Bus', [2], { kv: [69] })); // drawn next frame
 * ```
 */
class Data {
  /** An empty dataset named `name`. */
  constructor(name: string);
  /**
   * The dataset `source` holds, as its first bytes say: latkit's bytes; GeoJSON, gzip-compressed or
   * not, read in a worker, its points, line strings, and polygons rows of tables `points`, `lines`,
   * and `polygons`, each with its geometry as field `geometry` and its properties as fields; or its
   * JSON document, `{"name": ..., "patch": [...]}`, its patch read as `Patch.read` reads one. `source`
   * is bytes, a `Blob`, a `Response`, a stream, a URL to fetch, or a document as a JSON value. `name`
   * names it, as GeoJSON needs; `base` is what a document's slices of files are relative to, by
   * default the URL it was fetched from.
   */
  static read(
    source: DataSource,
    options?: {
      name?: string;
      base?: string;
    } & Wait,
  ): Promise<Data>;
  get name(): string;
  /** Applies every change of `patch`, or none when one is invalid. */
  apply(patch: Patch | Uint8Array): this;
  /** The version it holds now, kept as it is while patches change it: O(1). */
  snapshot(): Snapshot;
  /** Makes `snapshot`, a version of this dataset, the one it holds: what an undo does. */
  restore(snapshot: Snapshot): this;
  /** What it holds now: see {@link Snapshot.describe}. */
  describe(): Description;
  /** A value it holds now: see {@link Snapshot.get}. */
  get(
    table: string,
    id: Id,
    field: string,
    options?: {
      at?: number;
    },
  ): Value;
  /** The rows a query keeps of what it holds now: see {@link Snapshot.query}. */
  query(query: Query): QueryResult;
  /** Rows' extremes over spans of what it holds now: see {@link Snapshot.envelope}. */
  envelope(request: EnvelopeRequest): Envelope;
  /** What it holds now as latkit's bytes: the patch that builds it. */
  toBytes(): Uint8Array;
  /** Frees this handle; views drawing the dataset and its snapshots keep it. */
  destroy(): void;
  [Symbol.dispose](): void;
}
````

### Snapshot

```ts
/** One version of a dataset, as it was when taken: O(1) to keep. A view given one draws it as it is. */
class Snapshot {
  get name(): string;
  /** What the dataset holds: tables, rows, fields and their kinds, the axis and its span. */
  describe(): Description;
  /** The value of `field` for the row with `id` in `table`, at axis coordinate `at` when given. */
  get(
    table: string,
    id: Id,
    field: string,
    options?: {
      at?: number;
    },
  ): Value;
  /**
   * The rows of a table `query` keeps, filtered, sorted, and paged, sampled fields read at its
   * coordinate, on the CPU through the expressions marks draw with.
   */
  query(query: Query): QueryResult;
  /**
   * Each row's least and greatest value of a sampled field over equal spans of a range, of every row
   * or of the rows named: row after row, NaN where a span holds no frame. It reads the coarsest
   * levels of detail that fit, so a span costs a few reads however many frames it covers.
   */
  envelope(request: EnvelopeRequest): Envelope;
  /** The version as latkit's bytes: the patch that builds it. */
  toBytes(): Uint8Array;
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### Tiles

```ts
/**
 * A dataset fetched in pieces as views ask for them: plain data naming where they lie. Each view
 * draws the pieces its camera and plot window ask for as a dataset of its own, and every view of a
 * GPU shares what is fetched. The source's first bytes say what it holds.
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
class Tiles {
  readonly name: string;
  readonly url: string;
  /** The tiles at `url`, drawn as dataset `name`. */
  constructor(name: string, url: string);
}
```

### Source

```ts
/** What a view draws a dataset from, by its name. */
type Source = Data | Snapshot | Tiles;
```

### DataSource

```ts
/** What `Data.read` reads: latkit's bytes, GeoJSON, or a dataset's JSON document. */
type DataSource =
  Uint8Array | ArrayBuffer | Blob | Response | ReadableStream<Uint8Array> | string | object;
```

### QueryResult

```ts
/**
 * The rows a query keeps, in the forms a patch writes: numbers as a `Float64Array` (missing NaN),
 * other values as arrays (missing `null`), a reference as its target's ids.
 */
interface QueryResult {
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
 * const patch = new Patch('grid')
 *   .replace('Bus', [101, 102], { x: Float64Array.of(0, 10), name: ['North', 'South'] })
 *   .append('Bus', 0.5, { vm: Float32Array.of(1.01, 0.99) });
 * ```
 */
class Patch {
  /** An empty patch: to dataset `data`, which it names, or to whichever it is applied to. */
  constructor(data?: string);
  /** The dataset the patch changes, when it names one; `Data.apply` refuses it for another. */
  get data(): string | undefined;
  /**
   * The patch `source` holds: latkit's bytes, one frame as `toBytes` writes it, or its JSON, what
   * any language writes without latkit: a list of changes, each named by its method with its
   * parameters by name, such as `{"set": {"table": "Bus", "ids": [1], "fields": {"kv": [345]}}}`.
   * Slices of binary files, `{file, dtype, offset, count}`, are fetched at once relative to `base`,
   * by default the URL the JSON was fetched from. `source` is bytes, a `Blob`, a `Response`, a URL
   * to fetch, or the JSON as a value. Bytes read without WebAssembly; JSON loads it, as `load()`
   * does. A frame longer than `limit` bytes (256 MiB unless given) is refused.
   */
  static read(
    source: PatchSource,
    options?: {
      base?: string;
      limit?: number;
    } & Wait,
  ): Promise<Patch>;
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
   * Records a frame of `table` at each axis coordinate of `at`: for each field, a value per row at
   * every coordinate, frame-major; of every row, or of rows `ids`, the rest holding their last
   * values. A field's first frame makes it sampled. Appends of float arrays to the same fields of
   * every row, one after another, write as one change, so a frame a call costs no more than one call.
   */
  append(
    table: string,
    at: number | readonly number[],
    fields: Readonly<Record<string, Values>>,
    {
      ids,
    }?: {
      ids?: RowIds;
    },
  ): this;
  /** Forgets every sampled field's frames before axis coordinate `before`. */
  forget(before: number): this;
  /**
   * Holds a run of sampled field `field`'s entries of level `level` (0 unless given), numbered from
   * `first`: what a time tile holds, as `latkit tile` writes them. At level 0 the entries are frames,
   * each a coordinate in `at` and a value per row of `table` in `values`. At level `k` they are
   * buckets of `8^k` frames, each its first and last frame's coordinates in `at`, and in `values`
   * each row's least value over each bucket, then each row's greatest. NaN is missing. No entry may
   * be held already; frames past the field's widen it.
   */
  frames(
    table: string,
    field: string,
    {
      level,
      first,
      at,
      values,
    }: {
      level?: number;
      first: number;
      at: Float64Array | readonly number[];
      values: Float32Array | readonly number[];
    },
  ): this;
  /** Appends `next`'s changes, to this patch's dataset. */
  extend(next: Patch): this;
  /** The patch as bytes: one frame, naming its dataset when it has one. */
  toBytes(): Uint8Array;
}
````

### PatchSource

```ts
/** What `Patch.read` reads: latkit's bytes or a patch's JSON. */
type PatchSource = Uint8Array | ArrayBuffer | Blob | Response | string | object;
```

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

What varies by row: builders writing the expressions and colors scenes take.

### Expr

```ts
/** A value for every row of a mark: a constant, a field, view state, or arithmetic of them. */
class Expr {
  readonly node: ExprNode;
  /** An expression from its JSON form; use the builders for common operations. */
  constructor(node: ExprNode);
  toJSON(): ExprNode;
  /** Reads this expression's fields from `table` of dataset `data`, joined by row id. */
  from(data: string, table: string): Expr;
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
  /** Whether a text field holds `text`, ignoring case: in a mark, a field of its own table. */
  contains(text: string): Expr;
  /** The value through `map`, a color for every row: a catalog name, or your own colors. */
  colormap(map: Colormap): Colormapped;
  /** The value mapped linearly onto `[low, high]`, clamped. */
  scale(low: number, high: number): Mapped;
}
```

### ExprInput

```ts
/** What a value is written as: an {@link Expr}, or its JSON form, in which a string names a field. */
type ExprInput = Expr | ExprNode;
```

### Mapped

```ts
/** A value mapped onto a range, whose domain can be set. */
class Mapped extends Expr {
  /** The input values that map to the ends; it fits the values shown unless set. */
  domain(low: number, high: number): Mapped;
}
```

### Missing

```ts
/** A missing value, which options take the theme's for: a value and a color alike. */
class Missing extends Expr {
  readonly node: MissingNode;
  constructor();
  toJSON(): MissingNode;
}
```

### Paint

```ts
/**
 * A color for every row of a mark: a CSS color, a value through a colormap, or a conditional choosing
 * between colors. Color options take one, or a CSS color as it is.
 */
class Paint {
  readonly node: PaintNode;
  /** A color from its JSON form; use the builders for common colors. */
  constructor(node: PaintNode);
  toJSON(): PaintNode;
}
```

### PaintInput

```ts
/**
 * What a color is written as: a CSS color, a {@link Paint}, or its JSON form. A string is a CSS
 * color here; a field reads with {@link field}.
 */
type PaintInput = Color | Paint | PaintNode;
```

### Colormapped

```ts
/** A value through a colormap, whose domain can be set. */
class Colormapped extends Paint {
  /** The input values that map to the ends; it fits the values shown unless set. */
  domain(low: number, high: number): Colormapped;
}
```

### Color

```ts
/** A CSS color, such as `'#ffb000'` or `'rebeccapurple'`: what a string is in a color option. */
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
const color: (css: Color) => Paint;
```

### missing

```ts
/** A missing value: options that read one take the theme's. */
const missing: () => Missing;
```

### when

```ts
/**
 * Starts a conditional: `when(c).then(a).when(d).then(b).otherwise(e)`. Its values are colors, a
 * string a CSS color, where its first is one; else values.
 */
function when(condition: ExprInput): When;
```

### When

```ts
/** A conditional's first case, waiting for its value where the condition holds. */
class When {
  /** The color where the condition holds: every value of the conditional is a color. */
  then(value: PaintInput): Then<Paint>;
  /** The value where the condition holds. */
  then(value: ExprInput): Then<Expr>;
}
```

### Then

```ts
/** A conditional's cases so far, waiting for another or the value where none holds. */
class Then<T extends Expr | Paint> {
  /** Another case, tried when those before it do not hold. */
  when(condition: ExprInput): Next<T>;
  /** The value where no case holds. */
  otherwise(value: InputOf<T>): T;
}
```

### Next

```ts
/** A conditional's next case, waiting for its value where the condition holds. */
class Next<T extends Expr | Paint> {
  /** The value where the condition holds. */
  then(value: InputOf<T>): Then<T>;
}
```

### InputOf

```ts
/** What a conditional's values are written as, a value's or a color's. */
type InputOf<T> = T extends Paint ? PaintInput : ExprInput;
```

### px

```ts
/**
 * A size in CSS pixels, whatever the space's own unit: a stroke keeps its width on screen as a
 * diagram zooms. A number makes a theme's length too.
 */
function px(size: number): {
  px: number;
};
function px(size: ExprInput): Px;
```

### units

```ts
/**
 * A size in position units, whatever the space's own unit, so it scales as the view zooms, kept
 * within `atLeast` and `atMost` CSS pixels when given: `units('r', { atLeast: 2 })` grows with the map
 * and never vanishes. A marker keeps its proportions, its larger side held. A number alone makes a
 * theme's length too.
 */
function units(size: number): {
  units: number;
};
function units(size: ExprInput, within?: Within): Units;
```

### Within

```ts
/** The CSS pixels a size in position units keeps within. */
interface Within {
  /** CSS pixels it keeps at least, however far the view zooms out. */
  atLeast?: number;
  /** CSS pixels it keeps at most, however far the view zooms in. */
  atMost?: number;
}
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
 * A CSS gradient through `map`, a catalog name or colors of your own, toward `direction`: the colors
 * the GPU draws, a band each for a categorical map's categories.
 */
function colormapCss(map: Colormap, direction?: string): string;
```

## Views

A GPU makes views, and canvases that show them.

### Gpu

```ts
/** The GPU device views draw with. Views of one GPU draw in one animation frame, sharing its memory. */
class Gpu {
  /** Asks for a WebGPU device, loading latkit first: the first call takes the one made as it loaded. */
  static create(): Promise<Gpu>;
  /**
   * A view of `scene`, drawing the datasets its `sources` give. A {@link Canvas} shows it, and a
   * {@link Shot} draws it with or without one.
   */
  view(scene: Scene, options?: ViewOptions): View;
  /**
   * A canvas showing views as `layout` places them in `target`: a `<canvas>` element, which sizes
   * itself to its CSS box and passes each view the input landing on it, or an `OffscreenCanvas` in a
   * worker, which keeps the size it is given at `pixelRatio` pixels a CSS pixel.
   */
  canvas(target: HTMLCanvasElement | OffscreenCanvas, options?: CanvasOptions): Canvas;
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
  /** Bytes on the GPU every view of it draws from: data, and what each view keeps per row. */
  get resident(): number;
  /** Bytes waiting to upload, for every view of this GPU. */
  get uploading(): number;
  /**
   * Draws one frame now at `now`, milliseconds on the clock animation frames give: the frame
   * listeners, then every canvas that needs a frame. From the first step no animation frames are
   * asked for: a harness, as tests and benchmarks are, steps every frame itself, so a run draws the
   * same frames however fast the device is.
   */
  step(now: number): void;
  /**
   * Resolves once the GPU finished the work submitted to it, every readback landed, and every
   * pipeline a view or shot asked for compiled: a frame stepped then draws all of it.
   */
  done(wait?: Wait): Promise<void>;
  /**
   * Resolves when work a view waits on lands after this call (a readback, a compile, a job, a text,
   * a fetch), or a view asks for a frame.
   */
  landed(wait?: Wait): Promise<void>;
  /** Releases this GPU's canvases, views, and frame listeners. Other GPUs and data stay usable. */
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### View

````ts
/** A scene drawn from the sources it is given: shown by a canvas, which passes it input, or drawn by shots. */
class View {
  /** The scene drawn; setting an invalid one throws and keeps the scene drawn. */
  get scene(): Scene;
  set scene(scene: Scene);
  /**
   * What the view draws, each a dataset by name: a `Data`, its latest version from the frame after
   * each patch applies; a `Snapshot`, as it is; `Tiles`, the pieces the view asks for. A mark its
   * dataset no longer fits draws nothing, and the next frame tells why. Two sources of one name are
   * invalid.
   */
  get sources(): readonly Source[];
  set sources(sources: readonly Source[]);
  /** The axis coordinate shown: sampled fields read their last frame at or before it. */
  get at(): number;
  set at(at: number);
  /** Where the view looks; setting it looks there at once. */
  get camera(): Camera;
  set camera(camera: Camera);
  /** CSS pixels kept clear at the top, right, bottom, and left, as when panels cover the view. */
  get insets(): Insets;
  set insets(insets: Insets);
  /** Degrees per second a map or plane turns around its center; 0 stops it. A diagram never turns. */
  get orbit(): number;
  set orbit(degreesPerSecond: number);
  /** The rows selected, a set per table; setting it selects those and no others. */
  get selection(): readonly Rows[];
  set selection(rows: readonly Rows[]);
  /** What the user points at: the row under the pointer, or the row the keys stepped to. */
  get hovered(): Hit | null;
  /** The work under way the last frame stood in for; empty once it is complete. */
  get waiting(): Waiting;
  /**
   * Whether the last frame drew everything as the data, scene, and camera say, with nothing standing
   * in for work under way: what `waiting` lists. A shot waits for it.
   */
  get complete(): boolean;
  /** Every mark that draws nothing because its data no longer fits it, and why. */
  get failures(): readonly LatkitError[];
  /** What the view does each frame. */
  get stats(): Stats;
  /** Whether the view wants a frame: it changed, or work it waited on landed. */
  get wantsFrame(): boolean;
  /** Frames what `fit` names on the next frame, keeping pitch and bearing. */
  fit(fit?: Fit): void;
  /** Eases to `camera`. */
  fly(camera: Camera): void;
  /** Where `position` lands on screen; `null` behind the camera. */
  screen(position: Position): Point | null;
  /** The position on the ground under screen point `point`; `null` where the view shows none there. */
  position(point: Point): Position | null;
  /** Where `row` lies on screen, or `null` when no mark draws it in view, once a frame draws the view. */
  screenOf(row: Row, wait?: Wait): Promise<Point | null>;
  /**
   * Every row of a mark that picks within `radius` CSS pixels (0 unless given) of `point`, nearest
   * first, once a frame draws the view.
   */
  pick(
    point: Point,
    options?: {
      radius?: number;
    } & Wait,
  ): Promise<Hit[]>;
  /**
   * The rows joined to `row`, a set per table: a vertex's neighbors across edges and nets, or an
   * edge's or a net's vertices.
   */
  neighbors(row: Row): Rows[];
  /**
   * Lays every vertex row without a position out again by the scene's layout: a diagram's blocks, or
   * points on a plane or the earth. Places a layout gave otherwise hold, so rows added later are
   * placed around the rest. Once the layout lands, answers a patch to each dataset writing each row
   * laid out into its mark's position fields; applied, the places are the data's own.
   *
   * ```ts
   * for (const patch of await view.arrange()) if (patch.data === grid.name) grid.apply(patch);
   * ```
   */
  arrange(wait?: Wait): Promise<Patch[]>;
  /**
   * The version of dataset `name` the view draws: the latest version of a `Data` it took, a snapshot
   * given, or what it holds of `Tiles`, the pieces its camera asked for.
   */
  snapshot(name: string): Snapshot | undefined;
  /**
   * Calls `listener` with each event of `type` told while it listens; returns a function that stops
   * it. What lasts is state to read, as the property each change is named for.
   */
  on<T extends keyof ViewEvents>(type: T, listener: (event: ViewEvents[T]) => void): () => void;
  /** Frees the view, rejecting what it was asked and has not answered; a canvas showing it keeps its last frame. */
  destroy(): void;
  [Symbol.dispose](): void;
}
````

### ViewOptions

```ts
/** What a view is made with: the sources of the datasets its scene names. */
interface ViewOptions {
  sources?: readonly Source[];
}
```

### ViewEvents

```ts
/**
 * What a view tells its listeners, by type. Intents (`click`, `open`, `menu`, `drag`, `connect`,
 * `delete`) are told once each, in the order the user acted. Changes (`hovered`, `selection`,
 * `camera`, `waiting`) are named like the property they changed, and tell only their latest. A view
 * tells only what the application did not do itself: its setters change state silently.
 */
type ViewEvents = {
  [E in ViewEvent as E['type']]: E extends {
    type: 'error';
  }
    ? LatkitError
    : E['detail'];
};
```

### Insets

```ts
/** CSS pixels kept clear at the top, right, bottom, and left. */
type Insets = [top: number, right: number, bottom: number, left: number];
```

### Point

```ts
/** A point on screen: CSS pixels from the top left. */
type Point = [x: number, y: number];
```

### Position

```ts
/** A position in the space's coordinates: x, y, and elevation. */
type Position = [x: number, y: number, elevation: number];
```

### Canvas

```ts
/**
 * Views shown in a `<canvas>` element, which sizes itself to its CSS box and passes each view the
 * input landing on its panel, or an `OffscreenCanvas` in a worker, which keeps the size it is given.
 */
class Canvas {
  /** What it draws into. */
  get element(): HTMLCanvasElement | OffscreenCanvas;
  /**
   * The views shown and where, a later panel over an earlier one; setting it shows those in place of
   * the ones shown. A view shows in one panel of one canvas at a time.
   */
  get layout(): readonly Panel[];
  set layout(layout: readonly Panel[]);
  /**
   * A picture of exactly what the canvas shows: its views as its layout places them, at its size in
   * CSS pixels times `scale`.
   */
  shot(options?: ShotOptions): Shot;
  /** Stops drawing; the views remain, and the element keeps its last frame. */
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### CanvasOptions

```ts
/** How a canvas shows its views. */
interface CanvasOptions {
  /** The views shown and where; a later panel draws over an earlier one. */
  layout?: readonly Panel[];
  /** Pixels a CSS pixel of an `OffscreenCanvas`; an element follows its device. */
  pixelRatio?: number;
}
```

### Panel

```ts
/** A view's place in a canvas or a picture: where it draws, all of it unless `at` says. */
interface Panel {
  view: View;
  at?: Rect;
}
```

### Rect

```ts
/** `[x, y, width, height]` as fractions of a canvas or a picture. */
type Rect = readonly [x: number, y: number, width: number, height: number];
```

## Pictures and video

Shots draw views into images and video.

### Shot

````ts
/**
 * A picture of views, each drawn into its panel of `size` pixels as `layout` places it: drawn while a
 * canvas showing it holds its last frame, each view's data as it was when the picture began. A
 * canvas's `shot()` takes one of what it shows.
 *
 * ```ts
 * const png = await (await canvas.shot({ scale: 2 }).image()).encode('png');
 * ```
 */
class Shot {
  readonly size: readonly [number, number];
  readonly options: ShotOptions & {
    layout?: readonly Panel[];
  };
  /** A picture `size` pixels wide and high, of the views of `options.layout`. */
  constructor(
    size: readonly [number, number],
    options?: ShotOptions & {
      layout?: readonly Panel[];
    },
  );
  /** The picture, once every view is complete as `capture` says. */
  image(wait?: Wait): Promise<Image>;
  /**
   * A video of these pictures at `fps` frames a second, H.264 in MP4, written to `output` as it is
   * drawn, at `bitrate` bits a second or about 0.15 bits a pixel a frame. Its width rounds down to a
   * multiple of 4 and its height of 2, the blocks H.264 takes. `signal` aborts it: the output is
   * aborted and the views are given back.
   */
  video({
    fps,
    output,
    bitrate,
    signal,
  }: {
    fps: number;
    output: WritableStream<Uint8Array>;
    bitrate?: number;
  } & Wait): Video;
}
````

### ShotOptions

```ts
/** How a picture is taken. */
interface ShotOptions {
  /** Pixels per CSS pixel: a view lays out `size / scale` CSS pixels, so 2 draws twice as sharp. 1 unless given. */
  scale?: number;
  /** Keeps alpha where the themes' backgrounds would be. */
  transparent?: boolean;
  /**
   * When the picture is taken: once its views are complete and still, transitions, flights, and
   * label fades run on until they land (`still`, the default); or once they are complete, as they
   * stand now, what moves held where it is (`now`).
   */
  capture?: 'still' | 'now';
  /** A still's effect time in seconds, where elapsed time and flowing comets read it. */
  elapsed?: number;
}
```

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
    } & Wait,
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
  /** Seconds into the video the next frame shows at; kept once it is done. */
  get time(): number;
  /** Frames drawn or held so far; kept once it is done. */
  get frames(): number;
  /** Draws and writes one frame, waiting for the output's backpressure. One frame draws at a time. */
  frame(): Promise<void>;
  /** Records until `step(time)` returns false; any step, drawing, output, or progress error aborts it. */
  record(
    step: (time: number) => boolean | Promise<boolean>,
    onProgress?: (progress: { frames: number; time: number }) => void,
  ): Promise<void>;
  /** Finishes pending work, writes the end of the file, and closes and unlocks the output. Idempotent. */
  finish(): Promise<void>;
  /** Cancels drawing and encoding, aborts the output, and unlocks it once pending writes settle. Idempotent. */
  abort(reason?: unknown): Promise<void>;
}
```
