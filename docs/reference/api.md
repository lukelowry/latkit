# JavaScript API

Generated from the shipped declarations. `load()` loads the WebAssembly that datasets, views,
and pictures need. Scenes, expressions, and patches do not need it. Options use the [scene and
result types](types.md).

## Loading and waiting

Load the WebAssembly once per page. A wait ends when its signal aborts (30 s by default).

### load

```ts
/**
 * Loads latkit's WebAssembly, once per page. Datasets, views, and pictures can be created once it
 * resolves. Later and concurrent calls share the first call's load. Options they pass must equal
 * the first call's, or they reject with an `io` error. A failed load rejects with an `io` error and
 * can be retried.
 *
 * Importing the package loads nothing and requests no GPU. `load()` requests a GPU adapter while
 * the WebAssembly compiles, so the browser starts its GPU process early, then requests the first
 * GPU device for `Gpu.create()`. `Gpu.create()` and `Data.read()` call `load()` themselves, as does
 * `Patch.read()` for JSON.
 */
function load(options?: LoadOptions): Promise<void>;
```

### LoadOptions

```ts
/** Options for {@link load}. Only the first call's options take effect. */
interface LoadOptions {
  /**
   * The URL of this package version's `latkit/wasm` asset, or that asset already compiled.
   * Defaults to the bundled asset.
   */
  wasm?: string | URL | WebAssembly.Module;
  /**
   * Creates a worker that runs the standalone `latkit/worker` bundle. Defaults to the bundled
   * worker.
   */
  worker?: () => Worker;
}
```

### Wait

```ts
/** Options that bound how long a promise waits. */
interface Wait {
  /**
   * Aborts the wait. A timeout rejects with a `timeout` error; any other abort rejects with a
   * `cancelled` error whose `cause` is the abort reason. Either way, latkit cancels the call's
   * pending work where it can. Without a signal, each wait times out after 30 seconds.
   */
  signal?: AbortSignal;
}
```

### LatkitError

```ts
/**
 * The error latkit throws: an `Error` with a `code`, plus a `path` to the bad part of invalid
 * input, such as `marks[2].vertices.color`. The codes:
 *
 * - `invalid`: the input is malformed or does not fit; `path` says where.
 * - `unsupported`: the browser or device cannot do what was asked.
 * - `limit`: a budget or device limit would be exceeded.
 * - `io`: reading or writing external bytes failed, such as loading latkit or fetching a file.
 * - `device-lost`: the GPU device was lost; create a new `Gpu`.
 * - `cancelled`: the wait's signal aborted, or the work was cancelled.
 * - `timeout`: the wait's signal timed out.
 * - `unloaded`: the call needs WebAssembly, and `load()` has not finished.
 * - `destroyed`: the object was destroyed, so it can no longer be used.
 */
interface LatkitError extends Error {
  code: Failure['code'] | 'unloaded' | 'destroyed';
  path?: string;
}
```

## Data and patches

Datasets of named tables, the patches that change them (written without WebAssembly), and the sources views draw.

### Data

````ts
/**
 * A dataset that changes in place: named tables of columns, changed only by patches. A patch
 * applies completely or not at all. Views given a `Data` draw its latest version, from the frame
 * after each patch. A {@link Snapshot} keeps one version and shares its pages with the dataset, so
 * keeping earlier versions, as an undo history does, costs only the pages that differ.
 *
 * ```ts
 * const grid = new Data('grid').apply(new Patch().replace('Bus', [1, 2], { kv: [230, 115] }));
 * view.sources = [grid];
 * grid.apply(new Patch().set('Bus', [2], { kv: [69] })); // drawn next frame
 * ```
 */
class Data {
  /** Creates an empty dataset named `name`. Throws an `unloaded` error before `load()` finishes. */
  constructor(name: string);
  /**
   * Reads a dataset from `source`, calling `load()` first. Its first bytes decide the format:
   *
   * - latkit's bytes, as `toBytes()` writes them.
   * - GeoJSON, plain or gzip-compressed, read in a worker. Points, line strings, and polygons
   *   become rows of tables `points`, `lines`, and `polygons`, with the geometry in field
   *   `geometry` and each property as a field. GeoJSON requires `options.name`.
   * - A dataset document, `{"name": ..., "patch": [...]}`, whose patch is read as
   *   {@link Patch.read} reads one.
   *
   * `options.name` names the dataset, replacing the name in latkit's bytes or a document.
   * `options.base` is the URL that a document's file slices are relative to; it defaults to the URL
   * the source was fetched from. Rejects with an `invalid` error for bytes that are not a valid
   * dataset, and with an `io` error when a fetch fails or answers an error status.
   */
  static read(
    source: DataSource,
    options?: {
      name?: string;
      base?: string;
    } & Wait,
  ): Promise<Data>;
  get name(): string;
  /**
   * Applies every change in `patch` (a {@link Patch} or its bytes), or none of them when one is
   * invalid, and returns this dataset. Views draw the new version from their next frame. Throws an
   * `invalid` error whose `path` names the failing change, such as `patch[1].Bus.kv`, or when the
   * patch names another dataset.
   */
  apply(patch: Patch | Uint8Array): this;
  /** The current version as a {@link Snapshot}, which later patches leave unchanged. O(1). */
  snapshot(): Snapshot;
  /**
   * Makes `snapshot`, a version of this dataset, the current version, as an undo does. Views draw
   * it from their next frame. Throws an `invalid` error for a snapshot of a dataset with another
   * name.
   */
  restore(snapshot: Snapshot): this;
  /** Describes the current version; see {@link Snapshot.describe}. */
  describe(): Description;
  /** Reads one value of the current version; see {@link Snapshot.get}. */
  get(
    table: string,
    id: Id,
    field: string,
    options?: {
      at?: number;
    },
  ): Value;
  /** Queries the current version; see {@link Snapshot.query}. */
  query(query: Query): QueryResult;
  /** Per-row minimums and maximums of the current version; see {@link Snapshot.envelope}. */
  envelope(request: EnvelopeRequest): Envelope;
  /** The current version as latkit's bytes: a patch that builds it from an empty dataset. */
  toBytes(): Uint8Array;
  /**
   * Frees this handle. Views drawing the dataset keep drawing it, and its snapshots stay usable.
   * Other methods throw afterwards.
   */
  destroy(): void;
  [Symbol.dispose](): void;
}
````

### Snapshot

```ts
/**
 * One immutable version of a dataset, taken in O(1) by {@link Data.snapshot}. A view given a
 * snapshot draws that version unchanged.
 */
class Snapshot {
  get name(): string;
  /**
   * Describes the dataset: its tables and their row counts, each field and its kind, and the axis
   * and the span its sampled fields cover.
   */
  describe(): Description;
  /**
   * Reads `field` of the row with `id` in `table`. A sampled field reads its last frame at or
   * before `options.at`, or its last frame when `at` is omitted. A reference reads the referenced
   * row's id. Returns `null` when the table, row, field, or value is missing.
   */
  get(
    table: string,
    id: Id,
    field: string,
    options?: {
      at?: number;
    },
  ): Value;
  /**
   * Runs `query` on the CPU: reads a table's rows, filtered, sorted, and paged, through the same
   * expressions marks use. Sampled fields are read at `query.at`. Throws an `invalid` error for an
   * invalid query.
   */
  query(query: Query): QueryResult;
  /**
   * Computes each row's minimum and maximum of a sampled field over equal spans of an axis range,
   * for every row or the rows `request.ids` lists. Each span reads the coarsest stored levels of
   * detail that fit in it, so it costs a few reads regardless of how many frames it covers. Throws
   * an `invalid` error for an unknown table or row, or a field that is not sampled, and a `limit`
   * error when rows times spans exceeds 2^26.
   */
  envelope(request: EnvelopeRequest): Envelope;
  /** This version as latkit's bytes: a patch that builds it from an empty dataset. */
  toBytes(): Uint8Array;
  /**
   * Frees this handle. Views given the snapshot keep drawing it; other methods throw afterwards.
   */
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### Tiles

```ts
/**
 * A dataset fetched in pieces as views need them. A `Tiles` is plain data: a dataset name and a
 * URL. Each view draws the pieces its camera and plot window need as a dataset of its own, and all
 * views of a GPU share the fetched pieces. The first bytes at `url` decide the kind of tiles:
 *
 * - Time tiles: a `frames.json` manifest as `latkit tile` writes it, for a dataset whose sampled
 *   fields' histories are fetched in spans. A line tracing a field fetches the level of detail its
 *   plot window shows; other marks fetch the frames around the view's `at`. A span still loading
 *   shows the coarser span that contains it.
 * - Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` URL template, fetched
 *   as the camera needs them. Each layer becomes a table of features of the kind its marks draw:
 *   polygons for areas, lines for lines, points for vertices. A table named `layer:polygons`,
 *   `layer:lines`, or `layer:points` holds that kind regardless of the marks.
 */
class Tiles {
  readonly name: string;
  readonly url: string;
  /** Tiles at `url`, drawn as the dataset named `name`. */
  constructor(name: string, url: string);
}
```

### Source

```ts
/** A dataset a view draws; views match it to the scene's marks by the dataset's name. */
type Source = Data | Snapshot | Tiles;
```

### DataSource

```ts
/**
 * What {@link Data.read} accepts: bytes, a `Blob`, a `Response`, a byte stream, a URL to fetch as
 * a string, or a parsed JSON value. The content is latkit's bytes, GeoJSON, or a dataset document.
 */
type DataSource =
  Uint8Array | ArrayBuffer | Blob | Response | ReadableStream<Uint8Array> | string | object;
```

### QueryResult

```ts
/**
 * The rows a query returns, as columns in the forms a patch takes: numbers as a `Float64Array`
 * (missing values NaN), other values as arrays (missing `null`), and a reference as the ids of the
 * rows it references.
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
  /** How many rows matched the query before `offset` and `limit` applied. */
  total: number;
}
```

### Envelope

```ts
/** Each row's minimum and maximum of a sampled field over equal spans of the axis. */
interface Envelope {
  /** The span boundaries on the axis: one more than the number of spans. */
  at: Float64Array;
  /**
   * Each row's minimum in each span: `spans` values per row, row after row. NaN where a span has
   * no frame.
   */
  least: Float32Array;
  /** Each row's maximum in each span, laid out like `least`. */
  greatest: Float32Array;
}
```

### Patch

````ts
/**
 * A list of changes to a dataset, which `Data.apply` applies in order, all or none. The patch is
 * encoded as latkit's bytes as it is built, without WebAssembly. Each method adds a change and
 * returns the patch. For values it cannot encode, a method throws an `invalid` error with a `path`
 * such as `Bus.kv`, and leaves the patch unchanged.
 *
 * ```ts
 * const patch = new Patch('grid')
 *   .replace('Bus', [101, 102], { x: Float64Array.of(0, 10), name: ['North', 'South'] })
 *   .append('Bus', 0.5, { vm: Float32Array.of(1.01, 0.99) });
 * ```
 */
class Patch {
  /** Creates an empty patch for the dataset named `data`, or for any dataset when omitted. */
  constructor(data?: string);
  /**
   * The name of the dataset this patch is for, if any. `Data.apply` rejects it for a dataset with
   * another name.
   */
  get data(): string | undefined;
  /**
   * Reads a patch from `source`: latkit's bytes, one frame as `toBytes()` writes it, or JSON that
   * any language can write without latkit. The JSON is a list of changes. Each change is keyed by
   * its method name and holds the method's parameters by name, such as
   * `{"set": {"table": "Bus", "ids": [1], "fields": {"kv": [345]}}}`. A field may be a slice of a
   * binary file, `{file, dtype, offset, count}`. Slices are fetched at once, relative to
   * `options.base`, which defaults to the URL the JSON was fetched from.
   *
   * Bytes are read without WebAssembly; JSON calls `load()` first. Rejects with a `limit` error for
   * a frame longer than `options.limit` bytes (256 MiB by default), with an `invalid` error for
   * malformed input, and with an `io` error when a fetch fails or answers an error status.
   */
  static read(
    source: PatchSource,
    options?: {
      base?: string;
      limit?: number;
    } & Wait,
  ): Promise<Patch>;
  /**
   * Yields each patch in `stream` as soon as its last byte arrives. The stream carries frames back
   * to back, such as a response body, a file, or a socket's messages. Each frame states its length
   * up front, so a frame longer than `options.limit` bytes (256 MiB by default) throws a `limit`
   * error before its body is allocated. Besides the current chunk and the patches the caller keeps,
   * at most one frame is buffered. Breaking out of the loop cancels the stream. Throws an `invalid`
   * error for a `limit` that is not a whole number of at least 12 bytes, for bytes that are not
   * latkit's, or for a stream that ends inside a frame.
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
   * Sets the name and unit of the axis that sampled fields are recorded over, such as
   * `axis('time', 's')`.
   */
  axis(name: string, unit: string): this;
  /** Replaces table `table` with rows `ids` and `fields`, adding the table if it does not exist. */
  replace(table: string, ids: RowIds, fields?: Fields): this;
  /**
   * Writes `fields` for rows `ids` of `table`. Rows with existing ids change, new ids add rows, and
   * omitted fields keep their values. Adds the table if it does not exist.
   */
  set(table: string, ids: RowIds, fields?: Fields): this;
  /** Removes the rows of `table` with `ids`. */
  remove(table: string, ids: RowIds): this;
  /**
   * Records a frame of `table` at each axis coordinate in `at`. Each field gives a value per row
   * per frame, frame by frame: every row of the first frame, then of the next. Frames cover every
   * row, or only rows `options.ids`; other rows keep their last values. A field's first frame makes
   * it a sampled field. Consecutive appends of `Float32Array` or `Float64Array` values to the same
   * fields of every row are written as one change, so one frame per call costs no more than one
   * call with every frame.
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
  /** Drops every sampled field's frames before axis coordinate `before`. */
  forget(before: number): this;
  /**
   * Stores a run of entries of sampled field `field` of `table`, at level of detail `level` (0 by
   * default), numbered from `first`. This is what a time tile holds, as `latkit tile` writes it.
   *
   * At level 0 each entry is a frame: a coordinate in `at`, and a value per row in `values`, entry
   * by entry. At level `k` each entry is a bucket of `8^k` frames: its first and last frames'
   * coordinates in `at`. `values` then holds every bucket's per-row minimums, entry by entry,
   * followed by every bucket's per-row maximums. NaN marks a missing value.
   *
   * None of the entries may be stored already. Entries past the field's last frame extend it.
   * Throws an `invalid` error for a level outside 0 to 21, lengths of `at` and `values` that do not
   * divide into whole entries and rows, or frame numbers that are not safe nonnegative integers.
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
  /** Appends `next`'s changes to this patch, which keeps its own dataset name. */
  extend(next: Patch): this;
  /** A copy of the patch as latkit's bytes: one frame, naming the dataset if the patch does. */
  toBytes(): Uint8Array;
}
````

### PatchSource

```ts
/**
 * What {@link Patch.read} accepts: bytes, a `Blob`, a `Response`, a byte stream, a URL to fetch as a
 * string, or a parsed JSON value. The content is latkit's bytes or a patch's JSON.
 */
type PatchSource =
  Uint8Array | ArrayBuffer | Blob | Response | ReadableStream<Uint8Array> | string | object;
```

### RowIds

```ts
/**
 * Row ids: a list of numbers or strings, `{ count }` for ids `0` to `count - 1`, or a `Uint32Array`
 * or `Float64Array` of numbers.
 */
type RowIds = Ids | readonly (Id | null)[] | Uint32Array | Float64Array;
```

### Values

```ts
/**
 * One field's values, one per row, with `null` for a missing value. Numbers come as a typed array
 * or an array. A `Uint8Array` holds booleans, nonzero being true. Booleans, strings, and geometries
 * also come as arrays. Values are copied when passed, so the arrays can be reused at once.
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
/**
 * A point `[x, y]`, or a nested list of points: a path (a list of points), parts (a list of paths,
 * such as a polygon's rings), or polygons (a list of parts).
 */
type Geometry = readonly number[] | readonly Geometry[];
```

### Reference

```ts
/**
 * A reference field: for each row, the id of a row in table `reference`, or `null` to reference
 * none.
 */
interface Reference {
  reference: string;
  ids: RowIds;
}
```

### reference

```ts
/** Builds a {@link Reference} field: for each row, the id of the row of `table` it references. */
function reference(table: string, ids: RowIds): Reference;
```

### Fields

```ts
/** A table's fields by name: values, or a {@link Reference}. */
type Fields = Readonly<Record<string, Values | Reference>>;
```

### ReadableBytes

```ts
/** A byte stream: anything shaped like a browser or Node.js `ReadableStream` of `Uint8Array`. */
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

Builders for the per-row expressions and colors that scene options take.

### Expr

```ts
/** A value for every row of a mark: a constant, a field, view state, or arithmetic on them. */
class Expr {
  readonly node: ExprNode;
  /** Wraps an expression's JSON form. The builders cover common cases. */
  constructor(node: ExprNode);
  toJSON(): ExprNode;
  /** Reads this expression's fields from table `table` of dataset `data`, joined by row id. */
  from(data: string, table: string): Expr;
  /**
   * Reads this expression's sampled fields at the last frame at or before the view's `at`, instead
   * of interpolating toward the next frame.
   */
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
  /** The sine of the value, an angle in radians. */
  sin(): Expr;
  /** The cosine of the value, an angle in radians. */
  cos(): Expr;
  floor(): Expr;
  ln(): Expr;
  exp(): Expr;
  /** Whether a text field equals `text`. */
  is(text: string): Expr;
  /**
   * Whether a text field contains `text`, ignoring case. In a mark, the field must be in the mark's
   * own table.
   */
  contains(text: string): Expr;
  /**
   * Maps the value to a color for every row through `map`, a catalog name or custom colors. The
   * domain fits the values shown unless set with {@link Colormapped.domain}.
   */
  colormap(map: Colormap): Colormapped;
  /**
   * Maps the value linearly onto `[low, high]`, clamped. The domain fits the values shown unless
   * set with {@link Mapped.domain}.
   */
  scale(low: number, high: number): Mapped;
}
```

### ExprInput

```ts
/** A value option: an {@link Expr}, or its JSON form, in which a string is a field name. */
type ExprInput = Expr | ExprNode;
```

### Mapped

```ts
/** A value mapped linearly onto a range, with an input domain that can be set. */
class Mapped extends Expr {
  /** Sets the input values that map to the range's ends, instead of fitting the values shown. */
  domain(low: number, high: number): Mapped;
}
```

### Missing

```ts
/** A missing value, valid as a value or a color. An option given one uses the theme's value. */
class Missing extends Expr {
  readonly node: MissingNode;
  constructor();
  toJSON(): MissingNode;
}
```

### Paint

```ts
/**
 * A color for every row of a mark: a constant, a value mapped through a colormap, or a conditional
 * choosing between colors. Color options take a `Paint` or a CSS color string.
 */
class Paint {
  readonly node: PaintNode;
  /** Wraps a color's JSON form. The builders cover common cases. */
  constructor(node: PaintNode);
  toJSON(): PaintNode;
}
```

### PaintInput

```ts
/**
 * A color option: a CSS color, a {@link Paint}, or its JSON form. A string here is always a CSS
 * color, never a field name; map a field to colors with `field(name).colormap(map)`.
 */
type PaintInput = Color | Paint | PaintNode;
```

### Colormapped

```ts
/** A value mapped through a colormap, with an input domain that can be set. */
class Colormapped extends Paint {
  /** Sets the input values that map to the colormap's ends, instead of fitting the values shown. */
  domain(low: number, high: number): Colormapped;
}
```

### Color

```ts
/**
 * A CSS color, such as `'#ffb000'` or `'rebeccapurple'`. In a color option, a string is a color.
 */
type Color = string;
```

### field

```ts
/** Reads field `name` of each row. */
const field: (name: string) => Expr;
```

### color

```ts
/** A constant color, from a CSS color string. */
const color: (css: Color) => Paint;
```

### missing

```ts
/** A missing value: an option given one uses the theme's value. */
const missing: () => Missing;
```

### when

```ts
/**
 * Starts a conditional. `when(c).then(a).when(d).then(b).otherwise(e)` takes the value of the first
 * case whose condition holds, else `e`. If the first `then` gets a color (a CSS string, a
 * {@link Paint}, a missing value, or a color's JSON form), every value of the conditional is a
 * color, and strings are CSS colors. Otherwise every value is an expression.
 */
function when(condition: ExprInput): When;
```

### When

```ts
/** A conditional's first condition, awaiting its value from `then`. */
class When {
  /** Sets the color where the condition holds; every value of the conditional is then a color. */
  then(value: PaintInput): Then<Paint>;
  /** Sets the value where the condition holds. */
  then(value: ExprInput): Then<Expr>;
}
```

### Then

```ts
/** A conditional's cases so far, awaiting another `when` case or the `otherwise` fallback. */
class Then<T extends Expr | Paint> {
  /** Adds a case, tried when no earlier condition holds. */
  when(condition: ExprInput): Next<T>;
  /** Sets the value where no condition holds, and returns the finished conditional. */
  otherwise(value: InputOf<T>): T;
}
```

### Next

```ts
/** A conditional's next condition, awaiting its value from `then`. */
class Next<T extends Expr | Paint> {
  /** Sets the value where this condition holds. */
  then(value: InputOf<T>): Then<T>;
}
```

### InputOf

```ts
/** A conditional's value input: {@link PaintInput} for colors, else {@link ExprInput}. */
type InputOf<T> = T extends Paint ? PaintInput : ExprInput;
```

### px

```ts
/**
 * A size in CSS pixels regardless of the space's unit, so it stays the same on screen as the view
 * zooms: `px(1)` keeps a diagram's stroke 1 pixel wide at any zoom. Given a number, the result also
 * works as a theme length.
 */
function px(size: number): {
  px: number;
};
function px(size: ExprInput): Px;
```

### units

```ts
/**
 * A size in position units (degrees on the earth) regardless of the space's unit, so it scales as
 * the view zooms. `within` limits its on-screen size in CSS pixels: `units('r', { atLeast: 2 })`
 * grows with the map and never shrinks below 2 pixels. A marker keeps its proportions, with the
 * limits applied to its larger side. Given only a number, the result also works as a theme length.
 */
function units(size: number): {
  units: number;
};
function units(size: ExprInput, within?: Within): Units;
```

### Within

```ts
/** On-screen limits, in CSS pixels, for a size given in position units. */
interface Within {
  /** The smallest size in CSS pixels, however far the view zooms out. */
  atLeast?: number;
  /** The largest size in CSS pixels, however far the view zooms in. */
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
/** CSS pixels from a vertex to the pointer. Vertex marks only, and not in a vertex's position. */
const pointer: () => Expr;
```

### zoom

```ts
/** The camera's zoom: the web mercator level on the earth, log₂ CSS pixels per unit elsewhere. */
const zoom: () => Expr;
```

### elapsed

```ts
/** Seconds since the view was created. A mark that reads it redraws every frame. */
const elapsed: () => Expr;
```

### icon

```ts
/**
 * An icon marker: each row shows `images[index]`, fitted in the marker's box, with `index` counting
 * from 0. The pixels are copied into the marker.
 */
function icon(images: readonly RgbaImage[], index: ExprInput): Marker;
```

### RgbaImage

```ts
/** RGBA pixels with straight alpha, rows top to bottom. A browser `ImageData` has this shape. */
interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
```

### colormapCss

```ts
/**
 * Returns a CSS `linear-gradient(...)` with the colors the GPU draws for `map`, a catalog name or a
 * custom colormap. `direction` is the gradient's CSS direction, `'to right'` by default. A
 * categorical map gives one solid band per category. Needs `await load()` first, and throws an
 * `invalid` error for an invalid `map`.
 */
function colormapCss(map: Colormap, direction?: string): string;
```

## Views

A GPU makes views, and canvases that show them.

### Gpu

```ts
/**
 * A WebGPU device that views draw with. The views and canvases of one `Gpu` share its memory and
 * draw together in each animation frame, so linked views always show the same moment.
 */
class Gpu {
  /**
   * Requests a WebGPU device, calling `load()` first. The first call reuses the device that
   * `load()` requested. Rejects with an `unsupported` error when the browser has no WebGPU device.
   */
  static create(): Promise<Gpu>;
  /**
   * Creates a view that draws `scene` from the datasets in `options.sources`. Show it in a
   * {@link Canvas}, or draw it into pictures with a `Shot`, with or without a canvas. Throws an
   * `invalid` error for an invalid scene.
   */
  view(scene: Scene, options?: ViewOptions): View;
  /**
   * Creates a canvas that shows views in `target`, placed by `options.layout`. A `<canvas>` element
   * sizes itself to its CSS box at the device pixel ratio, and passes pointer, wheel, and key input
   * to the views in its panels. An `OffscreenCanvas`, as in a worker, keeps the size it is given at
   * `options.pixelRatio` pixels per CSS pixel, and takes no input. Throws an `invalid` error for an
   * invalid layout, such as a view already shown in another panel.
   */
  canvas(target: HTMLCanvasElement | OffscreenCanvas, options?: CanvasOptions): Canvas;
  /**
   * Calls `listener` every animation frame with the frame's timestamp in milliseconds, before the
   * views draw, so changes it makes show in that frame. While any listener is registered, a frame
   * runs every animation frame. Returns a function that removes the listener.
   */
  on(type: 'frame', listener: (now: number) => void): () => void;
  /** Whether the device was lost. Drawing then does nothing; create a new `Gpu`. */
  get lost(): boolean;
  /**
   * The GPU memory budget for data, shared by every view of this GPU; see {@link Budget}. Defaults
   * to half the device's largest storage buffer, and 32 MiB uploaded per frame.
   */
  get budget(): Budget;
  set budget(budget: Budget);
  /**
   * Exact counts of the work this GPU has done since it was created; see {@link Work}. The counts
   * repeat for the same budget, device limits, and frames, so tests and benchmarks can assert them.
   */
  get work(): Work;
  /**
   * Bytes of GPU memory the views of this GPU draw from: data pages, and each view's per-row data.
   */
  get resident(): number;
  /** Bytes waiting to upload to the GPU, across every view of this GPU. */
  get uploading(): number;
  /**
   * Draws one frame immediately at time `now`, in milliseconds on the `requestAnimationFrame`
   * clock: it runs the frame listeners, then draws every canvas that needs a frame. After the first
   * call, this GPU stops requesting animation frames. A test or benchmark that steps every frame
   * itself then draws the same frames on any device.
   */
  step(now: number): void;
  /**
   * Resolves once the GPU has finished all submitted work, every readback has arrived, and every
   * pipeline a view or shot requested has compiled. A frame stepped after that uses all of it.
   */
  done(wait?: Wait): Promise<void>;
  /**
   * Resolves when, after this call, work a view is waiting on arrives (a readback, a pipeline
   * compile, a job, a label text, or a fetch), or a view requests a frame. A harness that steps
   * frames awaits it to know when to step again.
   */
  landed(wait?: Wait): Promise<void>;
  /**
   * Destroys this GPU's canvases, views, and frame listeners, then frees the device. Other GPUs and
   * datasets stay usable. Calling it again does nothing; other methods throw afterwards.
   */
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### View

````ts
/**
 * A scene drawn from its sources; created by `Gpu.view()`. A canvas shows it and passes it input,
 * and a `Shot` draws it into pictures.
 */
class View {
  /**
   * The scene drawn. Marks that match a mark of the previous scene by kind, dataset, table, and
   * name keep their state and ease to their new options. Setting an invalid scene throws an
   * `invalid` error and keeps the current one.
   */
  get scene(): Scene;
  set scene(scene: Scene);
  /**
   * The datasets the view draws, matched to marks by dataset name. The view draws a `Data` at its
   * latest version, from the frame after each patch; a `Snapshot` unchanged; and `Tiles` as the
   * pieces it needs. A mark whose dataset no longer fits it draws nothing; it is listed in
   * `failures`, and the next frame emits an `error` event. Setting two sources with the same name
   * throws an `invalid` error.
   */
  get sources(): readonly Source[];
  set sources(sources: readonly Source[]);
  /**
   * The axis coordinate shown, such as a time. Marks read sampled fields at it, interpolating
   * between the frame at or before it and the next, unless an expression uses `step()`.
   */
  get at(): number;
  set at(at: number);
  /**
   * Where the view looks. Setting it moves the camera at once; use {@link View.fly} to ease. A
   * camera of the wrong kind for the space, such as a plot camera on a map, is ignored.
   */
  get camera(): Camera;
  set camera(camera: Camera);
  /**
   * CSS pixels kept clear at the top, right, bottom, and left, such as where page panels cover the
   * view. The camera centers and fits within the rest.
   */
  get insets(): Insets;
  set insets(insets: Insets);
  /**
   * Degrees per second the camera turns about its center on a map or plane; 0 stops it. A diagram
   * never turns.
   */
  get orbit(): number;
  set orbit(degreesPerSecond: number);
  /** The selected rows, one set per table. Setting it selects exactly those rows. */
  get selection(): readonly Rows[];
  set selection(rows: readonly Rows[]);
  /** The row under the pointer, or the row keyboard navigation moved to; `null` if none. */
  get hovered(): Hit | null;
  /**
   * The kinds of pending work that kept the last frame from being complete; empty when it was
   * complete. See {@link Waiting}.
   */
  get waiting(): Waiting;
  /** Whether the last frame was complete, with nothing in `waiting` pending. Shots wait for it. */
  get complete(): boolean;
  /**
   * An error for each mark that draws nothing because its data no longer fits it, such as a missing
   * table. Each error's `path` names the mark.
   */
  get failures(): readonly LatkitError[];
  /** Counts and timings of the view's frames; see {@link Stats}. */
  get stats(): Stats;
  /** Whether the view needs a frame, because it changed or work it was waiting on arrived. */
  get wantsFrame(): boolean;
  /**
   * Frames what `fit` names, every row by default, keeping pitch and bearing. It takes effect on
   * the next frame, or a frame or two later when the extent must be measured on the GPU.
   */
  fit(fit?: Fit): void;
  /**
   * Eases the camera to `camera` over twice the scene's ease time, or at once when motion is
   * reduced. A camera of the wrong kind for the space is ignored.
   */
  fly(camera: Camera): void;
  /**
   * Projects `position` to a point on screen with the current camera, for anchoring HTML overlays;
   * `null` when it is behind the camera.
   */
  screen(position: Position): Point | null;
  /**
   * The position on the ground under screen point `point`: at elevation 0 on a plane, on the map or
   * globe on the earth, the values there on a plot. `null` where the point looks past the ground.
   */
  position(point: Point): Position | null;
  /**
   * Resolves to where `row` is on screen once a frame draws the view, or `null` when no mark draws
   * it in view. A diagram's vertices resolve at once.
   */
  screenOf(row: Row, wait?: Wait): Promise<Point | null>;
  /**
   * Resolves, once a frame draws the view, to every row of a pickable mark within `options.radius`
   * CSS pixels (0 by default) of `point`, nearest first.
   */
  pick(
    point: Point,
    options?: {
      radius?: number;
    } & Wait,
  ): Promise<Hit[]>;
  /**
   * The rows connected to `row`, one set per table: a vertex's neighbors across edges and nets, or
   * an edge's or a net's vertices. The cost is proportional to the row's degree.
   */
  neighbors(row: Row): Rows[];
  /**
   * Runs the scene's layout again for every vertex row without a position: a diagram's blocks, or
   * points on a plane or the earth. Otherwise a layout keeps the places it gave, so rows added
   * later are placed around the rest. Resolves, once the layout finishes, to one patch per dataset
   * that writes each laid-out row's place into its mark's position fields. Applying the patches
   * makes the places part of the data. Marks whose position is not read from fields are left out.
   *
   * ```ts
   * for (const patch of await view.arrange()) if (patch.data === grid.name) grid.apply(patch);
   * ```
   */
  arrange(wait?: Wait): Promise<Patch[]>;
  /**
   * The version of dataset `name` the view draws, or `undefined` if it draws none of that name: the
   * latest version of a `Data` the view has taken, a given snapshot, or the pieces of `Tiles`
   * fetched for its camera.
   */
  snapshot(name: string): Snapshot | undefined;
  /**
   * Calls `listener` with each event of `type` emitted while it is registered, and returns a
   * function that removes it. Past events are not replayed; read the current state from the
   * property a change event is named after.
   */
  on<T extends keyof ViewEvents>(type: T, listener: (event: ViewEvents[T]) => void): () => void;
  /**
   * Frees the view and rejects its unanswered queries. A canvas showing it keeps its last frame.
   * Calling it again does nothing; other methods throw afterwards.
   */
  destroy(): void;
  [Symbol.dispose](): void;
}
````

### ViewOptions

```ts
/** Options for `Gpu.view()`. */
interface ViewOptions {
  /** The datasets the scene draws; see {@link View.sources}. */
  sources?: readonly Source[];
}
```

### ViewEvents

```ts
/**
 * The events a view emits, by type, mapped to each event's detail. Intents (`click`, `open`,
 * `menu`, `drag`, `connect`, `delete`) are emitted once each, in the order the user acted. Changes
 * (`hovered`, `selection`, `camera`, `waiting`) are named after the property that changed and carry
 * only its latest value. An `error` event's detail is a {@link LatkitError}. Setters emit nothing,
 * so events report only what the application did not do itself.
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
/** A point on screen, in CSS pixels from the view's top left corner. */
type Point = [x: number, y: number];
```

### Position

```ts
/**
 * A position in the space's coordinates: x, y, and elevation. On the earth, x and y are longitude
 * and latitude; on a plot, the axis coordinate and the value.
 */
type Position = [x: number, y: number, elevation: number];
```

### Canvas

```ts
/**
 * Shows views in a `<canvas>` element or an `OffscreenCanvas`, each in its layout panel; created by
 * `Gpu.canvas()`. A frame redraws only the views that need it, or every view after a resize or a
 * layout change.
 */
class Canvas {
  /** The `<canvas>` element or `OffscreenCanvas` it draws into. */
  get element(): HTMLCanvasElement | OffscreenCanvas;
  /**
   * The views shown and their regions; later panels draw over earlier ones. Setting it replaces the
   * shown views. A view can show in only one panel of one canvas at a time. Setting a layout that
   * breaks this, or that has a panel covering no pixels, throws an `invalid` error.
   */
  get layout(): readonly Panel[];
  set layout(layout: readonly Panel[]);
  /**
   * Returns a {@link Shot} of exactly what the canvas shows: its views in its layout, at the
   * canvas's CSS size times `options.scale` (1 by default) in pixels.
   */
  shot(options?: ShotOptions): Shot;
  /**
   * Stops drawing and frees the canvas. The views stay usable, and the element keeps its last
   * frame. Calling it again does nothing.
   */
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### CanvasOptions

```ts
/** Options for `Gpu.canvas()`. */
interface CanvasOptions {
  /** The views shown and their regions; later panels draw over earlier ones. None by default. */
  layout?: readonly Panel[];
  /**
   * Pixels per CSS pixel of an `OffscreenCanvas`, 1 by default; it must be positive. A `<canvas>`
   * element uses the device pixel ratio instead.
   */
  pixelRatio?: number;
}
```

### Panel

```ts
/** A view and the region of a canvas or picture it draws in. */
interface Panel {
  view: View;
  /** Where the view draws; the whole canvas or picture by default. */
  at?: Rect;
}
```

### Rect

```ts
/** A region `[x, y, width, height]` in fractions of a canvas or picture, from its top left. */
type Rect = readonly [x: number, y: number, width: number, height: number];
```

## Pictures and video

Shots draw views into images and video.

### Shot

````ts
/**
 * A picture of views, `size` pixels in all, each view drawn into its layout panel. While a shot
 * draws a view, a canvas showing that view keeps its last frame. An image draws each view's data as
 * it was when the picture began. A canvas's `shot()` makes a shot of what the canvas shows.
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
  /** Creates a shot of `size`, `[width, height]` in pixels, of the views in `options.layout`. */
  constructor(
    size: readonly [number, number],
    options?: ShotOptions & {
      layout?: readonly Panel[];
    },
  );
  /**
   * Draws the picture once every view is complete, as `capture` says, and resolves to the
   * {@link Image}. Rejects with an `invalid` error for invalid options or a view in two panels, and
   * with the first error a view reports while drawing.
   */
  image(wait?: Wait): Promise<Image>;
  /**
   * Starts a video of this shot: H.264 in MP4 at `fps` frames per second, written to `output` as
   * frames are drawn. `bitrate` is in bits per second, about 0.15 bits per pixel per frame by
   * default. The width is rounded down to a multiple of 4 and the height to a multiple of 2, as the
   * encoder requires. Canvases showing the views keep their last frame until the video finishes or
   * aborts. Aborting `signal` aborts the video and `output`; frames have no other time limit.
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
/** Options for a {@link Shot}. */
interface ShotOptions {
  /**
   * Pixels per CSS pixel, 1 by default. Views lay out at `size / scale` CSS pixels, so 2 draws the
   * same layout twice as sharp.
   */
  scale?: number;
  /** Leaves the background transparent where the theme's background color would be. */
  transparent?: boolean;
  /**
   * When the picture is taken. `'still'`, the default, waits until every view is complete and
   * still: transitions, camera flights, and label fades run until they finish. `'now'` waits only
   * until every view is complete, and freezes anything moving where it is.
   */
  capture?: 'still' | 'now';
  /**
   * The time in seconds that `elapsed()` expressions and flowing comets show in a still picture. By
   * default they follow the view's clock.
   */
  elapsed?: number;
}
```

### Image

```ts
/** A picture's RGBA pixels, with straight alpha, rows top to bottom. */
class Image {
  /** Width in pixels. */
  get width(): number;
  /** Height in pixels. */
  get height(): number;
  /** A copy of the pixels: 4 bytes per pixel, `width * height * 4` bytes in all. */
  get rgba(): Uint8Array;
  /**
   * Encodes the image as a file, in a worker. PNG is lossless with alpha. JPEG uses
   * `options.quality` from 1 to 100 (90 by default) and drops alpha. WebP is lossless with alpha
   * and smaller than PNG. Rejects with an `invalid` error for a quality outside 1 to 100 or an
   * unknown format.
   */
  encode(
    format: ImageFormat,
    options?: {
      quality?: number;
    } & Wait,
  ): Promise<Uint8Array>;
  /** Frees the pixels. Other methods throw afterwards. */
  destroy(): void;
  [Symbol.dispose](): void;
}
```

### ImageFormat

```ts
/** An image file format for {@link Image.encode}. */
type ImageFormat = 'png' | 'jpeg' | 'webp';
```

### Video

```ts
/**
 * A video being drawn, encoded, and written; created by {@link Shot.video}. Draw frames with
 * {@link Video.frame} or {@link Video.record}, then call {@link Video.finish}.
 */
class Video {
  /** The time in seconds at which the next frame shows. Still readable after the video ends. */
  get time(): number;
  /**
   * Frames recorded so far, including frames repeated because nothing moved. Still readable after
   * the video ends.
   */
  get frames(): number;
  /**
   * Draws the next frame once its views are complete, and writes its bytes, waiting on the
   * output's backpressure. Calls must not overlap: a call made before the previous one resolves,
   * or after `finish()`, rejects with an `invalid` error, and a call after `abort()` with a
   * `cancelled` error. A failure aborts the video.
   */
  frame(): Promise<void>;
  /**
   * Records frames until `step(time)` returns false, then finishes the video. `step` gets the next
   * frame's time in seconds and can change the views before that frame is drawn. `onProgress` is
   * called after each frame. An error from `step`, drawing, the output, or `onProgress` aborts the
   * video and is rethrown.
   */
  record(
    step: (time: number) => boolean | Promise<boolean>,
    onProgress?: (progress: { frames: number; time: number }) => void,
  ): Promise<void>;
  /**
   * Waits for the frame in progress, encodes the remaining frames, writes the end of the file, and
   * closes and unlocks the output. Later calls return the same promise. Rejects with a `cancelled`
   * error if the video was aborted.
   */
  finish(): Promise<void>;
  /**
   * Cancels drawing and encoding, aborts the output with `reason`, and unlocks it once pending
   * writes settle. Later calls return the same promise. After `finish()` completes, it does
   * nothing.
   */
  abort(reason?: unknown): Promise<void>;
}
```
