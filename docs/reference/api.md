# JavaScript API

Every class, function, and type the `latkit` package exports. [`load()`](#load) loads the WebAssembly
that datasets, views, and pictures need; scenes, expressions, and patches need none. Scenes and
their options take the [scene and result types](types.md).

## Loading and waiting

Load the WebAssembly once per page. Every wait ends when its signal aborts, after 30 seconds by default.

(load)=

### `load()`

{.signature}
`function load(options?:` [`LoadOptions`](#loadoptions)`): Promise<void>`

Loads latkit's WebAssembly, once per page. Datasets, views, and pictures can be created once it
resolves. Later and concurrent calls share the first call's load. Options they pass must equal
the first call's, or they reject with an `io` error. A failed load rejects with an `io` error and
can be retried.

Importing the package loads nothing and requests no GPU. `load()` requests a GPU adapter while
the WebAssembly compiles, so the browser starts its GPU process early, then requests the first
GPU device for [`Gpu.create()`](#gpu-create). `Gpu.create()` and [`Data.read()`](#data-read) call `load()` themselves, as does
[`Patch.read()`](#patch-read) for JSON.

(loadoptions)=

### `LoadOptions`

{.signature}
`interface LoadOptions`

Options for [`load()`](#load). Only the first call's options take effect.

{#loadoptions-wasm .member}
**`wasm`**`?: string | URL | WebAssembly.Module` [¶](#loadoptions-wasm){.headerlink}
: The URL of this package version's `latkit/wasm` asset, or that asset already compiled.
  Defaults to the bundled asset.

{#loadoptions-worker .member}
**`worker`**`?: () => Worker` [¶](#loadoptions-worker){.headerlink}
: Creates a worker that runs the standalone `latkit/worker` bundle. Defaults to the bundled
  worker.

(wait)=

### `Wait`

{.signature}
`interface Wait`

Options that bound how long a promise waits.

{#wait-signal .member}
**`signal`**`?: AbortSignal` [¶](#wait-signal){.headerlink}
: Aborts the wait. A timeout rejects with a `timeout` error; any other abort rejects with a
  `cancelled` error whose `cause` is the abort reason. Either way, latkit cancels the call's
  pending work where it can. Without a signal, each wait times out after 30 seconds.

(latkiterror)=

### `LatkitError`

{.signature}
`interface LatkitError extends Error`

The error latkit throws: an `Error` whose `code` says what kind of failure it is.

{#latkiterror-code .member}
**`code`**`:` [`Failure`](#failure)`['code'] | 'unloaded' | 'destroyed'` [¶](#latkiterror-code){.headerlink}
: The kind of failure:

  - `invalid`: the input is malformed or does not fit; `path` says where.
  - `unsupported`: the browser or device cannot do what was asked.
  - `limit`: a budget or device limit would be exceeded.
  - `io`: reading or writing external bytes failed, such as loading latkit or fetching a file.
  - `device-lost`: the GPU device was lost; create a new [`Gpu`](#gpu).
  - `cancelled`: the wait's signal aborted, or the work was cancelled.
  - `timeout`: the wait's signal timed out.
  - `unloaded`: the call needs WebAssembly, and [`load()`](#load) has not finished.
  - `destroyed`: the object was destroyed, so it can no longer be used.

{#latkiterror-path .member}
**`path`**`?: string` [¶](#latkiterror-path){.headerlink}
: The invalid part of the input, such as `marks[2].vertices.color`, on `invalid` errors.

## Data and patches

Datasets of named tables, the patches that change them, written without WebAssembly, and the sources views draw.

(data)=

### `Data`

{.signature}
`class Data`

A dataset that changes in place: named tables of columns, changed only by patches. A patch
applies completely or not at all. Views given a `Data` draw its latest version, from the frame
after each patch. A [`Snapshot`](#snapshot) keeps one version and shares its pages with the dataset, so
keeping earlier versions, as an undo history does, costs only the pages that differ.

```ts
const grid = new Data('grid').apply(new Patch().replace('Bus', [1, 2], { kv: [230, 115] }));
view.sources = [grid];
grid.apply(new Patch().set('Bus', [2], { kv: [69] })); // drawn next frame
```

```{rubric} Constructor
```

{#data-new .member}
**`new Data`**`(name: string)` [¶](#data-new){.headerlink}
: Creates an empty dataset named `name`. Throws an `unloaded` error before [`load()`](#load) finishes.

```{rubric} Properties
```

{#data-name .member}
`readonly` **`name`**`: string` [¶](#data-name){.headerlink}
: The dataset's name, by which a mark's `data` option draws it.

```{rubric} Methods
```

{#data-read .member}
`static` **`read`**`(source:` [`DataSource`](#datasource)`, options?: { name?: string; base?: string } &` [`Wait`](#wait)`): Promise<Data>` [¶](#data-read){.headerlink}
: Reads a dataset from `source`, calling [`load()`](#load) first. Its first bytes decide the format:

  - latkit's bytes, as `toBytes()` writes them.
  - GeoJSON, plain or gzip-compressed, read in a worker. Points, line strings, and polygons
    become rows of tables `points`, `lines`, and `polygons`, with the geometry in field
    `geometry` and each property as a field. GeoJSON requires `options.name`.
  - A dataset document, `{"name": ..., "patch": [...]}`, whose patch is read as
    [`Patch.read()`](#patch-read) reads one.

  `options.name` names the dataset, replacing the name in latkit's bytes or a document.
  `options.base` is the URL that a document's file slices are relative to; it defaults to the URL
  the source was fetched from. Rejects with an `invalid` error for bytes that are not a valid
  dataset, and with an `io` error when a fetch fails or answers an error status.

{#data-apply .member}
**`apply`**`(patch:` [`Patch`](#patch) `| Uint8Array): this` [¶](#data-apply){.headerlink}
: Applies every change in `patch` (a [`Patch`](#patch) or its bytes), or none of them when one is
  invalid, and returns this dataset. Views draw the new version from their next frame. Throws an
  `invalid` error whose `path` names the failing change, such as `patch[1].Bus.kv`, or when the
  patch names another dataset.

{#data-snapshot .member}
**`snapshot`**`():` [`Snapshot`](#snapshot) [¶](#data-snapshot){.headerlink}
: The current version as a [`Snapshot`](#snapshot), which later patches leave unchanged. O(1).

{#data-restore .member}
**`restore`**`(snapshot:` [`Snapshot`](#snapshot)`): this` [¶](#data-restore){.headerlink}
: Makes `snapshot`, a version of this dataset, the current version, as an undo does. Views draw
  it from their next frame. Throws an `invalid` error for a snapshot of a dataset with another
  name.

{#data-describe .member}
**`describe`**`():` [`Description`](#description) [¶](#data-describe){.headerlink}
: Describes the current version; see [`Snapshot.describe()`](#snapshot-describe).

{#data-get .member}
**`get`**`(table: string, id:` [`Id`](#id)`, field: string, options?: { at?: number }):` [`Value`](#value) [¶](#data-get){.headerlink}
: Reads one value of the current version; see [`Snapshot.get()`](#snapshot-get).

{#data-query .member}
**`query`**`(query:` [`Query`](#query)`):` [`QueryResult`](#queryresult) [¶](#data-query){.headerlink}
: Queries the current version; see [`Snapshot.query()`](#snapshot-query).

{#data-envelope .member}
**`envelope`**`(request:` [`EnvelopeRequest`](#enveloperequest)`):` [`Envelope`](#envelope) [¶](#data-envelope){.headerlink}
: Per-row minimums and maximums of the current version; see [`Snapshot.envelope()`](#snapshot-envelope).

{#data-tobytes .member}
**`toBytes`**`(): Uint8Array` [¶](#data-tobytes){.headerlink}
: The current version as latkit's bytes: a patch that builds it from an empty dataset.

{#data-destroy .member}
**`destroy`**`(): void` [¶](#data-destroy){.headerlink}
: Frees this handle. Views drawing the dataset keep drawing it, and its snapshots stay usable.
  Other methods throw afterwards.

{#data-symbol-dispose .member}
**`[Symbol.dispose]`**`(): void` [¶](#data-symbol-dispose){.headerlink}
: Calls [`Data.destroy()`](#data-destroy), so a `using` declaration destroys it when its block ends.

(snapshot)=

### `Snapshot`

{.signature}
`class Snapshot`

One immutable version of a dataset, taken in O(1) by [`Data.snapshot()`](#data-snapshot). A view given a
snapshot draws that version unchanged.

```{rubric} Properties
```

{#snapshot-name .member}
`readonly` **`name`**`: string` [¶](#snapshot-name){.headerlink}
: The name of the dataset this is a version of.

```{rubric} Methods
```

{#snapshot-describe .member}
**`describe`**`():` [`Description`](#description) [¶](#snapshot-describe){.headerlink}
: Describes the dataset: its tables and their row counts, each field and its kind, and the axis
  and the span its sampled fields cover.

{#snapshot-get .member}
**`get`**`(table: string, id:` [`Id`](#id)`, field: string, options?: { at?: number }):` [`Value`](#value) [¶](#snapshot-get){.headerlink}
: Reads `field` of the row with `id` in `table`. A sampled field reads its last frame at or
  before `options.at`, or its last frame when `at` is omitted. A reference reads the referenced
  row's id. Returns `null` when the table, row, field, or value is missing.

{#snapshot-query .member}
**`query`**`(query:` [`Query`](#query)`):` [`QueryResult`](#queryresult) [¶](#snapshot-query){.headerlink}
: Runs `query` on the CPU: reads a table's rows, filtered, sorted, and paged, through the same
  expressions marks use. Sampled fields are read at [`query.at`](#query-at). Throws an `invalid` error for an
  invalid query.

{#snapshot-envelope .member}
**`envelope`**`(request:` [`EnvelopeRequest`](#enveloperequest)`):` [`Envelope`](#envelope) [¶](#snapshot-envelope){.headerlink}
: Computes each row's minimum and maximum of a sampled field over equal spans of an axis range,
  for every row or the rows `request.ids` lists. Each span reads the coarsest stored levels of
  detail that fit in it, so it costs a few reads regardless of how many frames it covers. Throws
  an `invalid` error for an unknown table or row, or a field that is not sampled, and a `limit`
  error when rows times spans exceeds 2^26.

{#snapshot-tobytes .member}
**`toBytes`**`(): Uint8Array` [¶](#snapshot-tobytes){.headerlink}
: This version as latkit's bytes: a patch that builds it from an empty dataset.

{#snapshot-destroy .member}
**`destroy`**`(): void` [¶](#snapshot-destroy){.headerlink}
: Frees this handle. Views given the snapshot keep drawing it; other methods throw afterwards.

{#snapshot-symbol-dispose .member}
**`[Symbol.dispose]`**`(): void` [¶](#snapshot-symbol-dispose){.headerlink}
: Calls [`Snapshot.destroy()`](#snapshot-destroy), so a `using` declaration destroys it when its block ends.

(tiles)=

### `Tiles`

{.signature}
`class Tiles`

A dataset fetched in pieces as views need them. A `Tiles` is plain data: a dataset name and a
URL. Each view draws the pieces its camera and plot window need as a dataset of its own, and all
views of a GPU share the fetched pieces. The first bytes at `url` decide the kind of tiles:

- Time tiles: a `frames.json` manifest as `latkit tile` writes it, for a dataset whose sampled
  fields' histories are fetched in spans. A line tracing a field fetches the level of detail its
  plot window shows; other marks fetch the frames around the view's `at`. A span still loading
  shows the coarser span that contains it.
- Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` URL template, fetched
  as the camera needs them. Each layer becomes a table of features of the kind its marks draw:
  polygons for areas, lines for lines, points for vertices. A table named `layer:polygons`,
  `layer:lines`, or `layer:points` holds that kind regardless of the marks.

```{rubric} Constructor
```

{#tiles-new .member}
**`new Tiles`**`(name: string, url: string)` [¶](#tiles-new){.headerlink}
: Tiles at `url`, drawn as the dataset named `name`.

```{rubric} Properties
```

{#tiles-name .member}
`readonly` **`name`**`: string` [¶](#tiles-name){.headerlink}
: The name of the dataset the tiles are drawn as, by which a mark's `data` option draws it.

{#tiles-url .member}
`readonly` **`url`**`: string` [¶](#tiles-url){.headerlink}
: Where the tiles are: a `frames.json` manifest, a PMTiles archive, a TileJSON document, or a
  `{z}/{x}/{y}` URL template.

(source)=

### `Source`

{.signature}
`type Source =` [`Data`](#data) `|` [`Snapshot`](#snapshot) `|` [`Tiles`](#tiles)

A dataset a view draws; views match it to the scene's marks by the dataset's name.

{#source-data .member}
[`Data`](#data) [¶](#source-data){.headerlink}
: A dataset that changes in place: named tables of columns, changed only by patches.

{#source-snapshot .member}
[`Snapshot`](#snapshot) [¶](#source-snapshot){.headerlink}
: One immutable version of a dataset, taken in O(1) by [`Data.snapshot()`](#data-snapshot).

{#source-tiles .member}
[`Tiles`](#tiles) [¶](#source-tiles){.headerlink}
: A dataset fetched in pieces as views need them.

(datasource)=

### `DataSource`

{.signature}
`type DataSource = Uint8Array | ArrayBuffer | Blob | Response | ReadableStream<Uint8Array> | string | object`

What [`Data.read()`](#data-read) accepts: bytes, a `Blob`, a `Response`, a byte stream, a URL to fetch as
a string, or a parsed JSON value. The content is latkit's bytes, GeoJSON, or a dataset document.

(queryresult)=

### `QueryResult`

{.signature}
`interface QueryResult`

The rows a query returns, as columns in the forms a patch takes.

{#queryresult-table .member}
**`table`**`: string` [¶](#queryresult-table){.headerlink}
: The table read.

{#queryresult-ids .member}
**`ids`**`:` [`Id`](#id)`[]` [¶](#queryresult-ids){.headerlink}
: The ids of the rows returned, in order.

{#queryresult-fields .member}
**`fields`**`: Record<string, Float64Array |` [`Value`](#value)`[] | { reference: string; ids: (`[`Id`](#id) `| null)[] }>` [¶](#queryresult-fields){.headerlink}
: Each selected field's column, by output name: numbers as a `Float64Array` with NaN for missing
  values, other values as an array with `null` for missing ones, and a reference as the table it
  references and the id of the row each row references.

{#queryresult-total .member}
**`total`**`: number` [¶](#queryresult-total){.headerlink}
: How many rows matched the query before `offset` and `limit` applied.

(envelope)=

### `Envelope`

{.signature}
`interface Envelope`

Each row's minimum and maximum of a sampled field over equal spans of the axis.

{#envelope-at .member}
**`at`**`: Float64Array` [¶](#envelope-at){.headerlink}
: The span boundaries on the axis: one more than the number of spans.

{#envelope-least .member}
**`least`**`: Float32Array` [¶](#envelope-least){.headerlink}
: Each row's minimum in each span: `spans` values per row, row after row. NaN where a span has
  no frame.

{#envelope-greatest .member}
**`greatest`**`: Float32Array` [¶](#envelope-greatest){.headerlink}
: Each row's maximum in each span, laid out like `least`.

(patch)=

### `Patch`

{.signature}
`class Patch`

A list of changes to a dataset, which [`Data.apply`](#data-apply) applies in order, all or none. The patch is
encoded as latkit's bytes as it is built, without WebAssembly. Each method adds a change and
returns the patch. For values it cannot encode, a method throws an `invalid` error with a `path`
such as `Bus.kv`, and leaves the patch unchanged.

```ts
const patch = new Patch('grid')
  .replace('Bus', [101, 102], { x: Float64Array.of(0, 10), name: ['North', 'South'] })
  .append('Bus', 0.5, { vm: Float32Array.of(1.01, 0.99) });
```

```{rubric} Constructor
```

{#patch-new .member}
**`new Patch`**`(data?: string)` [¶](#patch-new){.headerlink}
: Creates an empty patch for the dataset named `data`, or for any dataset when omitted.

```{rubric} Properties
```

{#patch-data .member}
`readonly` **`data`**`: string | undefined` [¶](#patch-data){.headerlink}
: The name of the dataset this patch is for, if any. [`Data.apply`](#data-apply) rejects it for a dataset with
  another name.

```{rubric} Methods
```

{#patch-read .member}
`static` **`read`**`(source:` [`PatchSource`](#patchsource)`, options?: { base?: string; limit?: number } &` [`Wait`](#wait)`): Promise<Patch>` [¶](#patch-read){.headerlink}
: Reads a patch from `source`: latkit's bytes, one frame as `toBytes()` writes it, or JSON that
  any language can write without latkit. The JSON is a list of changes. Each change is keyed by
  its method name and holds the method's parameters by name, such as
  `{"set": {"table": "Bus", "ids": [1], "fields": {"kv": [345]}}}`. A field may be a slice of a
  binary file, `{file, dtype, offset, count}`. Slices are fetched at once, relative to
  `options.base`, which defaults to the URL the JSON was fetched from.

  Bytes are read without WebAssembly; JSON calls [`load()`](#load) first. Rejects with a `limit` error for
  a frame longer than `options.limit` bytes (256 MiB by default), with an `invalid` error for
  malformed input, and with an `io` error when a fetch fails or answers an error status.

{#patch-stream .member}
`static` **`stream`**`(stream:` [`ReadableBytes`](#readablebytes) `| AsyncIterable<Uint8Array>, { limit }?: { limit?: number }): AsyncGenerator<Patch>` [¶](#patch-stream){.headerlink}
: Yields each patch in `stream` as soon as its last byte arrives. The stream carries frames back
  to back, such as a response body, a file, or a socket's messages. Each frame states its length
  up front, so a frame longer than `options.limit` bytes (256 MiB by default) throws a `limit`
  error before its body is allocated. Besides the current chunk and the patches the caller keeps,
  at most one frame is buffered. Breaking out of the loop cancels the stream. Throws an `invalid`
  error for a `limit` that is not a whole number of at least 12 bytes, for bytes that are not
  latkit's, or for a stream that ends inside a frame.

  ```ts
  for await (const patch of Patch.stream((await fetch('/feed')).body!)) data.apply(patch);
  ```

{#patch-axis .member}
**`axis`**`(name: string, unit: string): this` [¶](#patch-axis){.headerlink}
: Sets the name and unit of the axis that sampled fields are recorded over, such as
  `axis('time', 's')`.

{#patch-replace .member}
**`replace`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this` [¶](#patch-replace){.headerlink}
: Replaces table `table` with rows `ids` and `fields`, adding the table if it does not exist.

{#patch-set .member}
**`set`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this` [¶](#patch-set){.headerlink}
: Writes `fields` for rows `ids` of `table`. Rows with existing ids change, new ids add rows, and
  omitted fields keep their values. Adds the table if it does not exist.

{#patch-remove .member}
**`remove`**`(table: string, ids:` [`RowIds`](#rowids)`): this` [¶](#patch-remove){.headerlink}
: Removes the rows of `table` with `ids`.

{#patch-append .member}
**`append`**`(table: string, at: number | readonly number[], fields: Readonly<Record<string,` [`Values`](#values)`>>, { ids }?: { ids?:` [`RowIds`](#rowids) `}): this` [¶](#patch-append){.headerlink}
: Records a frame of `table` at each axis coordinate in `at`. Each field gives a value per row
  per frame, frame by frame: every row of the first frame, then of the next. Frames cover every
  row, or only rows `options.ids`; other rows keep their last values. A field's first frame makes
  it a sampled field. Consecutive appends of `Float32Array` or `Float64Array` values to the same
  fields of every row are written as one change, so one frame per call costs no more than one
  call with every frame.

{#patch-forget .member}
**`forget`**`(before: number): this` [¶](#patch-forget){.headerlink}
: Drops every sampled field's frames before axis coordinate `before`.

{#patch-frames .member}
**`frames`**`(table: string, field: string, { level, first, at, values }: { level?: number; first: number; at: Float64Array | readonly number[]; values: Float32Array | readonly number[] }): this` [¶](#patch-frames){.headerlink}
: Stores a run of entries of sampled field `field` of `table`, at level of detail `level` (0 by
  default), numbered from `first`. This is what a time tile holds, as `latkit tile` writes it.

  At level 0 each entry is a frame: a coordinate in `at`, and a value per row in `values`, entry
  by entry. At level `k` each entry is a bucket of `8^k` frames: its first and last frames'
  coordinates in `at`. `values` then holds every bucket's per-row minimums, entry by entry,
  followed by every bucket's per-row maximums. NaN marks a missing value.

  None of the entries may be stored already. Entries past the field's last frame extend it.
  Throws an `invalid` error for a level outside 0 to 21, lengths of `at` and `values` that do not
  divide into whole entries and rows, or frame numbers that are not safe nonnegative integers.

{#patch-extend .member}
**`extend`**`(next: Patch): this` [¶](#patch-extend){.headerlink}
: Appends `next`'s changes to this patch, which keeps its own dataset name.

{#patch-tobytes .member}
**`toBytes`**`(): Uint8Array` [¶](#patch-tobytes){.headerlink}
: A copy of the patch as latkit's bytes: one frame, naming the dataset if the patch does.

(patchsource)=

### `PatchSource`

{.signature}
`type PatchSource = Uint8Array | ArrayBuffer | Blob | Response | ReadableStream<Uint8Array> | string | object`

What [`Patch.read()`](#patch-read) accepts: bytes, a `Blob`, a `Response`, a byte stream, a URL to fetch as a
string, or a parsed JSON value. The content is latkit's bytes or a patch's JSON.

(rowids)=

### `RowIds`

{.signature}
`type RowIds =` [`Ids`](#ids) `| readonly (`[`Id`](#id) `| null)[] | Uint32Array | Float64Array`

Row ids: a list of numbers or strings, `{ count }` for ids `0` to `count - 1`, or a `Uint32Array`
or `Float64Array` of numbers.

{#rowids-ids .member}
[`Ids`](#ids) [¶](#rowids-ids){.headerlink}
: Row ids: a list of numbers or texts, or `{count}` for rows 0 to count - 1.

(values)=

### `Values`

{.signature}
`type Values = Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array | readonly (number | null)[] | readonly (boolean | null)[] | readonly (string | null)[] | readonly (`[`Geometry`](#geometry) `| null)[]`

One field's values, one per row, with `null` for a missing value. Numbers come as a typed array
or an array. A `Uint8Array` holds booleans, nonzero being true. Booleans, strings, and geometries
also come as arrays. Values are copied when passed, so the arrays can be reused at once.

(geometry)=

### `Geometry`

{.signature}
`type Geometry = readonly number[] | readonly Geometry[]`

A point `[x, y]`, or a nested list of points: a path (a list of points), parts (a list of paths,
such as a polygon's rings), or polygons (a list of parts).

(reference)=

### `Reference`

{.signature}
`interface Reference`

A reference field: for each row, a row of another table.

{#reference-reference .member}
**`reference`**`: string` [¶](#reference-reference){.headerlink}
: The table referenced.

{#reference-ids .member}
**`ids`**`:` [`RowIds`](#rowids) [¶](#reference-ids){.headerlink}
: For each row, the id of the row it references, or `null` to reference none.

(reference-function)=

### `reference()`

{.signature}
`function reference(table: string, ids:` [`RowIds`](#rowids)`):` [`Reference`](#reference)

Builds a [`Reference`](#reference) field: for each row, the id of the row of `table` it references.

(fields)=

### `Fields`

{.signature}
`type Fields = Readonly<Record<string,` [`Values`](#values) `|` [`Reference`](#reference)`>>`

A table's fields by name: values, or a [`Reference`](#reference).

(readablebytes)=

### `ReadableBytes`

{.signature}
`interface ReadableBytes`

A byte stream: anything shaped like a browser or Node.js `ReadableStream` of `Uint8Array`.

{#readablebytes-getreader .member}
**`getReader`**`(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void>; releaseLock(): void }` [¶](#readablebytes-getreader){.headerlink}
: A reader of the stream's chunks, which latkit reads to the end, or cancels.

## Expressions

Builders for the per-row expressions and colors that scene options take.

(expr)=

### `Expr`

{.signature}
`class Expr`

A value for every row of a mark: a constant, a field, view state, or arithmetic on them.

```{rubric} Constructor
```

{#expr-new .member}
**`new Expr`**`(node:` [`ExprNode`](#exprnode)`)` [¶](#expr-new){.headerlink}
: Wraps an expression's JSON form. The builders cover common cases.

```{rubric} Properties
```

{#expr-node .member}
`readonly` **`node`**`:` [`ExprNode`](#exprnode) [¶](#expr-node){.headerlink}
: The expression's JSON form.

```{rubric} Methods
```

{#expr-tojson .member}
**`toJSON`**`():` [`ExprNode`](#exprnode) [¶](#expr-tojson){.headerlink}
: The JSON form, which `JSON.stringify` writes for the expression.

{#expr-from .member}
**`from`**`(data: string, table: string): Expr` [¶](#expr-from){.headerlink}
: Reads this expression's fields from table `table` of dataset `data`, joined by row id.

{#expr-step .member}
**`step`**`(): Expr` [¶](#expr-step){.headerlink}
: Reads this expression's sampled fields at the last frame at or before the view's `at`, instead
  of interpolating toward the next frame.

{#expr-add .member}
**`add`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-add){.headerlink}
: The sum of this value and `other`.

{#expr-sub .member}
**`sub`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-sub){.headerlink}
: This value minus `other`.

{#expr-mul .member}
**`mul`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-mul){.headerlink}
: The product of this value and `other`.

{#expr-div .member}
**`div`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-div){.headerlink}
: This value divided by `other`. Dividing by 0 gives a missing value.

{#expr-rem .member}
**`rem`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-rem){.headerlink}
: The remainder of this value divided by `other`, with the sign of `other`: `-1 rem 3` is 2.

{#expr-pow .member}
**`pow`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-pow){.headerlink}
: This value raised to the power `other`.

{#expr-min .member}
**`min`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-min){.headerlink}
: The smaller of this value and `other`.

{#expr-max .member}
**`max`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-max){.headerlink}
: The larger of this value and `other`.

{#expr-clamp .member}
**`clamp`**`(low:` [`ExprInput`](#exprinput)`, high:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-clamp){.headerlink}
: This value limited to the range from `low` to `high`.

{#expr-lt .member}
**`lt`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-lt){.headerlink}
: 1 where this value is less than `other`, else 0.

{#expr-le .member}
**`le`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-le){.headerlink}
: 1 where this value is at most `other`, else 0.

{#expr-gt .member}
**`gt`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-gt){.headerlink}
: 1 where this value is greater than `other`, else 0.

{#expr-ge .member}
**`ge`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-ge){.headerlink}
: 1 where this value is at least `other`, else 0.

{#expr-eq .member}
**`eq`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-eq){.headerlink}
: 1 where this value equals `other`, else 0. Colors compare too.

{#expr-ne .member}
**`ne`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-ne){.headerlink}
: 1 where this value differs from `other`, else 0. Colors compare too.

{#expr-and .member}
**`and`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-and){.headerlink}
: 1 where this value and `other` are both above 0.5, else 0.

{#expr-or .member}
**`or`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-or){.headerlink}
: 1 where this value or `other` is above 0.5, else 0.

{#expr-not .member}
**`not`**`(): Expr` [¶](#expr-not){.headerlink}
: 1 where this value is at most 0.5, else 0.

{#expr-neg .member}
**`neg`**`(): Expr` [¶](#expr-neg){.headerlink}
: The value negated.

{#expr-abs .member}
**`abs`**`(): Expr` [¶](#expr-abs){.headerlink}
: The absolute value.

{#expr-sqrt .member}
**`sqrt`**`(): Expr` [¶](#expr-sqrt){.headerlink}
: The square root. Negative values give a missing value.

{#expr-sin .member}
**`sin`**`(): Expr` [¶](#expr-sin){.headerlink}
: The sine of the value, an angle in radians.

{#expr-cos .member}
**`cos`**`(): Expr` [¶](#expr-cos){.headerlink}
: The cosine of the value, an angle in radians.

{#expr-floor .member}
**`floor`**`(): Expr` [¶](#expr-floor){.headerlink}
: The largest whole number at most the value.

{#expr-ln .member}
**`ln`**`(): Expr` [¶](#expr-ln){.headerlink}
: The natural logarithm. Values at most 0 give a missing value.

{#expr-exp .member}
**`exp`**`(): Expr` [¶](#expr-exp){.headerlink}
: e raised to the value.

{#expr-is .member}
**`is`**`(text: string): Expr` [¶](#expr-is){.headerlink}
: Whether a text field equals `text`.

{#expr-contains .member}
**`contains`**`(text: string): Expr` [¶](#expr-contains){.headerlink}
: Whether a text field contains `text`, ignoring case. In a mark, the field must be in the mark's
  own table.

{#expr-colormap .member}
**`colormap`**`(map:` [`Colormap`](#colormap)`):` [`Colormapped`](#colormapped) [¶](#expr-colormap){.headerlink}
: Maps the value to a color for every row through `map`, a catalog name or custom colors. The
  domain fits the values shown unless set with [`Colormapped.domain()`](#colormapped-domain).

{#expr-scale .member}
**`scale`**`(low: number, high: number):` [`Mapped`](#mapped) [¶](#expr-scale){.headerlink}
: Maps the value linearly onto `[low, high]`, clamped. The domain fits the values shown unless
  set with [`Mapped.domain()`](#mapped-domain).

(exprinput)=

### `ExprInput`

{.signature}
`type ExprInput =` [`Expr`](#expr) `|` [`ExprNode`](#exprnode)

A value option: an [`Expr`](#expr), or its JSON form, in which a string is a field name.

{#exprinput-expr .member}
[`Expr`](#expr) [¶](#exprinput-expr){.headerlink}
: A value for every row of a mark: a constant, a field, view state, or arithmetic on them.

{#exprinput-exprnode .member}
[`ExprNode`](#exprnode) [¶](#exprinput-exprnode){.headerlink}
: A value for each row: a number, a boolean, a field's name, or a node that computes one.

(mapped)=

### `Mapped`

{.signature}
`class Mapped extends` [`Expr`](#expr)

A value mapped linearly onto a range, with an input domain that can be set.

```{rubric} Methods
```

{#mapped-domain .member}
**`domain`**`(low: number, high: number): Mapped` [¶](#mapped-domain){.headerlink}
: Sets the input values that map to the range's ends, instead of fitting the values shown.

(missing)=

### `Missing`

{.signature}
`class Missing extends` [`Expr`](#expr)

A missing value, valid as a value or a color. An option given one uses the theme's value.

```{rubric} Constructor
```

{#missing-new .member}
**`new Missing`**`()` [¶](#missing-new){.headerlink}
: A missing value. [`missing()`](#missing-function) makes one too.

```{rubric} Properties
```

{#missing-node .member}
`readonly` **`node`**`:` [`MissingNode`](#missingnode) [¶](#missing-node){.headerlink}
: The missing value's JSON form, `{ missing: true }`.

```{rubric} Methods
```

{#missing-tojson .member}
**`toJSON`**`():` [`MissingNode`](#missingnode) [¶](#missing-tojson){.headerlink}
: The JSON form, which `JSON.stringify` writes for the missing value.

(paint)=

### `Paint`

{.signature}
`class Paint`

A color for every row of a mark: a constant, a value mapped through a colormap, or a conditional
choosing between colors. Color options take a `Paint` or a CSS color string.

```{rubric} Constructor
```

{#paint-new .member}
**`new Paint`**`(node:` [`PaintNode`](#paintnode)`)` [¶](#paint-new){.headerlink}
: Wraps a color's JSON form. The builders cover common cases.

```{rubric} Properties
```

{#paint-node .member}
`readonly` **`node`**`:` [`PaintNode`](#paintnode) [¶](#paint-node){.headerlink}
: The color's JSON form.

```{rubric} Methods
```

{#paint-tojson .member}
**`toJSON`**`():` [`PaintNode`](#paintnode) [¶](#paint-tojson){.headerlink}
: The JSON form, which `JSON.stringify` writes for the color.

(paintinput)=

### `PaintInput`

{.signature}
`type PaintInput =` [`Color`](#color) `|` [`Paint`](#paint) `|` [`PaintNode`](#paintnode)

A color option: a CSS color, a [`Paint`](#paint), or its JSON form. A string here is always a CSS
color, never a field name; map a field to colors with `field(name).colormap(map)`.

{#paintinput-color .member}
[`Color`](#color) [¶](#paintinput-color){.headerlink}
: A CSS color, such as `'#ffb000'` or `'rebeccapurple'`.

{#paintinput-paint .member}
[`Paint`](#paint) [¶](#paintinput-paint){.headerlink}
: A color for every row of a mark: a constant, a value mapped through a colormap, or a conditional choosing between colors.

{#paintinput-paintnode .member}
[`PaintNode`](#paintnode) [¶](#paintinput-paintnode){.headerlink}
: A color for each row: a CSS color, a value through a colormap, or a conditional choosing between colors.

(colormapped)=

### `Colormapped`

{.signature}
`class Colormapped extends` [`Paint`](#paint)

A value mapped through a colormap, with an input domain that can be set.

```{rubric} Methods
```

{#colormapped-domain .member}
**`domain`**`(low: number, high: number): Colormapped` [¶](#colormapped-domain){.headerlink}
: Sets the input values that map to the colormap's ends, instead of fitting the values shown.

(color)=

### `Color`

{.signature}
`type Color = string`

A CSS color, such as `'#ffb000'` or `'rebeccapurple'`. In a color option, a string is a color.

(field)=

### `field()`

{.signature}
`function field(name: string):` [`Expr`](#expr)

Reads field `name` of each row.

(color-function)=

### `color()`

{.signature}
`function color(css:` [`Color`](#color)`):` [`Paint`](#paint)

A constant color, from a CSS color string.

(missing-function)=

### `missing()`

{.signature}
`function missing():` [`Missing`](#missing)

A missing value: an option given one uses the theme's value.

(when-function)=

### `when()`

{.signature}
`function when(condition:` [`ExprInput`](#exprinput)`):` [`When`](#when)

Starts a conditional. `when(c).then(a).when(d).then(b).otherwise(e)` takes the value of the first
case whose condition holds, else `e`. If the first `then` gets a color (a CSS string, a
[`Paint`](#paint), a missing value, or a color's JSON form), every value of the conditional is a
color, and strings are CSS colors. Otherwise every value is an expression.

(when)=

### `When`

{.signature}
`class When`

A conditional's first condition, awaiting its value from `then`.

```{rubric} Methods
```

{#when-then .member}
**`then`**`(value:` [`PaintInput`](#paintinput)`):` [`Then`](#then)`<`[`Paint`](#paint)`>` [¶](#when-then){.headerlink}
: Sets the color where the condition holds; every value of the conditional is then a color.

{.member}
**`then`**`(value:` [`ExprInput`](#exprinput)`):` [`Then`](#then)`<`[`Expr`](#expr)`>`
: Sets the value where the condition holds.

(then)=

### `Then<T>`

{.signature}
`class Then<T extends` [`Expr`](#expr) `|` [`Paint`](#paint)`>`

A conditional's cases so far, awaiting another `when` case or the `otherwise` fallback.

```{rubric} Methods
```

{#then-when .member}
**`when`**`(condition:` [`ExprInput`](#exprinput)`):` [`Next`](#next)`<T>` [¶](#then-when){.headerlink}
: Adds a case, tried when no earlier condition holds.

{#then-otherwise .member}
**`otherwise`**`(value:` [`InputOf`](#inputof)`<T>): T` [¶](#then-otherwise){.headerlink}
: Sets the value where no condition holds, and returns the finished conditional.

(next)=

### `Next<T>`

{.signature}
`class Next<T extends` [`Expr`](#expr) `|` [`Paint`](#paint)`>`

A conditional's next condition, awaiting its value from `then`.

```{rubric} Methods
```

{#next-then .member}
**`then`**`(value:` [`InputOf`](#inputof)`<T>):` [`Then`](#then)`<T>` [¶](#next-then){.headerlink}
: Sets the value where this condition holds.

(inputof)=

### `InputOf<T>`

{.signature}
`type InputOf<T> = T extends` [`Paint`](#paint) `?` [`PaintInput`](#paintinput) `:` [`ExprInput`](#exprinput)

A conditional's value input: [`PaintInput`](#paintinput) for colors, else [`ExprInput`](#exprinput).

(px-function)=

### `px()`

{.signature}
`function px(size: number): { px: number }`

{.signature}
`function px(size:` [`ExprInput`](#exprinput)`):` [`Px`](#px)

A size in CSS pixels regardless of the space's unit, so it stays the same on screen as the view
zooms: `px(1)` keeps a diagram's stroke 1 pixel wide at any zoom. Given a number, the result also
works as a theme length.

(units-function)=

### `units()`

{.signature}
`function units(size: number): { units: number }`

{.signature}
`function units(size:` [`ExprInput`](#exprinput)`, within?:` [`Within`](#within)`):` [`Units`](#units)

A size in position units (degrees on the earth) regardless of the space's unit, so it scales as
the view zooms. `within` limits its on-screen size in CSS pixels: `units('r', { atLeast: 2 })`
grows with the map and never shrinks below 2 pixels. A marker keeps its proportions, with the
limits applied to its larger side. Given only a number, the result also works as a theme length.

(within)=

### `Within`

{.signature}
`interface Within`

On-screen limits, in CSS pixels, for a size given in position units.

{#within-atleast .member}
**`atLeast`**`?: number` [¶](#within-atleast){.headerlink}
: The smallest size in CSS pixels, however far the view zooms out.

{#within-atmost .member}
**`atMost`**`?: number` [¶](#within-atmost){.headerlink}
: The largest size in CSS pixels, however far the view zooms in.

(selected)=

### `selected()`

{.signature}
`function selected():` [`Expr`](#expr)

Whether the row is selected.

(hovered)=

### `hovered()`

{.signature}
`function hovered():` [`Expr`](#expr)

Whether the pointer is over the row.

(pointer)=

### `pointer()`

{.signature}
`function pointer():` [`Expr`](#expr)

CSS pixels from a vertex to the pointer. Vertex marks only, and not in a vertex's position.

(zoom-function)=

### `zoom()`

{.signature}
`function zoom():` [`Expr`](#expr)

The camera's zoom: the web mercator level on the earth, log₂ CSS pixels per unit elsewhere.

(elapsed)=

### `elapsed()`

{.signature}
`function elapsed():` [`Expr`](#expr)

Seconds since the view was created. A mark that reads it redraws every frame.

(icon)=

### `icon()`

{.signature}
`function icon(images: readonly` [`RgbaImage`](#rgbaimage)`[], index:` [`ExprInput`](#exprinput)`):` [`Marker`](#marker)

An icon marker: each row shows `images[index]`, fitted in the marker's box, with `index` counting
from 0. The pixels are copied into the marker.

(rgbaimage)=

### `RgbaImage`

{.signature}
`interface RgbaImage`

RGBA pixels with straight alpha, rows top to bottom. A browser `ImageData` has this shape.

{#rgbaimage-width .member}
**`width`**`: number` [¶](#rgbaimage-width){.headerlink}
: The width in pixels.

{#rgbaimage-height .member}
**`height`**`: number` [¶](#rgbaimage-height){.headerlink}
: The height in pixels.

{#rgbaimage-data .member}
**`data`**`: Uint8ClampedArray` [¶](#rgbaimage-data){.headerlink}
: 4 bytes per pixel, red, green, blue, and alpha, row after row.

(colormapcss)=

### `colormapCss()`

{.signature}
`function colormapCss(map:` [`Colormap`](#colormap)`, direction?: string): string`

Returns a CSS `linear-gradient(...)` with the colors the GPU draws for `map`, a catalog name or a
custom colormap. `direction` is the gradient's CSS direction, `'to right'` by default. A
categorical map gives one solid band per category. Needs `await load()` first, and throws an
`invalid` error for an invalid `map`.

## Views

A GPU makes views, and canvases that show them.

(gpu)=

### `Gpu`

{.signature}
`class Gpu`

A WebGPU device that views draw with. The views and canvases of one `Gpu` share its memory and
draw together in each animation frame, so linked views always show the same moment.

```{rubric} Properties
```

{#gpu-lost .member}
`readonly` **`lost`**`: boolean` [¶](#gpu-lost){.headerlink}
: Whether the device was lost. Drawing then does nothing; create a new [`Gpu`](#gpu).

{#gpu-budget .member}
**`budget`**`:` [`Budget`](#budget) [¶](#gpu-budget){.headerlink}
: The GPU memory budget for data, shared by every view of this GPU; see [`Budget`](#budget). Defaults
  to half the device's largest storage buffer, and 32 MiB uploaded per frame.

{#gpu-work .member}
`readonly` **`work`**`:` [`Work`](#work) [¶](#gpu-work){.headerlink}
: Exact counts of the work this GPU has done since it was created; see [`Work`](#work). The counts
  repeat for the same budget, device limits, and frames, so tests and benchmarks can assert them.

{#gpu-resident .member}
`readonly` **`resident`**`: number` [¶](#gpu-resident){.headerlink}
: Bytes of GPU memory the views of this GPU draw from: data pages, and each view's per-row data.

{#gpu-uploading .member}
`readonly` **`uploading`**`: number` [¶](#gpu-uploading){.headerlink}
: Bytes waiting to upload to the GPU, across every view of this GPU.

```{rubric} Methods
```

{#gpu-create .member}
`static` **`create`**`(): Promise<Gpu>` [¶](#gpu-create){.headerlink}
: Requests a WebGPU device, calling [`load()`](#load) first. The first call reuses the device that
  `load()` requested. Rejects with an `unsupported` error when the browser has no WebGPU device.

{#gpu-view .member}
**`view`**`(scene:` [`Scene`](#scene)`, options?:` [`ViewOptions`](#viewoptions)`):` [`View`](#view) [¶](#gpu-view){.headerlink}
: Creates a view that draws `scene` from the datasets in `options.sources`. Show it in a
  [`Canvas`](#canvas), or draw it into pictures with a `Shot`, with or without a canvas. Throws an
  `invalid` error for an invalid scene.

{#gpu-canvas .member}
**`canvas`**`(target: HTMLCanvasElement | OffscreenCanvas, options?:` [`CanvasOptions`](#canvasoptions)`):` [`Canvas`](#canvas) [¶](#gpu-canvas){.headerlink}
: Creates a canvas that shows views in `target`, placed by `options.layout`. A `<canvas>` element
  sizes itself to its CSS box at the device pixel ratio, and passes pointer, wheel, and key input
  to the views in its panels. An `OffscreenCanvas`, as in a worker, keeps the size it is given at
  `options.pixelRatio` pixels per CSS pixel, and takes no input. Throws an `invalid` error for an
  invalid layout, such as a view already shown in another panel.

{#gpu-on .member}
**`on`**`(type: 'frame', listener: (now: number) => void): () => void` [¶](#gpu-on){.headerlink}
: Calls `listener` every animation frame with the frame's timestamp in milliseconds, before the
  views draw, so changes it makes show in that frame. While any listener is registered, a frame
  runs every animation frame. Returns a function that removes the listener.

{#gpu-step .member}
**`step`**`(now: number): void` [¶](#gpu-step){.headerlink}
: Draws one frame immediately at time `now`, in milliseconds on the `requestAnimationFrame`
  clock: it runs the frame listeners, then draws every canvas that needs a frame. After the first
  call, this GPU stops requesting animation frames. A test or benchmark that steps every frame
  itself then draws the same frames on any device.

{#gpu-done .member}
**`done`**`(wait?:` [`Wait`](#wait)`): Promise<void>` [¶](#gpu-done){.headerlink}
: Resolves once the GPU has finished all submitted work, every readback has arrived, and every
  pipeline a view or shot requested has compiled. A frame stepped after that uses all of it.

{#gpu-landed .member}
**`landed`**`(wait?:` [`Wait`](#wait)`): Promise<void>` [¶](#gpu-landed){.headerlink}
: Resolves when, after this call, work a view is waiting on arrives (a readback, a pipeline
  compile, a job, a label text, or a fetch), or a view requests a frame. A harness that steps
  frames awaits it to know when to step again.

{#gpu-destroy .member}
**`destroy`**`(): void` [¶](#gpu-destroy){.headerlink}
: Destroys this GPU's canvases, views, and frame listeners, then frees the device. Other GPUs and
  datasets stay usable. Calling it again does nothing; other methods throw afterwards.

{#gpu-symbol-dispose .member}
**`[Symbol.dispose]`**`(): void` [¶](#gpu-symbol-dispose){.headerlink}
: Calls [`Gpu.destroy()`](#gpu-destroy), so a `using` declaration destroys it when its block ends.

(view)=

### `View`

{.signature}
`class View`

A scene drawn from its sources; created by [`Gpu.view()`](#gpu-view). A canvas shows it and passes it input,
and a [`Shot`](#shot) draws it into pictures.

```{rubric} Properties
```

{#view-scene .member}
**`scene`**`:` [`Scene`](#scene) [¶](#view-scene){.headerlink}
: The scene drawn. Marks that match a mark of the previous scene by kind, dataset, table, and
  name keep their state and ease to their new options. Setting an invalid scene throws an
  `invalid` error and keeps the current one.

{#view-sources .member}
**`sources`**`: readonly` [`Source`](#source)`[]` [¶](#view-sources){.headerlink}
: The datasets the view draws, matched to marks by dataset name. The view draws a [`Data`](#data) at its
  latest version, from the frame after each patch; a [`Snapshot`](#snapshot) unchanged; and [`Tiles`](#tiles) as the
  pieces it needs. A mark whose dataset no longer fits it draws nothing; it is listed in
  `failures`, and the next frame emits an `error` event. Setting two sources with the same name
  throws an `invalid` error.

{#view-at .member}
**`at`**`: number` [¶](#view-at){.headerlink}
: The axis coordinate shown, such as a time. Marks read sampled fields at it, interpolating
  between the frame at or before it and the next, unless an expression uses `step()`.

{#view-camera .member}
**`camera`**`:` [`Camera`](#camera) [¶](#view-camera){.headerlink}
: Where the view looks. Setting it moves the camera at once; use [`View.fly()`](#view-fly) to ease. A
  camera of the wrong kind for the space, such as a plot camera on a map, is ignored.

{#view-insets .member}
**`insets`**`:` [`Insets`](#insets) [¶](#view-insets){.headerlink}
: CSS pixels kept clear at the top, right, bottom, and left, such as where page panels cover the
  view. The camera centers and fits within the rest.

{#view-orbit .member}
**`orbit`**`: number` [¶](#view-orbit){.headerlink}
: Degrees per second the camera turns about its center on a map or plane; 0 stops it. A diagram
  never turns.

{#view-selection .member}
**`selection`**`: readonly` [`Rows`](#rows)`[]` [¶](#view-selection){.headerlink}
: The selected rows, one set per table. Setting it selects exactly those rows.

{#view-hovered .member}
`readonly` **`hovered`**`:` [`Hit`](#hit) `| null` [¶](#view-hovered){.headerlink}
: The row under the pointer, or the row keyboard navigation moved to; `null` if none.

{#view-waiting .member}
`readonly` **`waiting`**`:` [`Waiting`](#waiting) [¶](#view-waiting){.headerlink}
: The kinds of pending work that kept the last frame from being complete; empty when it was
  complete. See [`Waiting`](#waiting).

{#view-complete .member}
`readonly` **`complete`**`: boolean` [¶](#view-complete){.headerlink}
: Whether the last frame was complete, with nothing in `waiting` pending. Shots wait for it.

{#view-failures .member}
`readonly` **`failures`**`: readonly` [`LatkitError`](#latkiterror)`[]` [¶](#view-failures){.headerlink}
: An error for each mark that draws nothing because its data no longer fits it, such as a missing
  table. Each error's `path` names the mark.

{#view-stats .member}
`readonly` **`stats`**`:` [`Stats`](#stats) [¶](#view-stats){.headerlink}
: Counts and timings of the view's frames; see [`Stats`](#stats).

{#view-wantsframe .member}
`readonly` **`wantsFrame`**`: boolean` [¶](#view-wantsframe){.headerlink}
: Whether the view needs a frame, because it changed or work it was waiting on arrived.

```{rubric} Methods
```

{#view-fit .member}
**`fit`**`(fit?:` [`Fit`](#fit)`): void` [¶](#view-fit){.headerlink}
: Frames what `fit` names, every row by default, keeping pitch and bearing. It takes effect on
  the next frame, or a frame or two later when the extent must be measured on the GPU.

{#view-fly .member}
**`fly`**`(camera:` [`Camera`](#camera)`): void` [¶](#view-fly){.headerlink}
: Eases the camera to `camera` over twice the scene's ease time, or at once when motion is
  reduced. A camera of the wrong kind for the space is ignored.

{#view-screen .member}
**`screen`**`(position:` [`Position`](#position)`):` [`Point`](#point) `| null` [¶](#view-screen){.headerlink}
: Projects `position` to a point on screen with the current camera, for anchoring HTML overlays;
  `null` when it is behind the camera.

{#view-position .member}
**`position`**`(point:` [`Point`](#point)`):` [`Position`](#position) `| null` [¶](#view-position){.headerlink}
: The position on the ground under screen point `point`: at elevation 0 on a plane, on the map or
  globe on the earth, the values there on a plot. `null` where the point looks past the ground.

{#view-screenof .member}
**`screenOf`**`(row:` [`Row`](#row)`, wait?:` [`Wait`](#wait)`): Promise<`[`Point`](#point) `| null>` [¶](#view-screenof){.headerlink}
: Resolves to where `row` is on screen once a frame draws the view, or `null` when no mark draws
  it in view. A diagram's vertices resolve at once.

{#view-pick .member}
**`pick`**`(point:` [`Point`](#point)`, options?: { radius?: number } &` [`Wait`](#wait)`): Promise<`[`Hit`](#hit)`[]>` [¶](#view-pick){.headerlink}
: Resolves, once a frame draws the view, to every row of a pickable mark within `options.radius`
  CSS pixels (0 by default) of `point`, nearest first.

{#view-neighbors .member}
**`neighbors`**`(row:` [`Row`](#row)`):` [`Rows`](#rows)`[]` [¶](#view-neighbors){.headerlink}
: The rows connected to `row`, one set per table: a vertex's neighbors across edges and nets, or
  an edge's or a net's vertices. The cost is proportional to the row's degree.

{#view-arrange .member}
**`arrange`**`(wait?:` [`Wait`](#wait)`): Promise<`[`Patch`](#patch)`[]>` [¶](#view-arrange){.headerlink}
: Runs the scene's layout again for every vertex row without a position: a diagram's blocks, or
  points on a plane or the earth. Otherwise a layout keeps the places it gave, so rows added
  later are placed around the rest. Resolves, once the layout finishes, to one patch per dataset
  that writes each laid-out row's place into its mark's position fields. Applying the patches
  makes the places part of the data. Marks whose position is not read from fields are left out.

  ```ts
  for (const patch of await view.arrange()) if (patch.data === grid.name) grid.apply(patch);
  ```

{#view-snapshot .member}
**`snapshot`**`(name: string):` [`Snapshot`](#snapshot) `| undefined` [¶](#view-snapshot){.headerlink}
: The version of dataset `name` the view draws, or `undefined` if it draws none of that name: the
  latest version of a [`Data`](#data) the view has taken, a given snapshot, or the pieces of [`Tiles`](#tiles)
  fetched for its camera.

{#view-on .member}
**`on`**`<T extends keyof` [`ViewEvents`](#viewevents)`>(type: T, listener: (event:` [`ViewEvents`](#viewevents)`[T]) => void): () => void` [¶](#view-on){.headerlink}
: Calls `listener` with each event of `type` emitted while it is registered, and returns a
  function that removes it. Past events are not replayed; read the current state from the
  property a change event is named after.

{#view-destroy .member}
**`destroy`**`(): void` [¶](#view-destroy){.headerlink}
: Frees the view and rejects its unanswered queries. A canvas showing it keeps its last frame.
  Calling it again does nothing; other methods throw afterwards.

{#view-symbol-dispose .member}
**`[Symbol.dispose]`**`(): void` [¶](#view-symbol-dispose){.headerlink}
: Calls [`View.destroy()`](#view-destroy), so a `using` declaration destroys it when its block ends.

(viewoptions)=

### `ViewOptions`

{.signature}
`interface ViewOptions`

Options for [`Gpu.view()`](#gpu-view).

{#viewoptions-sources .member}
**`sources`**`?: readonly` [`Source`](#source)`[]` [¶](#viewoptions-sources){.headerlink}
: The datasets the scene draws; see [`View.sources`](#view-sources).

(viewevents)=

### `ViewEvents`

{.signature}
`type ViewEvents = { [E in` [`ViewEvent`](#viewevent) `as E['type']]: E extends { type: 'error' } ?` [`LatkitError`](#latkiterror) `: E['detail'] }`

The events a view emits, by type, mapped to each event's detail. Intents (`click`, `open`,
`menu`, `drag`, `connect`, `delete`) are emitted once each, in the order the user acted. Changes
(`hovered`, `selection`, `camera`, `waiting`) are named after the property that changed and carry
only its latest value. An `error` event's detail is a [`LatkitError`](#latkiterror). Setters emit nothing,
so events report only what the application did not do itself.

(insets)=

### `Insets`

{.signature}
`type Insets = [top: number, right: number, bottom: number, left: number]`

CSS pixels kept clear at the top, right, bottom, and left.

(point)=

### `Point`

{.signature}
`type Point = [x: number, y: number]`

A point on screen, in CSS pixels from the view's top left corner.

(position)=

### `Position`

{.signature}
`type Position = [x: number, y: number, elevation: number]`

A position in the space's coordinates: x, y, and elevation. On the earth, x and y are longitude
and latitude; on a plot, the axis coordinate and the value.

(canvas)=

### `Canvas`

{.signature}
`class Canvas`

Shows views in a `<canvas>` element or an `OffscreenCanvas`, each in its layout panel; created by
[`Gpu.canvas()`](#gpu-canvas). A frame redraws only the views that need it, or every view after a resize or a
layout change.

```{rubric} Properties
```

{#canvas-element .member}
`readonly` **`element`**`: HTMLCanvasElement | OffscreenCanvas` [¶](#canvas-element){.headerlink}
: The `<canvas>` element or `OffscreenCanvas` it draws into.

{#canvas-layout .member}
**`layout`**`: readonly` [`Panel`](#panel)`[]` [¶](#canvas-layout){.headerlink}
: The views shown and their regions; later panels draw over earlier ones. Setting it replaces the
  shown views. A view can show in only one panel of one canvas at a time. Setting a layout that
  breaks this, or that has a panel covering no pixels, throws an `invalid` error.

```{rubric} Methods
```

{#canvas-shot .member}
**`shot`**`(options?:` [`ShotOptions`](#shotoptions)`):` [`Shot`](#shot) [¶](#canvas-shot){.headerlink}
: Returns a [`Shot`](#shot) of exactly what the canvas shows: its views in its layout, at the
  canvas's CSS size times `options.scale` (1 by default) in pixels.

{#canvas-destroy .member}
**`destroy`**`(): void` [¶](#canvas-destroy){.headerlink}
: Stops drawing and frees the canvas. The views stay usable, and the element keeps its last
  frame. Calling it again does nothing.

{#canvas-symbol-dispose .member}
**`[Symbol.dispose]`**`(): void` [¶](#canvas-symbol-dispose){.headerlink}
: Calls [`Canvas.destroy()`](#canvas-destroy), so a `using` declaration destroys it when its block ends.

(canvasoptions)=

### `CanvasOptions`

{.signature}
`interface CanvasOptions`

Options for [`Gpu.canvas()`](#gpu-canvas).

{#canvasoptions-layout .member}
**`layout`**`?: readonly` [`Panel`](#panel)`[]` [¶](#canvasoptions-layout){.headerlink}
: The views shown and their regions; later panels draw over earlier ones. None by default.

{#canvasoptions-pixelratio .member}
**`pixelRatio`**`?: number` [¶](#canvasoptions-pixelratio){.headerlink}
: Pixels per CSS pixel of an `OffscreenCanvas`, 1 by default; it must be positive. A `<canvas>`
  element uses the device pixel ratio instead.

(panel)=

### `Panel`

{.signature}
`interface Panel`

A view and the region of a canvas or picture it draws in.

{#panel-view .member}
**`view`**`:` [`View`](#view) [¶](#panel-view){.headerlink}
: The view drawn.

{#panel-at .member}
**`at`**`?:` [`Rect`](#rect) [¶](#panel-at){.headerlink}
: Where the view draws; the whole canvas or picture by default.

(rect)=

### `Rect`

{.signature}
`type Rect = readonly [x: number, y: number, width: number, height: number]`

A region `[x, y, width, height]` in fractions of a canvas or picture, from its top left.

## Pictures and video

Shots draw views into images and video.

(shot)=

### `Shot`

{.signature}
`class Shot`

A picture of views, `size` pixels in all, each view drawn into its layout panel. While a shot
draws a view, a canvas showing that view keeps its last frame. An image draws each view's data as
it was when the picture began. A canvas's `shot()` makes a shot of what the canvas shows.

```ts
const png = await (await canvas.shot({ scale: 2 }).image()).encode('png');
```

```{rubric} Constructor
```

{#shot-new .member}
**`new Shot`**`(size: readonly [number, number], options?:` [`ShotOptions`](#shotoptions) `& { layout?: readonly` [`Panel`](#panel)`[] })` [¶](#shot-new){.headerlink}
: Creates a shot of `size`, `[width, height]` in pixels, of the views in `options.layout`.

```{rubric} Properties
```

{#shot-size .member}
`readonly` **`size`**`: readonly [number, number]` [¶](#shot-size){.headerlink}
: The picture's size, `[width, height]` in pixels.

{#shot-options .member}
`readonly` **`options`**`:` [`ShotOptions`](#shotoptions) `& { layout?: readonly` [`Panel`](#panel)`[] }` [¶](#shot-options){.headerlink}
: How the picture is taken, and in `layout`, the panel each view is drawn into.

```{rubric} Methods
```

{#shot-image .member}
**`image`**`(wait?:` [`Wait`](#wait)`): Promise<`[`Image`](#image)`>` [¶](#shot-image){.headerlink}
: Draws the picture once every view is complete, as `capture` says, and resolves to the
  [`Image`](#image). Rejects with an `invalid` error for invalid options or a view in two panels, and
  with the first error a view reports while drawing.

{#shot-video .member}
**`video`**`(options: { fps: number; output: WritableStream<Uint8Array>; bitrate?: number } &` [`Wait`](#wait)`):` [`Video`](#video) [¶](#shot-video){.headerlink}
: Starts a video of this shot: H.264 in MP4 at `options.fps` frames per second, written to
  `options.output` as frames are drawn. `options.bitrate` is in bits per second, about 0.15 bits
  per pixel per frame by default. The width is rounded down to a multiple of 4 and the height to a
  multiple of 2, as the encoder requires. Canvases showing the views keep their last frame until
  the video finishes or aborts. Aborting `options.signal` aborts the video and its output; frames
  have no other time limit.

(shotoptions)=

### `ShotOptions`

{.signature}
`interface ShotOptions`

Options for a [`Shot`](#shot).

{#shotoptions-scale .member}
**`scale`**`?: number` [¶](#shotoptions-scale){.headerlink}
: Pixels per CSS pixel, 1 by default. Views lay out at `size / scale` CSS pixels, so 2 draws the
  same layout twice as sharp.

{#shotoptions-transparent .member}
**`transparent`**`?: boolean` [¶](#shotoptions-transparent){.headerlink}
: Leaves the background transparent where the theme's background color would be.

{#shotoptions-capture .member}
**`capture`**`?: 'still' | 'now'` [¶](#shotoptions-capture){.headerlink}
: When the picture is taken. `'still'`, the default, waits until every view is complete and
  still: transitions, camera flights, and label fades run until they finish. `'now'` waits only
  until every view is complete, and freezes anything moving where it is.

{#shotoptions-elapsed .member}
**`elapsed`**`?: number` [¶](#shotoptions-elapsed){.headerlink}
: The time in seconds that [`elapsed()`](#elapsed) expressions and flowing comets show in a still picture. By
  default they follow the view's clock.

(image)=

### `Image`

{.signature}
`class Image`

A picture's RGBA pixels, with straight alpha, rows top to bottom.

```{rubric} Properties
```

{#image-width .member}
`readonly` **`width`**`: number` [¶](#image-width){.headerlink}
: Width in pixels.

{#image-height .member}
`readonly` **`height`**`: number` [¶](#image-height){.headerlink}
: Height in pixels.

{#image-rgba .member}
`readonly` **`rgba`**`: Uint8Array` [¶](#image-rgba){.headerlink}
: A copy of the pixels: 4 bytes per pixel, `width * height * 4` bytes in all.

```{rubric} Methods
```

{#image-encode .member}
**`encode`**`(format:` [`ImageFormat`](#imageformat)`, options?: { quality?: number } &` [`Wait`](#wait)`): Promise<Uint8Array>` [¶](#image-encode){.headerlink}
: Encodes the image as a file, in a worker. PNG is lossless with alpha. JPEG uses
  `options.quality` from 1 to 100 (90 by default) and drops alpha. WebP is lossless with alpha
  and smaller than PNG. Rejects with an `invalid` error for a quality outside 1 to 100 or an
  unknown format.

{#image-destroy .member}
**`destroy`**`(): void` [¶](#image-destroy){.headerlink}
: Frees the pixels. Other methods throw afterwards.

{#image-symbol-dispose .member}
**`[Symbol.dispose]`**`(): void` [¶](#image-symbol-dispose){.headerlink}
: Calls [`Image.destroy()`](#image-destroy), so a `using` declaration destroys it when its block ends.

(imageformat)=

### `ImageFormat`

{.signature}
`type ImageFormat = 'png' | 'jpeg' | 'webp'`

An image file format for [`Image.encode()`](#image-encode).

(video)=

### `Video`

{.signature}
`class Video`

A video being drawn, encoded, and written; created by [`Shot.video()`](#shot-video). Draw frames with
[`Video.frame()`](#video-frame) or [`Video.record()`](#video-record), then call [`Video.finish()`](#video-finish).

```{rubric} Properties
```

{#video-time .member}
`readonly` **`time`**`: number` [¶](#video-time){.headerlink}
: The time in seconds at which the next frame shows. Still readable after the video ends.

{#video-frames .member}
`readonly` **`frames`**`: number` [¶](#video-frames){.headerlink}
: Frames recorded so far, including frames repeated because nothing moved. Still readable after
  the video ends.

```{rubric} Methods
```

{#video-frame .member}
**`frame`**`(): Promise<void>` [¶](#video-frame){.headerlink}
: Draws the next frame once its views are complete, and writes its bytes, waiting on the
  output's backpressure. Calls must not overlap: a call made before the previous one resolves,
  or after `finish()`, rejects with an `invalid` error, and a call after `abort()` with a
  `cancelled` error. A failure aborts the video.

{#video-record .member}
**`record`**`(step: (time: number) => boolean | Promise<boolean>, onProgress?: (progress: { frames: number; time: number }) => void): Promise<void>` [¶](#video-record){.headerlink}
: Records frames until `step(time)` returns false, then finishes the video. `step` gets the next
  frame's time in seconds and can change the views before that frame is drawn. `onProgress` is
  called after each frame. An error from `step`, drawing, the output, or `onProgress` aborts the
  video and is rethrown.

{#video-finish .member}
**`finish`**`(): Promise<void>` [¶](#video-finish){.headerlink}
: Waits for the frame in progress, encodes the remaining frames, writes the end of the file, and
  closes and unlocks the output. Later calls return the same promise. Rejects with a `cancelled`
  error if the video was aborted.

{#video-abort .member}
**`abort`**`(reason?: unknown): Promise<void>` [¶](#video-abort){.headerlink}
: Cancels drawing and encoding, aborts the output with `reason`, and unlocks it once pending
  writes settle. Later calls return the same promise. After `finish()` completes, it does
  nothing.
