# JavaScript API

Every class, function, and type the `latkit` package exports. Scenes and their options take the
[scene and result types](types.md). Four rules hold throughout, so the entries below leave them
out:

- **Loading.** Scenes, expressions, and patches are plain data. Datasets, views, pictures, and the
  colormap functions need latkit's WebAssembly: until [`load()`](#load) finishes, they throw an
  `unloaded` error. [`View.create()`](#view-create), [`Gpu.create()`](#gpu-create), [`Data.read()`](#data-read), and [`Patch.read()`](#patch-read) of
  JSON load it themselves.
- **Errors.** Everything latkit throws or rejects with is a [`LatkitError`](#latkiterror). Input it cannot use
  fails with an `invalid` error whose `path` names the part, such as `marks[2].color`, and
  changes nothing.
- **Waits.** Every promise waits within its [`Wait`](#wait): until its `signal` aborts, or 30 seconds.
- **Lifetimes.** A [`Handle`](#handle) holds memory until `destroy()`, or a `using` declaration, frees it.

## Loading, errors, and lifetimes

What every part of the package shares.

(load)=

### `load()`

{.signature}
`function load(options?: { wasm?: string | URL | WebAssembly.Module; worker?: () => Worker }): Promise<void>`

Loads latkit's WebAssembly, once per page. Later and concurrent calls share the first call's
load; options they pass must equal the first call's, or they reject with an `io` error. A failed
load rejects with an `io` error and can be retried. `load()` also requests a GPU adapter while
the WebAssembly compiles, so the browser starts its GPU process early, then the first device for
[`Gpu.create()`](#gpu-create).

{#load-wasm .member}
**`wasm`**`?: string | URL | WebAssembly.Module` [¶](#load-wasm){.headerlink}
: The URL of this version's `latkit/wasm` asset, or that asset compiled; bundled by default.

{#load-worker .member}
**`worker`**`?: () => Worker` [¶](#load-worker){.headerlink}
: Creates a worker running the standalone `latkit/worker` bundle; bundled by default.

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
: The invalid part of the input, such as `marks[2].color`, on `invalid` errors.

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

(handle)=

### `Handle`

{.signature}
`abstract class Handle`

An object that holds WebAssembly memory, and GPU memory for a [`Gpu`](#gpu), until it is destroyed:
`destroy()` frees it, as does a `using` declaration when its block ends. Once it is destroyed,
its other methods throw a `destroyed` error.

```{rubric} Methods
```

{#handle-destroy .member}
**`destroy`**`(): void` [¶](#handle-destroy){.headerlink}
: Frees the object's memory. Calling it again does nothing.

## Data and patches

Datasets of named tables, their tables that marks draw, and the patches that change them, written without WebAssembly.

(dataset)=

### `Dataset`

{.signature}
`abstract class Dataset extends` [`Handle`](#handle)

Named tables of columns, read the same way from a [`Data`](#data), which reads its current version,
and a [`Snapshot`](#snapshot), which reads its own.

```{rubric} Properties
```

{#dataset-name .member}
`readonly` **`name`**`: string` [¶](#dataset-name){.headerlink}
: The dataset's name: the first part of its tables' JSON form.

```{rubric} Methods
```

{#dataset-table .member}
**`table`**`(name: string):` [`Table`](#table) [¶](#dataset-table){.headerlink}
: The dataset's table `name`, for a mark to draw or a field to read from.

{#dataset-describe .member}
**`describe`**`():` [`Description`](#description) [¶](#dataset-describe){.headerlink}
: The tables and their row counts, each field and its kind, and the axis and its span.

{#dataset-get .member}
**`get`**`(table: string, id:` [`Id`](#id)`, field: string, options?: { at?: number }):` [`Value`](#value) [¶](#dataset-get){.headerlink}
: Reads `field` of the row with `id` in `table`: for a sampled field, its last frame at or before
  `options.at`, or its last frame; for a reference, the referenced row's id. `null` when the
  table, row, field, or value is missing.

  {#dataset-get-at .member}
  **`at`**`?: number` [¶](#dataset-get-at){.headerlink}
  : The axis coordinate to read a sampled field at.

{#dataset-query .member}
**`query`**`(query:` [`Query`](#query)`):` [`QueryResult`](#queryresult) [¶](#dataset-query){.headerlink}
: Reads a table's rows, filtered, sorted, and paged, through the same expressions marks use.
  Sampled fields are read at [`query.at`](#query-at).

{#dataset-envelope .member}
**`envelope`**`(request:` [`EnvelopeRequest`](#enveloperequest)`):` [`Envelope`](#envelope) [¶](#dataset-envelope){.headerlink}
: Each row's minimum and maximum of a sampled field over equal spans of an axis range, for every
  row or the rows `request.ids` lists. Each span reads the coarsest stored levels of detail that
  fit in it, so it costs a few reads however many frames it covers. Throws a `limit` error when
  rows times spans exceeds 2^26.

{#dataset-tobytes .member}
**`toBytes`**`(): Uint8Array` [¶](#dataset-tobytes){.headerlink}
: The dataset as latkit's bytes: a patch that builds it from an empty dataset.

(data)=

### `Data`

{.signature}
`class Data extends` [`Dataset`](#dataset)

A dataset that changes in place, each change applied whole or not at all. Each method of
[`Patch`](#patch) is also a method here that applies that one change at once; `apply` applies a patch
of several. Views draw its latest version from the frame after each change. A [`Snapshot`](#snapshot)
keeps one version and shares its pages with the dataset, so an undo history costs only the pages
that differ. Destroying it leaves views drawing it and its snapshots usable.

```ts
const grid = new Data('grid').set('Bus', [1, 2], { kv: [230, 115] });
grid.set('Bus', [2], { kv: [69] }); // drawn the next frame
```

```{rubric} Constructor
```

{#data-new .member}
**`new Data`**`(name: string)` [¶](#data-new){.headerlink}
: Creates an empty dataset named `name`.

```{rubric} Methods
```

{#data-read .member}
`static` **`read`**`(source:` [`ByteSource`](#bytesource) `| object, options?: { name?: string; base?: string } &` [`Wait`](#wait)`): Promise<Data>` [¶](#data-read){.headerlink}
: Reads a dataset from `source`. Its first bytes decide the format:

  - latkit's bytes, as `toBytes()` writes them.
  - GeoJSON, plain or gzip-compressed, read in a worker. Points, line strings, and polygons
    become rows of tables `points`, `lines`, and `polygons`, with the geometry in field
    `geometry` and each property as a field.
  - A dataset document, `{"name": ..., "patch": [...]}`, whose patch is read as
    [`Patch.read()`](#patch-read) reads one.

  {#data-read-name .member}
  **`name`**`?: string` [¶](#data-read-name){.headerlink}
  : Names the dataset, replacing the name its bytes or document give; GeoJSON requires it.

  {#data-read-base .member}
  **`base`**`?: string` [¶](#data-read-base){.headerlink}
  : The URL a document's file slices are relative to; by default, the one it came from.

{#data-apply .member}
**`apply`**`(patch:` [`Patch`](#patch) `| Uint8Array): this` [¶](#data-apply){.headerlink}
: Applies every change in `patch`, or none when one is invalid, and returns this dataset. An
  `invalid` error's `path` names the failing change, such as `patch[1].Bus.kv`.

{#data-axis .member}
**`axis`**`(name: string, unit: string): this` [¶](#data-axis){.headerlink}
: Applies [`Patch.axis()`](#patch-axis): names the axis that sampled fields are recorded over.

{#data-replace .member}
**`replace`**`(table: string, fields:` [`Fields`](#fields)`): this` [¶](#data-replace){.headerlink}
: Applies [`Patch.replace()`](#patch-replace): replaces table `table` with rows `ids`, or `0` to `n - 1`, and
  `fields`.

{.member}
**`replace`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this`
: Applies [`Patch.replace()`](#patch-replace): replaces table `table` with rows `ids`, or `0` to `n - 1`, and
  `fields`.

{#data-set .member}
**`set`**`(table: string, fields:` [`Fields`](#fields)`): this` [¶](#data-set){.headerlink}
: Applies [`Patch.set()`](#patch-set): writes `fields` for rows `ids` of `table`, or `0` to `n - 1`, adding
  new rows.

{.member}
**`set`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this`
: Applies [`Patch.set()`](#patch-set): writes `fields` for rows `ids` of `table`, or `0` to `n - 1`, adding
  new rows.

{#data-remove .member}
**`remove`**`(table: string, ids:` [`RowIds`](#rowids)`): this` [¶](#data-remove){.headerlink}
: Applies [`Patch.remove()`](#patch-remove): removes the rows of `table` with `ids`.

{#data-append .member}
**`append`**`(table: string, at: number | readonly number[], fields: Readonly<Record<string,` [`Values`](#values)`>>, options?: { ids?:` [`RowIds`](#rowids) `}): this` [¶](#data-append){.headerlink}
: Applies [`Patch.append()`](#patch-append): records frames of `table` at the axis coordinates `at`.

  {#data-append-ids .member}
  **`ids`**`?:` [`RowIds`](#rowids) [¶](#data-append-ids){.headerlink}
  : The rows the frames cover, every row by default; other rows keep their last values.

{#data-forget .member}
**`forget`**`(before: number): this` [¶](#data-forget){.headerlink}
: Applies [`Patch.forget()`](#patch-forget): drops every sampled field's frames before `before`.

{#data-frames .member}
**`frames`**`(table: string, field: string, run:` [`Run`](#run)`): this` [¶](#data-frames){.headerlink}
: Applies [`Patch.frames()`](#patch-frames): stores a run of a sampled field's entries, as a time tile holds.

{#data-snapshot .member}
**`snapshot`**`():` [`Snapshot`](#snapshot) [¶](#data-snapshot){.headerlink}
: The current version as a [`Snapshot`](#snapshot), which later patches leave unchanged. O(1).

{#data-restore .member}
**`restore`**`(snapshot:` [`Snapshot`](#snapshot)`): this` [¶](#data-restore){.headerlink}
: Makes `snapshot`, a version of this dataset, the current version, as an undo does.

(snapshot)=

### `Snapshot`

{.signature}
`class Snapshot extends` [`Dataset`](#dataset)

One immutable version of a dataset, taken in O(1) by [`Data.snapshot()`](#data-snapshot). A view given a
snapshot draws that version, and keeps drawing it once the snapshot is destroyed.

(tiles)=

### `Tiles`

{.signature}
`class Tiles`

A dataset fetched in pieces as views need them: plain data, a dataset name and a URL. Each view
draws the pieces its camera and plot window need, and the views of a GPU share them. The first
bytes at `url` decide the kind:

- Time tiles: a `frames.json` manifest as `latkit tile` writes it. A line tracing a sampled field
  fetches the detail its plot window shows; other marks fetch the frames around the view's `at`.
  A span still loading shows the coarser span that contains it.
- Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` URL template. Each
  layer becomes a table of the features its marks draw: polygons for areas, lines for lines,
  points for vertices. A table named `layer:polygons`, `layer:lines`, or `layer:points` holds
  that kind whatever the marks. A tile arriving appends its rows to the view's dataset, which
  keeps the rows of tiles it no longer draws until they outnumber the rows it draws.

```{rubric} Constructor
```

{#tiles-new .member}
**`new Tiles`**`(name: string, url: string)` [¶](#tiles-new){.headerlink}
: Tiles at `url`, drawn as the dataset named `name`.

```{rubric} Properties
```

{#tiles-name .member}
`readonly` **`name`**`: string` [¶](#tiles-name){.headerlink}
: The name of the dataset the tiles are drawn as.

{#tiles-url .member}
`readonly` **`url`**`: string` [¶](#tiles-url){.headerlink}
: Where the tiles are.

```{rubric} Methods
```

{#tiles-table .member}
**`table`**`(name: string):` [`Table`](#table) [¶](#tiles-table){.headerlink}
: The tiles' table `name`, such as a vector tile layer, for a mark to draw.

(source)=

### `Source`

{.signature}
`type Source =` [`Data`](#data) `|` [`Snapshot`](#snapshot) `|` [`Tiles`](#tiles)

A dataset a view draws: the one a [`Table`](#table) belongs to, or one of the view's `sources`.

(table)=

### `Table`

{.signature}
`class Table`

A table of a dataset, which a mark draws or a field reads from: `grid.table('Bus')`. A view draws
the datasets its scene's tables belong to. Its JSON form is `[data, table]`.

```{rubric} Constructor
```

{#table-new .member}
**`new Table`**`(source:` [`Source`](#source)`, name: string)` [¶](#table-new){.headerlink}
: Table `name` of `source`.

```{rubric} Properties
```

{#table-source .member}
`readonly` **`source`**`:` [`Source`](#source) [¶](#table-source){.headerlink}
: The dataset the table belongs to.

{#table-name .member}
`readonly` **`name`**`: string` [¶](#table-name){.headerlink}
: The table's name.

```{rubric} Methods
```

{#table-tojson .member}
**`toJSON`**`(): [data: string, table: string]` [¶](#table-tojson){.headerlink}
: The JSON form, `[data, table]`, which `JSON.stringify` writes for the table.

(tableinput)=

### `TableInput`

{.signature}
`type TableInput =` [`Table`](#table) `| readonly [data: string, table: string]`

A table that a mark draws or a field reads from: a dataset's [`Table`](#table), or its JSON form
`[data, table]`, which names a dataset the view's `sources` give.

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
: Each row's minimum in each span, `spans` values per row, row after row; NaN without frames.

{#envelope-greatest .member}
**`greatest`**`: Float32Array` [¶](#envelope-greatest){.headerlink}
: Each row's maximum in each span, laid out like `least`.

(patch)=

### `Patch`

{.signature}
`class Patch`

A list of changes to a dataset, which [`Data.apply`](#data-apply) applies in order, all or none. It is written
as latkit's bytes as it is built, without WebAssembly; each method adds a change and returns the
patch.

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
`static` **`read`**`(source:` [`ByteSource`](#bytesource) `| object, options?: { base?: string; limit?: number } &` [`Wait`](#wait)`): Promise<Patch>` [¶](#patch-read){.headerlink}
: Reads a patch from `source`: latkit's bytes, one frame as `toBytes()` writes it, or JSON that
  any language can write without latkit. The JSON is a list of changes. Each change is keyed by
  its method name and holds the method's parameters by name, such as
  `{"set": {"table": "Bus", "ids": [1], "fields": {"kv": [345]}}}`. A field may be a slice of a
  binary file, `{file, dtype, offset, count}`, fetched at once. Bytes are read without
  WebAssembly.

  {#patch-read-base .member}
  **`base`**`?: string` [¶](#patch-read-base){.headerlink}
  : The URL the JSON's file slices are relative to; by default, the one it came from.

  {#patch-read-limit .member}
  **`limit`**`?: number` [¶](#patch-read-limit){.headerlink}
  : The longest frame in bytes, 256 MiB by default; a longer one fails with a `limit` error.

{#patch-stream .member}
`static` **`stream`**`(stream:` [`ReadableBytes`](#readablebytes) `| AsyncIterable<Uint8Array>, options?: { limit?: number }): AsyncGenerator<Patch>` [¶](#patch-stream){.headerlink}
: Yields each patch in `stream` as soon as its last byte arrives. The stream carries frames back
  to back, such as a response body, a file, or a socket's messages. Besides the current chunk
  and the patches the caller keeps, at most one frame is buffered. Breaking out of the loop
  cancels the stream. Throws an `invalid` error for a stream that ends inside a frame.

  ```ts
  for await (const patch of Patch.stream((await fetch('/feed')).body!)) data.apply(patch);
  ```

  {#patch-stream-limit .member}
  **`limit`**`?: number` [¶](#patch-stream-limit){.headerlink}
  : The longest frame in bytes, at least 12; 256 MiB by default. Each frame states its length
    up front, so a longer one fails with a `limit` error before its body is allocated.

{#patch-axis .member}
**`axis`**`(name: string, unit: string): this` [¶](#patch-axis){.headerlink}
: Sets the name and unit of the axis that sampled fields are recorded over, such as
  `axis('time', 's')`.

{#patch-replace .member}
**`replace`**`(table: string, fields:` [`Fields`](#fields)`): this` [¶](#patch-replace){.headerlink}
: Replaces table `table` with rows `ids` and `fields`, adding the table if it does not exist.
  Without ids, the rows are `0` to `n - 1`, `n` being the length of each field's values.

{.member}
**`replace`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this`
: Replaces table `table` with rows `ids` and `fields`, adding the table if it does not exist.
  Without ids, the rows are `0` to `n - 1`, `n` being the length of each field's values.

{#patch-set .member}
**`set`**`(table: string, fields:` [`Fields`](#fields)`): this` [¶](#patch-set){.headerlink}
: Writes `fields` for rows `ids` of `table`. Rows with existing ids change, new ids add rows, and
  omitted fields keep their values. Adds the table if it does not exist. Without ids, the rows
  are `0` to `n - 1`, `n` being the length of each field's values.

{.member}
**`set`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this`
: Writes `fields` for rows `ids` of `table`. Rows with existing ids change, new ids add rows, and
  omitted fields keep their values. Adds the table if it does not exist. Without ids, the rows
  are `0` to `n - 1`, `n` being the length of each field's values.

{#patch-remove .member}
**`remove`**`(table: string, ids:` [`RowIds`](#rowids)`): this` [¶](#patch-remove){.headerlink}
: Removes the rows of `table` with `ids`.

{#patch-append .member}
**`append`**`(table: string, at: number | readonly number[], fields: Readonly<Record<string,` [`Values`](#values)`>>, options?: { ids?:` [`RowIds`](#rowids) `}): this` [¶](#patch-append){.headerlink}
: Records a frame of `table` at each axis coordinate in `at`. Each field gives a value per row
  per frame, frame by frame. A field's first frame makes it a sampled field. Consecutive appends
  of typed float arrays to the same fields of every row write as one change, so a frame per call
  costs no more than one call with every frame.

  {#patch-append-ids .member}
  **`ids`**`?:` [`RowIds`](#rowids) [¶](#patch-append-ids){.headerlink}
  : The rows the frames cover, every row by default; other rows keep their last values.

{#patch-forget .member}
**`forget`**`(before: number): this` [¶](#patch-forget){.headerlink}
: Drops every sampled field's frames before axis coordinate `before`.

{#patch-frames .member}
**`frames`**`(table: string, field: string, run:` [`Run`](#run)`): this` [¶](#patch-frames){.headerlink}
: Stores a run of entries of sampled field `field` of `table`, at one level of detail. This is
  what a time tile holds, as `latkit tile` writes it. At level 0 each entry is a frame; at level
  `k`, a bucket of `8^k` frames. None of the entries may be stored already. Entries past the
  field's last frame extend it.

{#patch-extend .member}
**`extend`**`(next: Patch): this` [¶](#patch-extend){.headerlink}
: Appends `next`'s changes to this patch, which keeps its own dataset name.

{#patch-tobytes .member}
**`toBytes`**`(): Uint8Array` [¶](#patch-tobytes){.headerlink}
: A copy of the patch as latkit's bytes: one frame, naming the dataset if the patch does.

(bytesource)=

### `ByteSource`

{.signature}
`type ByteSource = Uint8Array | ArrayBuffer | Blob | Response |` [`ReadableBytes`](#readablebytes) `| AsyncIterable<Uint8Array> | string`

Bytes to read: an array or buffer, a `Blob`, a `Response`, a byte stream, or a URL to fetch as a
string. Reading waits within its [`Wait`](#wait), and fails with an `io` error when a fetch fails or
answers an error status, or the bytes cannot be read.

(readablebytes)=

### `ReadableBytes`

{.signature}
`interface ReadableBytes`

A byte stream: anything shaped like a browser or Node.js `ReadableStream` of `Uint8Array`.

{#readablebytes-getreader .member}
**`getReader`**`(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void>; releaseLock(): void }` [¶](#readablebytes-getreader){.headerlink}
: A reader of the stream's chunks, which latkit reads to the end, or cancels.

(rowids)=

### `RowIds`

{.signature}
`type RowIds =` [`Ids`](#ids) `| readonly (`[`Id`](#id) `| null)[] | Uint32Array | Float64Array`

Row ids: a list of numbers or strings, `{ count }` for ids `0` to `count - 1`, or a `Uint32Array`
or `Float64Array` of numbers.

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

(run)=

### `Run`

{.signature}
`interface Run`

A run of a sampled field's entries at one level of detail, as [`Patch.frames()`](#patch-frames) stores.

{#run-level .member}
**`level`**`?: number` [¶](#run-level){.headerlink}
: The level of detail, from 0 to 21; 0 by default.

{#run-first .member}
**`first`**`: number` [¶](#run-first){.headerlink}
: The first entry's number: a safe nonnegative integer.

{#run-at .member}
**`at`**`: Float64Array | readonly number[]` [¶](#run-at){.headerlink}
: Each frame's coordinate, or each bucket's first and last frames' coordinates.

{#run-values .member}
**`values`**`: Float32Array | readonly number[]` [¶](#run-values){.headerlink}
: A value per row, entry by entry; at a bucket level, every bucket's per-row minimums, then every
  bucket's per-row maximums. NaN marks a missing value.

## Expressions

Builders for the per-row expressions that scene options take, colors among them.

(expr)=

### `Expr`

{.signature}
`class Expr`

A value for every row of a mark: a constant, a color, a field, view state, or arithmetic on them.
Color options take one that computes a color: a CSS color, a value through a colormap, or a
conditional choosing between colors.

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
**`from`**`(table:` [`TableInput`](#tableinput)`): Expr` [¶](#expr-from){.headerlink}
: Reads this expression's fields from `table`, such as `weather.table('Station')`, joined by row
  id. A view draws the table's dataset too.

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
: Whether a text field equals `text`, a plain text that is neither a field nor a color.

{#expr-contains .member}
**`contains`**`(text: string): Expr` [¶](#expr-contains){.headerlink}
: Whether a text field contains `text`, a plain text, ignoring case. In a mark, the field must be
  in the mark's own table.

{#expr-colormap .member}
**`colormap`**`(map:` [`Colormap`](#colormap)`):` [`Mapped`](#mapped) [¶](#expr-colormap){.headerlink}
: Maps the value to a color for every row through `map`, a catalog name or custom colors. The
  domain fits the values shown unless set with [`Mapped.domain()`](#mapped-domain).

{#expr-scale .member}
**`scale`**`(low: number, high: number):` [`Mapped`](#mapped) [¶](#expr-scale){.headerlink}
: Maps the value linearly onto `[low, high]`, clamped. The domain fits the values shown unless
  set with [`Mapped.domain()`](#mapped-domain).

(exprinput)=

### `ExprInput`

{.signature}
`type ExprInput =` [`Expr`](#expr) `|` [`ExprNode`](#exprnode)

An option's value: an [`Expr`](#expr), or its JSON form. In the JSON form, `null` is a missing
value, a string starting with `$` reads a field (`'$kv'` reads field `kv`), and any other string
is a CSS color. Color options take a value that computes a color.

(mapped)=

### `Mapped`

{.signature}
`class Mapped extends` [`Expr`](#expr)

A value mapped through a colormap or onto a range, with an input domain that can be set.

```{rubric} Methods
```

{#mapped-domain .member}
**`domain`**`(low: number, high: number): Mapped` [¶](#mapped-domain){.headerlink}
: Sets the input values that map to the colormap's or the range's ends, instead of fitting the
  values shown.

(color)=

### `Color`

{.signature}
`type Color = string`

A CSS color, such as `'#ffb000'` or `'rebeccapurple'`. In an expression, a string that does not
start with `$` is a color.

(field)=

### `field()`

{.signature}
`function field(name: string):` [`Expr`](#expr)

Reads field `name` of each row, written `'$name'` in JSON. `from()` and `step()` give it its
`{ field }` form.

(when-function)=

### `when()`

{.signature}
`function when(condition:` [`ExprInput`](#exprinput)`):` [`When`](#when)

Starts a conditional. `when(c).then(a).when(d).then(b).otherwise(e)` takes the value of the first
case whose condition holds, else `e`. The values may be numbers, colors, or a text field and
`null`, as the option takes.

(when)=

### `When`

{.signature}
`class When`

A conditional's first condition, awaiting its value from `then`.

```{rubric} Methods
```

{#when-then .member}
**`then`**`(value:` [`ExprInput`](#exprinput)`):` [`Then`](#then) [¶](#when-then){.headerlink}
: Sets the value where the condition holds.

(then)=

### `Then`

{.signature}
`class Then`

A conditional's cases so far, awaiting another `when` case or the `otherwise` fallback.

```{rubric} Methods
```

{#then-when .member}
**`when`**`(condition:` [`ExprInput`](#exprinput)`):` [`Next`](#next) [¶](#then-when){.headerlink}
: Adds a case, tried when no earlier condition holds.

{#then-otherwise .member}
**`otherwise`**`(value:` [`ExprInput`](#exprinput)`):` [`Expr`](#expr) [¶](#then-otherwise){.headerlink}
: Sets the value where no condition holds, and returns the finished conditional.

(next)=

### `Next`

{.signature}
`class Next`

A conditional's next condition, awaiting its value from `then`.

```{rubric} Methods
```

{#next-then .member}
**`then`**`(value:` [`ExprInput`](#exprinput)`):` [`Then`](#then) [¶](#next-then){.headerlink}
: Sets the value where this condition holds.

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
`function units(size:` [`ExprInput`](#exprinput)`, limits?: Omit<`[`Units`](#units)`, 'units'>):` [`Units`](#units)

A size in position units (degrees on the earth) regardless of the space's unit, so it scales as
the view zooms. `limits` bound its on-screen size in CSS pixels: `units('$r', { atLeast: 2 })`
grows with the map and never shrinks below 2 pixels. A marker keeps its proportions, with the
limits applied to its larger side. Given only a number, the result also works as a theme length.

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

(colormaps)=

### `colormaps()`

{.signature}
`function colormaps(): { name:` [`ColormapName`](#colormapname)`; label: string; kind:` [`ColormapKind`](#colormapkind) `}[]`

The catalog's colormaps, in order: each one's name, its title for people, such as
`'Red / Blue'`, and its kind.

(colormapcss)=

### `colormapCss()`

{.signature}
`function colormapCss(map:` [`Colormap`](#colormap)`, direction?: string): string`

Returns a CSS `linear-gradient(...)` with the colors the GPU draws for `map`, a catalog name or a
custom colormap. `direction` is the gradient's CSS direction, `'to right'` by default. A
categorical map gives one solid band per category.

## Views

Views draw scenes on canvases, with the GPU they share.

(view)=

### `View`

{.signature}
`class View extends` [`Handle`](#handle)

A scene drawn from its datasets, on a canvas and into pictures; created by [`View.create()`](#view-create).
The canvas passes it pointer, wheel, and key input, and a [`Shot`](#shot) draws it into pictures.
Destroying it rejects its unanswered queries; its canvas keeps its last frame.

```ts
const grid = new Data('grid').set('Bus', [1, 2], { x: [0, 30], y: [0, 20], kv: [230, 115] });
const view = await View.create(canvas, {
  space: 'plane',
  marks: [{ vertices: grid.table('Bus'), position: ['$x', '$y'], color: field('kv').colormap('viridis') }],
});
```

```{rubric} Properties
```

{#view-gpu .member}
`readonly` **`gpu`**`:` [`Gpu`](#gpu) [¶](#view-gpu){.headerlink}
: The GPU that draws the view.

{#view-region .member}
**`region`**`:` [`Rect`](#rect) [¶](#view-region){.headerlink}
: Where the view draws on its canvas and in pictures: `[x, y, width, height]` in fractions of
  them, from the top left. Views of one canvas draw in the order they were created.

{#view-scene .member}
**`scene`**`:` [`Scene`](#scene) [¶](#view-scene){.headerlink}
: The scene drawn. Marks that match a mark of the previous scene by kind, dataset, table, and
  name keep their state and ease to their new options. An invalid scene leaves the current one.

{#view-sources .member}
**`sources`**`: readonly` [`Source`](#source)`[]` [¶](#view-sources){.headerlink}
: Datasets the view draws besides those of its scene's tables, and in their place where they
  share a name: a mark whose table is written `[data, table]` draws the source named `data`. The
  view draws a [`Data`](#data) at its latest version, from the frame after each change; a [`Snapshot`](#snapshot)
  unchanged; and [`Tiles`](#tiles) as the pieces it needs. A mark whose dataset no longer fits it draws
  nothing; it is listed in `failures`, and the next frame emits an `error` event.

{#view-at .member}
**`at`**`: number` [¶](#view-at){.headerlink}
: The axis coordinate shown, such as a time. Marks read sampled fields at it, interpolating
  between the frame at or before it and the next, unless an expression uses `step()`.

{#view-camera .member}
**`camera`**`:` [`Camera`](#camera) [¶](#view-camera){.headerlink}
: Where the view looks. Setting it moves the camera at once; use [`View.fly()`](#view-fly) to ease. A
  camera of the wrong kind for the space, such as a plot camera on a map, is ignored.

  Every move keeps the camera within reach. On the earth, the space bounds it, as [`Earth`](#earth)
  describes, inside the insets. Fits narrow it to 3 zoom levels out and 8 in from what they
  framed, with the center near the framed box. When a resize, new insets, or a new space moves
  the camera back within reach, a `camera` event reports it.

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

{#view-create .member}
`static` **`create`**`(canvas: HTMLCanvasElement | OffscreenCanvas | null, scene:` [`Scene`](#scene)`, options?: { region?:` [`Rect`](#rect)`; camera?:` [`Camera`](#camera)`; sources?: readonly` [`Source`](#source)`[]; gpu?:` [`Gpu`](#gpu)`; pixelRatio?: number }): Promise<View>` [¶](#view-create){.headerlink}
: Creates a view that draws `scene` on `canvas`, in `options.region`, over any views already on
  it; with a `null` canvas, the view draws only into pictures. It draws the datasets its scene's
  tables belong to, and frames everything once it draws, unless given a camera.

  {#view-create-region .member}
  **`region`**`?:` [`Rect`](#rect) [¶](#view-create-region){.headerlink}
  : Where the view draws on the canvas and in pictures; the whole of them by default.

  {#view-create-camera .member}
  **`camera`**`?:` [`Camera`](#camera) [¶](#view-create-camera){.headerlink}
  : Where the view looks first. Without one, it frames everything drawn.

  {#view-create-sources .member}
  **`sources`**`?: readonly` [`Source`](#source)`[]` [¶](#view-create-sources){.headerlink}
  : Datasets beside those of the scene's tables; see [`View.sources`](#view-sources).

  {#view-create-gpu .member}
  **`gpu`**`?:` [`Gpu`](#gpu) [¶](#view-create-gpu){.headerlink}
  : The GPU that draws the view; the first [`Gpu`](#gpu) created by default, created if need be.

  {#view-create-pixelratio .member}
  **`pixelRatio`**`?: number` [¶](#view-create-pixelratio){.headerlink}
  : Pixels per CSS pixel of an `OffscreenCanvas`, 1 by default; the first view on it sets it.

{#view-fit .member}
**`fit`**`(fit?:` [`Fit`](#fit)`): void` [¶](#view-fit){.headerlink}
: Frames what `fit` names, every row by default, keeping pitch and bearing. It takes effect on
  the next frame, or a frame or two later when the extent must be measured on the GPU.

{#view-fly .member}
**`fly`**`(camera:` [`Camera`](#camera)`): void` [¶](#view-fly){.headerlink}
: Eases the camera to `camera`, kept within reach as [`View.camera`](#view-camera) describes, over twice
  the scene's ease time, or at once when motion is reduced. A camera of the wrong kind for the
  space is ignored.

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
: Resolves, once a frame draws the view, to every row of a pickable mark near `point`, nearest
  first.

  {#view-pick-radius .member}
  **`radius`**`?: number` [¶](#view-pick-radius){.headerlink}
  : How near, in CSS pixels; 0 by default.

{#view-neighbors .member}
**`neighbors`**`(row:` [`Row`](#row)`):` [`Rows`](#rows)`[]` [¶](#view-neighbors){.headerlink}
: The rows connected to `row`, one set per table: a vertex's neighbors across edges and nets, or
  an edge's or a net's vertices. The cost is proportional to the row's degree.

{#view-arrange .member}
**`arrange`**`(wait?:` [`Wait`](#wait)`): Promise<`[`Patch`](#patch)`[]>` [¶](#view-arrange){.headerlink}
: Lays out every vertex row without a position again, and resolves to one patch per dataset that
  writes each row's place into its mark's position fields; applied, the places become part of
  the data. Marks whose position is not read from fields are left out.

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

(rect)=

### `Rect`

{.signature}
`type Rect = readonly [x: number, y: number, width: number, height: number]`

A region `[x, y, width, height]` in fractions of a canvas or picture, from its top left.

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

(gpu)=

### `Gpu`

{.signature}
`class Gpu extends` [`Handle`](#handle)

A WebGPU device that views draw with. The views of one `Gpu` share its memory and draw together
in each animation frame, so linked views always show the same moment. Views use the first `Gpu`
created unless given another, and [`View.create`](#view-create) creates it when there is none. Destroying it
destroys its views and frame listeners; other GPUs and datasets stay usable.

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
: Bytes of GPU memory its views draw from: data pages, and each view's per-row data.

{#gpu-uploading .member}
`readonly` **`uploading`**`: number` [¶](#gpu-uploading){.headerlink}
: Bytes waiting to upload to the GPU, across its views.

```{rubric} Methods
```

{#gpu-create .member}
`static` **`create`**`(): Promise<Gpu>` [¶](#gpu-create){.headerlink}
: Requests a WebGPU device; the first call takes the one [`load()`](#load) requested. Create one before
  any view to set its `budget` first, or another for views that should not share memory with the
  rest. Rejects with an `unsupported` error when the browser has no WebGPU device.

{#gpu-on .member}
**`on`**`(type: 'frame', listener: (now: number) => void): () => void` [¶](#gpu-on){.headerlink}
: Calls `listener` every animation frame with the frame's timestamp in milliseconds, before the
  views draw, so changes it makes show in that frame. While any listener is registered, a frame
  runs every animation frame. Returns a function that removes the listener.

{#gpu-step .member}
**`step`**`(now: number): void` [¶](#gpu-step){.headerlink}
: Draws one frame now, at `now` milliseconds on the `requestAnimationFrame` clock: it runs the
  frame listeners, then draws every canvas that needs a frame. After the first call, the GPU
  requests no more animation frames, so a test or benchmark that steps every frame draws the
  same frames on any device.

{#gpu-done .member}
**`done`**`(wait?:` [`Wait`](#wait)`): Promise<void>` [¶](#gpu-done){.headerlink}
: Resolves once the GPU has finished its submitted work, every readback has arrived, and every
  pipeline a view or shot requested has compiled. A frame stepped after that uses all of it.

{#gpu-landed .member}
**`landed`**`(wait?:` [`Wait`](#wait)`): Promise<void>` [¶](#gpu-landed){.headerlink}
: Resolves when, after this call, work a view is waiting on arrives (a readback, a pipeline
  compile, a job, a label text, or a fetch), or a view requests a frame. A harness that steps
  frames awaits it to know when to step again.

## Pictures and video

Shots draw views into images and video.

(shot)=

### `Shot`

{.signature}
`class Shot`

A picture of views, `size` pixels in all, each view drawn in its region. While a shot draws a
view, its canvas keeps its last frame. An image draws each view's data as it was when the
picture began. `Shot.of(view)` makes a shot of what a view's canvas shows.

```ts
const png = await (await Shot.of(view, { scale: 2 }).image()).encode('png');
```

```{rubric} Constructor
```

{#shot-new .member}
**`new Shot`**`(size: readonly [number, number], options?:` [`ShotOptions`](#shotoptions) `& { views?: readonly` [`Placed`](#placed)`[] })` [¶](#shot-new){.headerlink}
: Creates a shot of `size`, `[width, height]` in pixels.

  {#shot-new-views .member}
  **`views`**`?: readonly` [`Placed`](#placed)`[]` [¶](#shot-new-views){.headerlink}
  : The views drawn, later views over earlier ones: each in its own region, or, given as
    `{ view, region }`, in that region of the picture.

```{rubric} Properties
```

{#shot-size .member}
`readonly` **`size`**`: readonly [number, number]` [¶](#shot-size){.headerlink}
: The picture's size, `[width, height]` in pixels.

{#shot-options .member}
`readonly` **`options`**`:` [`ShotOptions`](#shotoptions) `& { views?: readonly` [`Placed`](#placed)`[] }` [¶](#shot-options){.headerlink}
: How the picture is taken, and in `views`, the views drawn into it.

```{rubric} Methods
```

{#shot-of .member}
`static` **`of`**`(view:` [`View`](#view)`, options?:` [`ShotOptions`](#shotoptions)`): Shot` [¶](#shot-of){.headerlink}
: A shot of exactly what the canvas showing `view` shows: its views in their regions, at the
  canvas's CSS size times `options.scale` in pixels. Throws an `invalid` error for a view on no
  canvas, which a shot must be given a size for.

{#shot-image .member}
**`image`**`(wait?:` [`Wait`](#wait)`): Promise<`[`Image`](#image)`>` [¶](#shot-image){.headerlink}
: Draws the picture once every view is complete, as `capture` says, and resolves to the
  [`Image`](#image). Rejects with the first error a view reports while drawing.

{#shot-video .member}
**`video`**`(options: { fps: number; output: WritableStream<Uint8Array>; bitrate?: number } &` [`Wait`](#wait)`):` [`Video`](#video) [¶](#shot-video){.headerlink}
: Starts a video of this shot: H.264 in MP4, written to `options.output` as frames are drawn. The
  width is rounded down to a multiple of 4 and the height to an even number, as the encoder
  requires. Canvases showing the views keep their last frame until the video finishes or aborts.
  Aborting `options.signal` aborts the video and its output; frames have no other time limit.

  {#shot-video-fps .member}
  **`fps`**`: number` [¶](#shot-video-fps){.headerlink}
  : Frames per second.

  {#shot-video-output .member}
  **`output`**`: WritableStream<Uint8Array>` [¶](#shot-video-output){.headerlink}
  : Where the file's bytes go, locked until the video finishes or aborts.

  {#shot-video-bitrate .member}
  **`bitrate`**`?: number` [¶](#shot-video-bitrate){.headerlink}
  : Bits per second; about 0.15 bits per pixel per frame by default.

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
  still: transitions, camera flights, and tile fades run until they finish. `'now'` waits only
  until every view is complete, and freezes anything moving where it is.

{#shotoptions-elapsed .member}
**`elapsed`**`?: number` [¶](#shotoptions-elapsed){.headerlink}
: The time in seconds that [`elapsed()`](#elapsed) expressions and flowing comets show in a still picture. By
  default they follow the view's clock.

(placed)=

### `Placed`

{.signature}
`type Placed =` [`View`](#view) `| { view:` [`View`](#view)`; region:` [`Rect`](#rect) `}`

A view drawn into a picture, in its own region or in `region`.

{#placed-view .member}
`readonly` **`view`**`:` [`View`](#view) [¶](#placed-view){.headerlink}
: The view drawn.

{#placed-region .member}
`readonly` **`region`**`:` [`Rect`](#rect) [¶](#placed-region){.headerlink}
: Where it draws in the picture, in place of its own region.

(image)=

### `Image`

{.signature}
`class Image extends` [`Handle`](#handle)

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
: Encodes the image as a file, in a worker. PNG is lossless with alpha. JPEG drops alpha. WebP
  is lossless with alpha and smaller than PNG.

  {#image-encode-quality .member}
  **`quality`**`?: number` [¶](#image-encode-quality){.headerlink}
  : JPEG quality, from 1 (smallest) to 100 (sharpest); 90 by default.

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
