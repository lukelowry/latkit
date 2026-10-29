# JavaScript API

Every class, function, and type the `latkit` package exports. Scenes and their options use the
[scene and result types](types.md). These rules apply everywhere, so the entries below don't
repeat them:

- Scenes, expressions, and patches are plain data. Datasets, views, pictures, and the colormap
  functions need latkit's WebAssembly, and throw an `unloaded` error until [`load()`](#load) finishes.
  [`View.create()`](#view-create), [`Gpu.create()`](#gpu-create), [`Data.read()`](#data-read), and [`Patch.read()`](#patch-read) of JSON call it
  themselves.
- Everything latkit throws or rejects with is a [`LatkitError`](#latkiterror). Input it can't use fails with an
  `invalid` error and changes nothing. The error's `path` names the bad part, such as
  `marks[2].color`.
- Every promise waits until its [`Wait`](#wait) signal aborts, or for 30 seconds without one.
- A [`Handle`](#handle) holds memory until `destroy()` or the end of a `using` block frees it.

## Loading, errors, and lifetimes

What every part of the package shares.

(load)=

### `load()`

{.signature}
`function load(options?: { wasm?: string | URL | WebAssembly.Module; worker?: string | URL | (() => Worker) }): Promise<void>`

Loads latkit's WebAssembly, once per page. Later and concurrent calls share the first call's
load. Options they pass must equal the first call's, or they reject with an `io` error. A failed
load rejects with an `io` error and can be retried. While the WebAssembly compiles, `load()`
requests a GPU adapter so the browser starts its GPU process early. Then it requests the first
device for [`Gpu.create()`](#gpu-create).

{#load-wasm .member}
**`wasm`**`?: string | URL | WebAssembly.Module` [¶](#load-wasm){.headerlink}
: The URL of this version's `latkit/wasm` asset, or that asset compiled. Defaults to the
  bundled asset.

{#load-worker .member}
**`worker`**`?: string | URL | (() => Worker)` [¶](#load-worker){.headerlink}
: The URL of this version's standalone `latkit/worker` asset, or a function that creates a
  worker running it. A URL on another origin, such as a CDN, starts through a script on the
  page's origin, since browsers start workers only from there. Defaults to the bundled worker.

(latkiterror)=

### `LatkitError`

{.signature}
`interface LatkitError extends Error`

The error latkit throws: an `Error` with a `code` that names the kind of failure.

{#latkiterror-code .member}
**`code`**`:` [`Failure`](#failure)`['code'] | 'unloaded' | 'destroyed' | 'stopped'` [¶](#latkiterror-code){.headerlink}
: The kind of failure:

  - `invalid`: the input is malformed or does not fit. `path` says where.
  - `unsupported`: the browser or device cannot do what was asked.
  - `limit`: a budget or device limit would be exceeded.
  - `io`: reading or writing external bytes failed, such as loading latkit or fetching a file.
  - `device-lost`: the GPU device was lost, and latkit could not get a new one.
  - `cancelled`: the wait's signal aborted, or the work was cancelled.
  - `timeout`: the wait's signal timed out.
  - `unloaded`: the call needs WebAssembly, and [`load()`](#load) has not finished.
  - `destroyed`: the object was destroyed and can't be used.
  - `stopped`: latkit hit an internal error and stopped. Every view reports it once, every
    [`Gpu`](#gpu) is lost, and every later call throws it. Reload the page to start over.

{#latkiterror-path .member}
**`path`**`?: string` [¶](#latkiterror-path){.headerlink}
: On `invalid` errors, the invalid part of the input, such as `marks[2].color`.

(wait)=

### `Wait`

{.signature}
`interface Wait`

Options that bound how long a promise waits.

{#wait-signal .member}
**`signal`**`?: AbortSignal` [¶](#wait-signal){.headerlink}
: Aborts the wait. A timeout rejects with a `timeout` error. Any other abort rejects with a
  `cancelled` error, with the abort reason as its `cause`. Either way, latkit cancels the call's
  pending work where it can. Without a signal, each wait times out after 30 seconds.

(handle)=

### `Handle`

{.signature}
`abstract class Handle`

An object that holds WebAssembly memory (and GPU memory, for a [`Gpu`](#gpu)) until it is destroyed.
`destroy()` frees it, as does the end of a `using` block. After that, its other methods throw a
`destroyed` error.

```{rubric} Methods
```

{#handle-destroy .member}
**`destroy`**`(): void` [¶](#handle-destroy){.headerlink}
: Frees the object's memory. Calling it again does nothing. Once latkit has stopped, it only
  drops the object, since its memory can't be used again.

## Data and patches

Datasets, the tables in them that marks draw, and the patches that change them. Patches are written without WebAssembly.

(dataset)=

### `Dataset`

{.signature}
`abstract class Dataset extends` [`Handle`](#handle)

Named tables of columns. A [`Data`](#data) reads its current version and a [`Snapshot`](#snapshot) reads
the version it holds, through the same methods.

```{rubric} Properties
```

{#dataset-name .member}
`readonly` **`name`**`: string` [¶](#dataset-name){.headerlink}
: The dataset's name: the `data` in its tables' JSON form `[data, table]`.

```{rubric} Methods
```

{#dataset-table .member}
**`table`**`(name: string):` [`Table`](#table) [¶](#dataset-table){.headerlink}
: Returns table `name`, for a mark to draw or a field to read.

{#dataset-describe .member}
**`describe`**`():` [`Description`](#description) [¶](#dataset-describe){.headerlink}
: Describes the tables and row counts, each field and its kind, and the axis and its span.

{#dataset-get .member}
**`get`**`(table: string, id:` [`Id`](#id)`, field: string, options?: { at?: number }):` [`Value`](#value) [¶](#dataset-get){.headerlink}
: Reads `field` of row `id` in `table`. A sampled field gives its last frame at or before
  `options.at`, or its last frame without `at`. A reference gives the referenced row's id.
  Returns `null` when the table, row, field, or value is missing.

  {#dataset-get-at .member}
  **`at`**`?: number` [¶](#dataset-get-at){.headerlink}
  : The axis coordinate to read a sampled field at.

{#dataset-query .member}
**`query`**`(query:` [`Query`](#query)`):` [`QueryResult`](#queryresult) [¶](#dataset-query){.headerlink}
: Reads a table's rows, filtered, sorted, and paged with the same expressions marks use. Sampled
  fields are read at [`query.at`](#query-at).

{#dataset-envelope .member}
**`envelope`**`(request:` [`EnvelopeRequest`](#enveloperequest)`):` [`Envelope`](#envelope) [¶](#dataset-envelope){.headerlink}
: Returns the minimum and maximum of a sampled field over equal spans of an axis range, for every
  row or for the rows in `request.ids`. Each span reads the coarsest stored levels of detail that
  fit inside it, so it costs a few reads however many frames it covers. Throws a `limit` error
  when rows times spans exceeds 2^26.

{#dataset-tobytes .member}
**`toBytes`**`(): Uint8Array` [¶](#dataset-tobytes){.headerlink}
: Returns the dataset as latkit's bytes: a patch that builds it from an empty dataset.

(data)=

### `Data`

{.signature}
`class Data extends` [`Dataset`](#dataset)

A dataset that changes in place. Each change applies all at once or not at all. Every
[`Patch`](#patch) method is also a method here that applies that one change right away, and `apply`
applies a patch of several. Views draw the latest version from the frame after each change. A
[`Snapshot`](#snapshot) keeps one version and shares its pages with the dataset, so an undo history
costs only the pages that differ. Destroying a `Data` leaves the views that draw it, and its
snapshots, usable.

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
  - A dataset document, `{"name": ..., "patch": [...]}`. Its patch is read like
    [`Patch.read()`](#patch-read).

  {#data-read-name .member}
  **`name`**`?: string` [¶](#data-read-name){.headerlink}
  : The dataset's name, overriding the name in its bytes or document. Required for GeoJSON.

  {#data-read-base .member}
  **`base`**`?: string` [¶](#data-read-base){.headerlink}
  : The URL that a document's file slices are relative to. Defaults to the document's URL.

{#data-apply .member}
**`apply`**`(patch:` [`Patch`](#patch) `| Uint8Array): this` [¶](#data-apply){.headerlink}
: Applies every change in `patch`, or none when one is invalid, and returns this dataset. An
  `invalid` error's `path` names the failing change, such as `patch[1].Bus.kv`.

{#data-axis .member}
**`axis`**`(name: string, unit: string): this` [¶](#data-axis){.headerlink}
: Applies [`Patch.axis()`](#patch-axis): names the axis that sampled fields are recorded over.

{#data-replace .member}
**`replace`**`(table: string, fields:` [`Fields`](#fields)`): this` [¶](#data-replace){.headerlink}
: Applies [`Patch.replace()`](#patch-replace): replaces table `table` with `fields` for rows `ids` (or `0` to
  `n - 1`).

{.member}
**`replace`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this`
: Applies [`Patch.replace()`](#patch-replace): replaces table `table` with `fields` for rows `ids` (or `0` to
  `n - 1`).

{#data-set .member}
**`set`**`(table: string, fields:` [`Fields`](#fields)`): this` [¶](#data-set){.headerlink}
: Applies [`Patch.set()`](#patch-set): writes `fields` for rows `ids` (or `0` to `n - 1`) of `table`,
  adding new rows.

{.member}
**`set`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this`
: Applies [`Patch.set()`](#patch-set): writes `fields` for rows `ids` (or `0` to `n - 1`) of `table`,
  adding new rows.

{#data-remove .member}
**`remove`**`(table: string, ids:` [`RowIds`](#rowids)`): this` [¶](#data-remove){.headerlink}
: Applies [`Patch.remove()`](#patch-remove): removes the rows of `table` with `ids`.

{#data-append .member}
**`append`**`(table: string, at: number | readonly number[], fields: Readonly<Record<string,` [`Values`](#values)`>>, options?: { ids?:` [`RowIds`](#rowids) `}): this` [¶](#data-append){.headerlink}
: Applies [`Patch.append()`](#patch-append): records frames of `table` at the axis coordinates `at`.

  {#data-append-ids .member}
  **`ids`**`?:` [`RowIds`](#rowids) [¶](#data-append-ids){.headerlink}
  : The rows the frames cover. Defaults to every row. Other rows keep their last values.

{#data-forget .member}
**`forget`**`(before: number): this` [¶](#data-forget){.headerlink}
: Applies [`Patch.forget()`](#patch-forget): drops every sampled field's frames before `before`.

{#data-frames .member}
**`frames`**`(table: string, field: string, run:` [`Run`](#run)`): this` [¶](#data-frames){.headerlink}
: Applies [`Patch.frames()`](#patch-frames): stores a run of a sampled field's entries, as in a time tile.

{#data-snapshot .member}
**`snapshot`**`():` [`Snapshot`](#snapshot) [¶](#data-snapshot){.headerlink}
: Returns the current version as a [`Snapshot`](#snapshot). Later patches don't change it. O(1).

{#data-restore .member}
**`restore`**`(snapshot:` [`Snapshot`](#snapshot)`): this` [¶](#data-restore){.headerlink}
: Makes `snapshot`, a version of this dataset, the current version. This is how to undo.

(snapshot)=

### `Snapshot`

{.signature}
`class Snapshot extends` [`Dataset`](#dataset)

One immutable version of a dataset, taken in O(1) by [`Data.snapshot()`](#data-snapshot). A view given a
snapshot draws that version, and keeps drawing it after the snapshot is destroyed.

(tiles)=

### `Tiles`

{.signature}
`class Tiles`

A dataset fetched in pieces as views need them. Each view fetches the pieces its camera and plot
window need, and views on one GPU share them. The first bytes at `url` decide the kind:

- Time tiles: a `frames.json` manifest written by `latkit tile`. A line that traces a sampled
  field fetches the detail its plot window shows. Other marks fetch the frames around the view's
  `at`. While a span loads, the coarser span that contains it shows. The manifest is
  `{ data, chunk, url, frames: [{ table, field, levels, frames: [first, end] }] }`: `data` is the
  dataset without the listed fields' entries, and each span at `url` (such as
  `{field}/{level}/{index}.latk`) is a patch of `chunk` entries of one level. A server that
  records more frames rewrites the manifest and the spans past the old end, then the app calls
  `refresh()`.
- Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` URL template. Each
  layer becomes a table of the features its marks draw: polygons for areas, lines for lines,
  points for vertices. A table named `layer:polygons`, `layer:lines`, or `layer:points` holds
  that kind regardless of the marks. Each tile that arrives appends its rows to the view's
  dataset. Rows of tiles no longer drawn are kept until they outnumber the rows drawn.

```{rubric} Constructor
```

{#tiles-new .member}
**`new Tiles`**`(name: string, url: string, { fetch }?:` [`TilesOptions`](#tilesoptions)`)` [¶](#tiles-new){.headerlink}
: Tiles at `url`, drawn as the dataset named `name`.

```{rubric} Properties
```

{#tiles-name .member}
`readonly` **`name`**`: string` [¶](#tiles-name){.headerlink}
: The name of the dataset the tiles are drawn as.

{#tiles-url .member}
`readonly` **`url`**`: string` [¶](#tiles-url){.headerlink}
: The tiles' URL.

```{rubric} Methods
```

{#tiles-table .member}
**`table`**`(name: string):` [`Table`](#table) [¶](#tiles-table){.headerlink}
: Returns table `name`, such as a vector tile layer, for a mark to draw.

{#tiles-refresh .member}
**`refresh`**`(): void` [¶](#tiles-refresh){.headerlink}
: Fetches the index again, as when a running simulation records more frames, and redraws what
  changed in every view drawing the tiles. Time tiles keep the spans the earlier frames cover.
  Vector tiles start over.

(tilesoptions)=

### `TilesOptions`

{.signature}
`interface TilesOptions`

How [`Tiles`](#tiles) fetch their files.

{#tilesoptions-fetch .member}
**`fetch`**`?: (url: string, range?: [start: number, end: number]) => Promise<`[`ByteSource`](#bytesource)`>` [¶](#tilesoptions-fetch){.headerlink}
: Fetches a file in place of the browser, such as with credentials or from the app's own store:
  the index at `url`, the pieces at URLs resolved against it, and bytes `[start, end)` of an
  archive. A 404 or 204 `Response` is a missing piece.

(source)=

### `Source`

{.signature}
`type Source =` [`Data`](#data) `|` [`Snapshot`](#snapshot) `|` [`Tiles`](#tiles)

A dataset a view draws: the one a [`Table`](#table) belongs to, or one of the view's `sources`.

(table)=

### `Table`

{.signature}
`class Table`

A table in a dataset, such as `grid.table('Bus')`. Marks draw its rows and `field().from()` reads
its fields. A view loads every dataset its scene uses. In JSON it is `[data, table]`.

```{rubric} Constructor
```

{#table-new .member}
**`new Table`**`(source:` [`Source`](#source)`, name: string)` [¶](#table-new){.headerlink}
: The table `name` in `source`.

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
: Returns the JSON form, `[data, table]`. `JSON.stringify` calls it.

(tableinput)=

### `TableInput`

{.signature}
`type TableInput =` [`Table`](#table) `| readonly [data: string, table: string]`

A table for a mark to draw or a field to read: a [`Table`](#table), or its JSON form `[data, table]`,
where `data` names a dataset in the view's `sources`.

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
: Each selected field's column, keyed by output name. Numbers come as a `Float64Array` with NaN
  for missing values. Other values come as an array with `null` for missing ones. A reference
  comes as the referenced table and, for each row, the id of the row it references.

{#queryresult-total .member}
**`total`**`: number` [¶](#queryresult-total){.headerlink}
: The number of rows that matched, before `offset` and `limit`.

(envelope)=

### `Envelope`

{.signature}
`interface Envelope`

The minimum and maximum of a sampled field for each row, over equal spans of the axis.

{#envelope-at .member}
**`at`**`: Float64Array` [¶](#envelope-at){.headerlink}
: The span boundaries on the axis: one more than the number of spans.

{#envelope-least .member}
**`least`**`: Float32Array` [¶](#envelope-least){.headerlink}
: Each row's minimum in each span, `spans` values per row, row after row. NaN for no value.

{#envelope-greatest .member}
**`greatest`**`: Float32Array` [¶](#envelope-greatest){.headerlink}
: Each row's maximum in each span, laid out like `least`.

(patch)=

### `Patch`

{.signature}
`class Patch`

A list of changes to a dataset. [`Data.apply`](#data-apply) applies them in order, all or none. The patch is
written as latkit's bytes as it is built, without WebAssembly. Each method adds a change and
returns the patch.

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

{#patch-bytelength .member}
`readonly` **`byteLength`**`: number` [¶](#patch-bytelength){.headerlink}
: The length of `toBytes()` in bytes, without copying them.

```{rubric} Methods
```

{#patch-read .member}
`static` **`read`**`(source:` [`ByteSource`](#bytesource) `| object, options?: { base?: string; limit?: number } &` [`Wait`](#wait)`): Promise<Patch>` [¶](#patch-read){.headerlink}
: Reads a patch from `source`: latkit's bytes (one frame, as `toBytes()` writes it), or JSON that
  any language can write without latkit. The JSON is a list of changes. Each change is keyed by
  its method name and holds the method's parameters by name, such as
  `{"set": {"table": "Bus", "ids": [1], "fields": {"kv": [345]}}}`. A field may be a slice of a
  binary file, `{file, dtype, offset, count}`, which is fetched right away. Bytes are read
  without WebAssembly.

  {#patch-read-base .member}
  **`base`**`?: string` [¶](#patch-read-base){.headerlink}
  : The URL that the JSON's file slices are relative to. Defaults to the JSON's URL.

  {#patch-read-limit .member}
  **`limit`**`?: number` [¶](#patch-read-limit){.headerlink}
  : The longest frame in bytes. Defaults to 256 MiB. A longer frame fails with a `limit` error.

{#patch-stream .member}
`static` **`stream`**`(stream:` [`ReadableBytes`](#readablebytes) `| AsyncIterable<Uint8Array>, options?: { limit?: number }): AsyncGenerator<Patch>` [¶](#patch-stream){.headerlink}
: Yields each patch in `stream` as soon as its last byte arrives. The stream carries frames back
  to back, such as a response body, a file, or a socket's messages. At most one frame is
  buffered, besides the current chunk and any patches the caller keeps. Breaking out of the loop
  cancels the stream. Throws an `invalid` error if the stream ends inside a frame.

  ```ts
  for await (const patch of Patch.stream((await fetch('/feed')).body!)) data.apply(patch);
  ```

  {#patch-stream-limit .member}
  **`limit`**`?: number` [¶](#patch-stream-limit){.headerlink}
  : The longest frame in bytes, at least 12. Defaults to 256 MiB. Each frame states its length
    up front, so a longer frame fails with a `limit` error before its body is allocated.

{#patch-axis .member}
**`axis`**`(name: string, unit: string): this` [¶](#patch-axis){.headerlink}
: Sets the name and unit of the axis that sampled fields are recorded over, such as
  `axis('time', 's')`.

{#patch-replace .member}
**`replace`**`(table: string, fields:` [`Fields`](#fields)`): this` [¶](#patch-replace){.headerlink}
: Replaces table `table` with rows `ids` and `fields`, adding the table if it does not exist.
  Without ids, the rows are `0` to `n - 1`, where `n` is the length of each field's values.

{.member}
**`replace`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this`
: Replaces table `table` with rows `ids` and `fields`, adding the table if it does not exist.
  Without ids, the rows are `0` to `n - 1`, where `n` is the length of each field's values.

{#patch-set .member}
**`set`**`(table: string, fields:` [`Fields`](#fields)`): this` [¶](#patch-set){.headerlink}
: Writes `fields` for rows `ids` of `table`. Rows with existing ids change, new ids add rows, and
  omitted fields keep their values. Adds the table if it does not exist. Without ids, the rows
  are `0` to `n - 1`, where `n` is the length of each field's values.

{.member}
**`set`**`(table: string, ids:` [`RowIds`](#rowids)`, fields?:` [`Fields`](#fields)`): this`
: Writes `fields` for rows `ids` of `table`. Rows with existing ids change, new ids add rows, and
  omitted fields keep their values. Adds the table if it does not exist. Without ids, the rows
  are `0` to `n - 1`, where `n` is the length of each field's values.

{#patch-remove .member}
**`remove`**`(table: string, ids:` [`RowIds`](#rowids)`): this` [¶](#patch-remove){.headerlink}
: Removes the rows of `table` with `ids`.

{#patch-append .member}
**`append`**`(table: string, at: number | readonly number[], fields: Readonly<Record<string,` [`Values`](#values)`>>, options?: { ids?:` [`RowIds`](#rowids) `}): this` [¶](#patch-append){.headerlink}
: Records a frame of `table` at each axis coordinate in `at`. Each field gives one value per row
  for each frame, frame by frame. A field becomes a sampled field at its first frame. Consecutive
  appends of typed float arrays to the same fields of every row are written as one change, so
  appending one frame per call costs no more than one call with every frame.

  {#patch-append-ids .member}
  **`ids`**`?:` [`RowIds`](#rowids) [¶](#patch-append-ids){.headerlink}
  : The rows the frames cover. Defaults to every row. Other rows keep their last values.

{#patch-forget .member}
**`forget`**`(before: number): this` [¶](#patch-forget){.headerlink}
: Drops every sampled field's frames before axis coordinate `before`.

{#patch-frames .member}
**`frames`**`(table: string, field: string, run:` [`Run`](#run)`): this` [¶](#patch-frames){.headerlink}
: Stores a run of entries of sampled field `field` in `table`, at one level of detail. This is
  what a time tile from `latkit tile` holds. At level 0 each entry is a frame. At level `k` each
  entry is a bucket of `8^k` frames. A run that covers a level's last entry replaces the entries
  it covers, such as the last bucket while it fills. Entries past the field's last frame extend it.

{#patch-extend .member}
**`extend`**`(next: Patch): this` [¶](#patch-extend){.headerlink}
: Appends `next`'s changes to this patch, which keeps its own dataset name.

{#patch-tobytes .member}
**`toBytes`**`(): Uint8Array` [¶](#patch-tobytes){.headerlink}
: Returns a copy of the patch as latkit's bytes: one frame, naming the dataset if it has one.

(bytesource)=

### `ByteSource`

{.signature}
`type ByteSource = Uint8Array | ArrayBuffer | Blob | Response |` [`ReadableBytes`](#readablebytes) `| AsyncIterable<Uint8Array> | string`

Bytes to read: an array or buffer, a `Blob`, a `Response`, a byte stream, or a URL string to
fetch. Reading is bounded by the call's [`Wait`](#wait). It fails with an `io` error when a fetch
fails or returns an error status, or when the bytes can't be read.

(readablebytes)=

### `ReadableBytes`

{.signature}
`interface ReadableBytes`

A byte stream: anything shaped like a browser or Node.js `ReadableStream` of `Uint8Array`.

{#readablebytes-getreader .member}
**`getReader`**`(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void>; releaseLock(): void }` [¶](#readablebytes-getreader){.headerlink}
: Returns a reader of the stream's chunks. latkit reads it to the end or cancels it.

(rowids)=

### `RowIds`

{.signature}
`type RowIds =` [`Ids`](#ids) `| readonly (`[`Id`](#id) `| null)[] | Uint32Array | Float64Array`

Row ids: a list of numbers or strings, `{ count }` for ids `0` to `count - 1`, or a `Uint32Array`
or `Float64Array` of numbers. In a reference, `null` or NaN names no row.

(values)=

### `Values`

{.signature}
`type Values = Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array | readonly (number | null)[] | readonly (boolean | null)[] | readonly (string | null)[] | readonly (`[`Geometry`](#geometry) `| null)[]`

One field's values, one per row, with `null` for a missing value. Numbers come as a typed array
or an array. A `Uint8Array` holds booleans, where nonzero is true. Booleans, strings, and
geometries also come as arrays. Values are copied when passed, so the arrays can be reused right
away.

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
: For each row, the id of the row it references, or `null` or NaN to reference none.

(reference-function)=

### `reference()`

{.signature}
`function reference(table: string, ids:` [`RowIds`](#rowids)`):` [`Reference`](#reference)

Builds a [`Reference`](#reference) field: for each row, the id of the row it references in `table`.

(fields)=

### `Fields`

{.signature}
`type Fields = Readonly<Record<string,` [`Values`](#values) `|` [`Reference`](#reference)`>>`

A table's fields by name: values, or a [`Reference`](#reference).

(run)=

### `Run`

{.signature}
`interface Run`

A run of entries of a sampled field at one level of detail, for [`Patch.frames()`](#patch-frames).

{#run-level .member}
**`level`**`?: number` [¶](#run-level){.headerlink}
: The level of detail, from 0 to 21. Defaults to 0.

{#run-first .member}
**`first`**`: number` [¶](#run-first){.headerlink}
: The index of the first entry, a safe nonnegative integer.

{#run-at .member}
**`at`**`: Float64Array | readonly number[]` [¶](#run-at){.headerlink}
: Each frame's coordinate. At a bucket level, the coordinates of each bucket's first and last
  frames.

{#run-values .member}
**`values`**`: Float32Array | readonly number[]` [¶](#run-values){.headerlink}
: One value per row for each entry, entry by entry. At a bucket level, the per-row minimums of
  every bucket, then the per-row maximums of every bucket. NaN marks a missing value.

## Expressions

Builders for the per-row expressions that scene options take, including colors.

(expr)=

### `Expr`

{.signature}
`class Expr`

A value for every row of a mark: a constant, a color, a field, view state, or arithmetic on them.
Color options take one that computes a color: a CSS color, a value mapped through a colormap, or
a conditional that chooses between colors.

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
: Returns the JSON form. `JSON.stringify` calls it.

{#expr-from .member}
**`from`**`(table:` [`TableInput`](#tableinput)`): Expr` [¶](#expr-from){.headerlink}
: Reads this expression's fields from `table`, such as `weather.table('Station')`, joined by row
  id. The view also loads that table's dataset.

{#expr-step .member}
**`step`**`(): Expr` [¶](#expr-step){.headerlink}
: Reads this expression's sampled fields at the last frame at or before the view's `at`, without
  interpolating toward the next frame.

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

{#expr-fallback .member}
**`fallback`**`(other:` [`ExprInput`](#exprinput)`): Expr` [¶](#expr-fallback){.headerlink}
: This value, or `other` where this value is missing. Numbers and colors both work.

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
: Whether a text field equals `text`, plain text read as neither a field nor a color.

{#expr-contains .member}
**`contains`**`(text: string): Expr` [¶](#expr-contains){.headerlink}
: Whether a text field contains `text` (plain text), ignoring case. In a mark, the field must be
  in the mark's own table.

{#expr-colormap .member}
**`colormap`**`(map:` [`Colormap`](#colormap)`):` [`Mapped`](#mapped) [¶](#expr-colormap){.headerlink}
: Maps the value to a color through `map`, a catalog name or custom colors. The domain fits the
  values shown unless set with [`Mapped.domain()`](#mapped-domain).

{#expr-scale .member}
**`scale`**`(low: number, high: number):` [`Mapped`](#mapped) [¶](#expr-scale){.headerlink}
: Maps the value linearly onto `[low, high]`, clamped. The domain fits the values shown unless
  set with [`Mapped.domain()`](#mapped-domain).

(exprinput)=

### `ExprInput`

{.signature}
`type ExprInput =` [`Expr`](#expr) `|` [`ExprNode`](#exprnode)

An option's value: an [`Expr`](#expr) or its JSON form. In JSON, `null` is a missing value, a string
starting with `$` reads a field (`'$kv'` reads field `kv`), and any other string is a CSS color.
Color options take a value that computes a color.

(mapped)=

### `Mapped`

{.signature}
`class Mapped extends` [`Expr`](#expr)

A value mapped through a colormap or onto a range. Its input domain can be set.

```{rubric} Methods
```

{#mapped-domain .member}
**`domain`**`(low: number, high: number): Mapped` [¶](#mapped-domain){.headerlink}
: Sets the input values that map to the ends of the colormap or range. `'all'` spans every value
  the input field holds, in every frame of a sampled field, so colors stay put as `at` moves.
  Without it, the domain fits the values shown.

{.member}
**`domain`**`(all: 'all'): Mapped`
: Sets the input values that map to the ends of the colormap or range. `'all'` spans every value
  the input field holds, in every frame of a sampled field, so colors stay put as `at` moves.
  Without it, the domain fits the values shown.

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

Reads field `name` of each row. In JSON it is `'$name'`, or the `{ field }` form after `from()`
or `step()`.

(when-function)=

### `when()`

{.signature}
`function when(condition:` [`ExprInput`](#exprinput)`):` [`When`](#when)

Starts a conditional. `when(c).then(a).when(d).then(b).otherwise(e)` takes the value of the first
case whose condition holds, else `e`. The values may be numbers, colors, or a text field and
`null`, whichever the option takes.

(when)=

### `When`

{.signature}
`class When`

A conditional's first condition. `then` gives its value.

```{rubric} Methods
```

{#when-then .member}
**`then`**`(value:` [`ExprInput`](#exprinput)`):` [`Then`](#then) [¶](#when-then){.headerlink}
: Sets the value where the condition holds.

(then)=

### `Then`

{.signature}
`class Then`

A conditional's cases so far. Add a case with `when`, or finish with `otherwise`.

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

A conditional's next condition. `then` gives its value.

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

A size in CSS pixels in any space, so it stays the same on screen as the view zooms. `px(1)`
keeps a diagram's stroke 1 pixel wide at any zoom. Given a number, the result also works as a
theme length.

(units-function)=

### `units()`

{.signature}
`function units(size: number): { units: number }`

{.signature}
`function units(size:` [`ExprInput`](#exprinput)`, limits?: Omit<`[`Units`](#units)`, 'units'>):` [`Units`](#units)

A size in position units (degrees on the earth) in any space, so it scales as the view zooms.
`limits` bound its size on screen in CSS pixels: `units('$r', { atLeast: 2 })` grows with the
map and never shrinks below 2 pixels. A marker keeps its proportions, and the limits apply to its
larger side. Given only a number, the result also works as a theme length.

(meters)=

### `meters()`

{.signature}
`function meters(length:` [`ExprInput`](#exprinput)`):` [`Expr`](#expr)

A length given in meters, in degrees of arc: the earth's unit for positions, elevations, and
sizes in `units`. A degree is 111,194.93 meters on a sphere of the earth's mean radius.

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
`function colormaps(): typeof CATALOG`

Returns the catalog's colormaps in order, each with its name, its label such as `'Red / Blue'`,
its kind, and its colors as a custom colormap takes them. Needs no WebAssembly.

(colormapcss)=

### `colormapCss()`

{.signature}
`function colormapCss(map:` [`Colormap`](#colormap)`, direction?: string): string`

Returns a CSS `linear-gradient(...)` with the colors the GPU draws for `map`, a catalog name or a
custom colormap. `direction` is the CSS gradient direction and defaults to `'to right'`. A
categorical map gives one solid band per category.

## Views

Views, which draw scenes on canvases, and the GPU they draw with.

(view)=

### `View`

{.signature}
`class View extends` [`Handle`](#handle)

A scene drawn from its datasets on a canvas and into pictures. Create one with
[`View.create()`](#view-create). The canvas passes it pointer, wheel, and key input, and a `Shot` draws it
into pictures. Destroying a view rejects its unanswered queries, and its canvas keeps the last
frame.

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
: The part of its canvas, and of pictures, that the view draws in: `[x, y, width, height]` in
  fractions, from the top left. Views on one canvas draw in the order they were created.

{#view-scene .member}
**`scene`**`:` [`Scene`](#scene) [¶](#view-scene){.headerlink}
: The scene drawn. A mark that matches one in the previous scene by kind, dataset, table, and
  name keeps its state and eases to its new options. An option that does not fit the data draws
  as if unset, and a mark that does not fit draws nothing. Both are listed in `failures` until
  the data fits. A scene that is invalid on its own throws and leaves the current one in place.

{#view-sources .member}
**`sources`**`: readonly` [`Source`](#source)`[]` [¶](#view-sources){.headerlink}
: Datasets the view draws besides those its scene uses. A source replaces a scene dataset with
  the same name. A mark whose table is written `[data, table]` draws the source named `data`. The
  view draws a [`Data`](#data) at its latest version from the frame after each change, a [`Snapshot`](#snapshot) as it
  is, and [`Tiles`](#tiles) as the pieces it needs. A mark whose dataset no longer fits it draws nothing.
  It is listed in `failures`, and the next frame emits an `error` event.

{#view-at .member}
**`at`**`: number` [¶](#view-at){.headerlink}
: The axis coordinate shown, such as a time. Marks read sampled fields at it, interpolating
  between the frame at or before it and the next, unless an expression uses `step()`.

{#view-camera .member}
**`camera`**`:` [`Camera`](#camera) [¶](#view-camera){.headerlink}
: Where the view looks. Setting it moves the camera at once, replacing a flight or a fit not yet
  applied. Fields left out keep their values, and setting only pitch and bearing keeps that fit,
  which then frames at them. Use [`View.fly()`](#view-fly) to ease. A camera of the wrong kind for the
  space, such as a plot camera on a map, is ignored.

  Camera moves stay within the camera's zoom and pan limits. On the earth, the space sets the
  limits inside the insets, as [`Earth`](#earth) describes. A fit narrows them to 3 zoom levels out and 8
  in from the box it framed, with the center near that box. When a resize, new insets, or a new
  space moves the camera back within its limits, a `camera` event reports it.

{#view-insets .member}
**`insets`**`:` [`Insets`](#insets) [¶](#view-insets){.headerlink}
: CSS pixels kept clear at the top, right, bottom, and left, such as where page panels cover the
  view. The camera centers and fits within the rest.

{#view-orbit .member}
**`orbit`**`: number` [¶](#view-orbit){.headerlink}
: Degrees per second the camera turns about its center on a map or plane. 0 stops it. A diagram
  never turns.

{#view-selection .member}
**`selection`**`: readonly` [`Rows`](#rows)`[]` [¶](#view-selection){.headerlink}
: The selected rows, one set per table. Setting it selects exactly those rows.

{#view-hovered .member}
`readonly` **`hovered`**`:` [`Hit`](#hit) `| null` [¶](#view-hovered){.headerlink}
: The row under the pointer or the row keyboard navigation moved to, or `null`.

{#view-waiting .member}
`readonly` **`waiting`**`:` [`Waiting`](#waiting) [¶](#view-waiting){.headerlink}
: The kinds of pending work that kept the last frame from being complete. Empty when it was
  complete. See [`Waiting`](#waiting).

{#view-complete .member}
`readonly` **`complete`**`: boolean` [¶](#view-complete){.headerlink}
: Whether the last frame was complete, with nothing in `waiting`. False until the first frame.
  Shots wait for this.

{#view-failures .member}
`readonly` **`failures`**`: readonly` [`LatkitError`](#latkiterror)`[]` [¶](#view-failures){.headerlink}
: An error for each option that draws as if unset, and each mark that draws nothing, because the
  data does not fit it, such as a missing field or table. Each error's `path` names the mark and
  option, such as `marks[2].color`.

{#view-stats .member}
`readonly` **`stats`**`:` [`Stats`](#stats) [¶](#view-stats){.headerlink}
: Counts and timings of the view's frames; see [`Stats`](#stats).

{#view-wantsframe .member}
`readonly` **`wantsFrame`**`: boolean` [¶](#view-wantsframe){.headerlink}
: Whether the view needs a frame, because it changed or work it was waiting on arrived.

```{rubric} Methods
```

{#view-create .member}
`static` **`create`**`(canvas: HTMLCanvasElement | OffscreenCanvas | null, scene:` [`Scene`](#scene)`, options?: { region?:` [`Rect`](#rect)`; camera?: Partial<`[`Camera`](#camera)`>; sources?: readonly` [`Source`](#source)`[]; gpu?:` [`Gpu`](#gpu)`; pixelRatio?: number } &` [`Wait`](#wait)`): Promise<View>` [¶](#view-create){.headerlink}
: Creates a view that draws `scene` on `canvas`, in `options.region`, over any views already
  there. With a `null` canvas, the view draws only into pictures. The view loads every dataset
  its scene uses. Unless given a camera, it frames everything when it first draws. Creating the
  default GPU waits within `options`.

  {#view-create-region .member}
  **`region`**`?:` [`Rect`](#rect) [¶](#view-create-region){.headerlink}
  : The part of the canvas, and of pictures, that the view draws in. Defaults to all of it.

  {#view-create-camera .member}
  **`camera`**`?: Partial<`[`Camera`](#camera)`>` [¶](#view-create-camera){.headerlink}
  : Where the view looks first. Without a center and zoom (or a plot's `x`), it frames
    everything drawn, at the camera's pitch and bearing.

  {#view-create-sources .member}
  **`sources`**`?: readonly` [`Source`](#source)`[]` [¶](#view-create-sources){.headerlink}
  : Datasets to draw besides those the scene uses. See [`View.sources`](#view-sources).

  {#view-create-gpu .member}
  **`gpu`**`?:` [`Gpu`](#gpu) [¶](#view-create-gpu){.headerlink}
  : The GPU that draws the view. Defaults to the first [`Gpu`](#gpu) created, creating one if needed.

  {#view-create-pixelratio .member}
  **`pixelRatio`**`?: number` [¶](#view-create-pixelratio){.headerlink}
  : Pixels per CSS pixel of an `OffscreenCanvas`. Defaults to 1. The first view on the canvas
    sets it.

{#view-done .member}
**`done`**`(wait?:` [`Wait`](#wait)`): Promise<void>` [¶](#view-done){.headerlink}
: Resolves once a frame draws the view complete, at once if the last frame did.

{#view-fit .member}
**`fit`**`(fit?:` [`Fit`](#fit)`, wait?:` [`Wait`](#wait)`): Promise<`[`Camera`](#camera) `| null>` [¶](#view-fit){.headerlink}
: Frames what `fit` names, keeping pitch and bearing, and replaces any fit not yet applied. A
  reveal asked for while another fit is due follows that fit instead. Defaults to every row. It
  applies once the rows have their places (their data streamed, any layout placed them, and they
  eased there), a frame or two later when the GPU must measure the extent. With nothing drawn to
  frame, it frames the rows that arrive later. Until a view's first fit applies, it shows only
  its background. A fit frames a diagram at most at its natural size and the earth at most at
  zoom 16, which is also where it frames a single point. Resolves to the camera it framed, or to
  `null` when a camera move or another fit replaces it.

{#view-fly .member}
**`fly`**`(camera: Partial<`[`Camera`](#camera)`>, seconds?: number): void` [¶](#view-fly){.headerlink}
: Eases the camera to `camera` over `seconds`, or over twice the scene's ease time without it,
  replacing a fit not yet applied. Fields left out keep their values. When motion is reduced, it
  moves at once. The camera stays within its limits, as [`View.camera`](#view-camera) describes. A camera
  of the wrong kind for the space is ignored.

{#view-screen .member}
**`screen`**`(position:` [`Position`](#position)`):` [`Point`](#point) `| null` [¶](#view-screen){.headerlink}
: Projects `position` to a point on screen with the current camera, for anchoring HTML overlays.
  Returns `null` when the position is behind the camera.

{#view-position .member}
**`position`**`(point:` [`Point`](#point)`):` [`Position`](#position) `| null` [¶](#view-position){.headerlink}
: Returns the position on the ground under screen point `point`: at elevation 0 on a plane, on
  the map or globe on the earth, and the values there on a plot. Returns `null` where the point
  looks past the ground.

{#view-screenof .member}
**`screenOf`**`(row:` [`Row`](#row)`, options?: { port?: string } &` [`Wait`](#wait)`): Promise<`[`Point`](#point) `| null>` [¶](#view-screenof){.headerlink}
: Resolves to where `row`, or its port, is on screen once a frame draws the view, or to `null`
  when no mark draws it in view. A diagram's vertices and ports resolve at once.

  {#view-screenof-port .member}
  **`port`**`?: string` [¶](#view-screenof-port){.headerlink}
  : A port of the row, by the reference field naming its net. Only a diagram has ports.

{#view-pick .member}
**`pick`**`(point:` [`Point`](#point)`, options?: { radius?: number } &` [`Wait`](#wait)`): Promise<`[`Hit`](#hit)`[]>` [¶](#view-pick){.headerlink}
: Resolves, once a frame draws the view, to every row of a pickable mark near `point`, nearest
  first.

  {#view-pick-radius .member}
  **`radius`**`?: number` [¶](#view-pick-radius){.headerlink}
  : How near, in CSS pixels. Defaults to 0.

{#view-neighbors .member}
**`neighbors`**`(row:` [`Row`](#row)`):` [`Rows`](#rows)`[]` [¶](#view-neighbors){.headerlink}
: Returns the rows connected to `row`, one set per table: a vertex's neighbors across edges and
  nets, or the vertices of an edge or net. The cost is proportional to the row's degree.

{#view-arrange .member}
**`arrange`**`(rows?:` [`Arrange`](#arrange)`, wait?:` [`Wait`](#wait)`): Promise<`[`Patch`](#patch)`[]>` [¶](#view-arrange){.headerlink}
: Lays out again the vertex rows that `rows` names, those without a position or all of them, and
  resolves to one patch per dataset. Each patch writes each row's place into its mark's position
  fields, so applying it makes the places part of the data. Marks that don't read their position
  from fields are left out.

  ```ts
  for (const patch of await view.arrange('all')) if (patch.data === grid.name) grid.apply(patch);
  ```

{#view-snapshot .member}
**`snapshot`**`(name: string):` [`Snapshot`](#snapshot) `| undefined` [¶](#view-snapshot){.headerlink}
: Returns the version of dataset `name` that the view draws, or `undefined` if it draws no
  dataset by that name. That is the latest version of a [`Data`](#data) the view has taken, the snapshot
  it was given, or the pieces of [`Tiles`](#tiles) fetched for its camera.

{#view-on .member}
**`on`**`<T extends keyof` [`ViewEvents`](#viewevents)`>(type: T, listener: (event:` [`ViewEvents`](#viewevents)`[T]) => void): () => void` [¶](#view-on){.headerlink}
: Calls `listener` with each event of `type` emitted while it is registered. Returns a function
  that removes it. Past events are not replayed. Read the current state from the property that a
  change event is named after.

(rect)=

### `Rect`

{.signature}
`type Rect = readonly [x: number, y: number, width: number, height: number]`

A region `[x, y, width, height]` in fractions of a canvas or picture, from its top left.

(viewevents)=

### `ViewEvents`

{.signature}
`type ViewEvents = { [E in` [`ViewEvent`](#viewevent) `as E['type']]: E extends { type: 'error' } ?` [`LatkitError`](#latkiterror) `: E['detail'] }`

The events a view emits, mapping each type to its detail. Intents (`click`, `open`, `menu`,
`drag`, `connect`, `delete`) are emitted once each, in the order the user acted. Changes
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

A WebGPU device that views draw with. Views on one `Gpu` share its memory and draw together in
each animation frame, so linked views always show the same moment. Views use the first `Gpu`
created unless given another, and [`View.create`](#view-create) creates one if none exists. When the device is
lost, latkit requests a new one and moves the views, their canvases, and the frame listeners to
it. Destroying a `Gpu` destroys its views and frame listeners. Other GPUs and datasets stay
usable.

```{rubric} Properties
```

{#gpu-lost .member}
`readonly` **`lost`**`: boolean` [¶](#gpu-lost){.headerlink}
: Whether the device is lost. latkit then requests a new one, so this is true only until it
  arrives, or when there is none. Also true once an internal error stopped latkit.

{#gpu-budget .member}
**`budget`**`:` [`Budget`](#budget) [¶](#gpu-budget){.headerlink}
: The GPU memory budget for data, shared by every view on this GPU. See [`Budget`](#budget). Defaults
  to half the device's largest storage buffer, with 32 MiB uploaded per frame.

{#gpu-work .member}
`readonly` **`work`**`:` [`Work`](#work) [¶](#gpu-work){.headerlink}
: Exact counts of the work this GPU has done since it was created. See [`Work`](#work). The same
  budget, device limits, and frames give the same counts, so tests and benchmarks can assert
  them.

{#gpu-resident .member}
`readonly` **`resident`**`: number` [¶](#gpu-resident){.headerlink}
: Bytes of GPU memory the views draw from: data pages and each view's per-row data.

{#gpu-uploading .member}
`readonly` **`uploading`**`: number` [¶](#gpu-uploading){.headerlink}
: Bytes waiting to upload to the GPU, across all its views.

```{rubric} Methods
```

{#gpu-create .member}
`static` **`create`**`(wait?:` [`Wait`](#wait)`): Promise<Gpu>` [¶](#gpu-create){.headerlink}
: Requests a WebGPU device. The first call takes the device [`load()`](#load) requested. Create one before
  any view to set its `budget` first, or create another for views that should not share memory
  with the rest. Loading and the request wait within `wait`. Rejects with an `unsupported` error
  when the browser has no WebGPU device.

{#gpu-on .member}
**`on`**`(type: 'frame', listener: (now: number) => void): () => void` [¶](#gpu-on){.headerlink}
: Calls `listener` every animation frame with the frame's timestamp in milliseconds. It runs
  before the views draw, so its changes show in that frame. While any listener is registered, a
  frame runs on every animation frame. Returns a function that removes the listener.

{#gpu-step .member}
**`step`**`(now: number): void` [¶](#gpu-step){.headerlink}
: Draws one frame now, at `now` milliseconds on the `requestAnimationFrame` clock. It runs the
  frame listeners, then draws every canvas that needs a frame. After the first call the GPU
  stops requesting animation frames, so a test or benchmark that steps every frame draws the
  same frames on any device.

{#gpu-done .member}
**`done`**`(wait?:` [`Wait`](#wait)`): Promise<void>` [¶](#gpu-done){.headerlink}
: Resolves once the GPU has finished its submitted work, every readback has arrived, and every
  pipeline a view or shot requested has compiled. A frame stepped after that uses all of them.

{#gpu-landed .member}
**`landed`**`(wait?:` [`Wait`](#wait)`): Promise<void>` [¶](#gpu-landed){.headerlink}
: Resolves when work a view waits on arrives after this call (a readback, a pipeline compile, a
  job, a label text, or a fetch), or when a view requests a frame. A harness that steps frames
  awaits it to know when to step again.

## Pictures and video

Shots draw views into images and video.

(shot)=

### `Shot`

{.signature}
`class Shot`

A picture of views, `size` pixels in all, with each view drawn in its region. While a shot draws
a view, the view's canvas keeps its last frame. An image draws each view's data as it was when
the picture began. `Shot.of(view)` makes a shot of what a view's canvas shows.

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
  : The views drawn, later views over earlier ones. Each draws in its own region, or in
    `region` when given as `{ view, region }`.

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
: Returns a shot of exactly what the canvas showing `view` shows: its views in their regions, at
  the canvas's CSS size times `options.scale` in pixels. Throws an `invalid` error for a view on
  no canvas. Give such a shot a size with the constructor.

{#shot-image .member}
**`image`**`(wait?:` [`Wait`](#wait)`): Promise<`[`Image`](#image)`>` [¶](#shot-image){.headerlink}
: Draws the picture once every view is complete, as `capture` says, and resolves to the
  [`Image`](#image). Rejects with the first error a view reports while drawing.

{#shot-video .member}
**`video`**`(options: { fps: number; output: WritableStream<Uint8Array>; bitrate?: number } &` [`Wait`](#wait)`):` [`Video`](#video) [¶](#shot-video){.headerlink}
: Starts a video of this shot: H.264 in MP4, written to `options.output` as frames are drawn. The
  width is rounded down to a multiple of 4 and the height to an even number, as the encoder
  requires. Canvases showing the views keep their last frame until the video finishes or aborts.
  Aborting `options.signal` aborts the video and its output. Frames have no other time limit.

  {#shot-video-fps .member}
  **`fps`**`: number` [¶](#shot-video-fps){.headerlink}
  : Frames per second.

  {#shot-video-output .member}
  **`output`**`: WritableStream<Uint8Array>` [¶](#shot-video-output){.headerlink}
  : Where the file's bytes go, locked until the video finishes or aborts.

  {#shot-video-bitrate .member}
  **`bitrate`**`?: number` [¶](#shot-video-bitrate){.headerlink}
  : Bits per second. Defaults to about 0.15 bits per pixel per frame.

(shotoptions)=

### `ShotOptions`

{.signature}
`interface ShotOptions`

Options for a [`Shot`](#shot).

{#shotoptions-scale .member}
**`scale`**`?: number` [¶](#shotoptions-scale){.headerlink}
: Pixels per CSS pixel. Defaults to 1. Views lay out at `size / scale` CSS pixels, so 2 draws the
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
: The time in seconds that [`elapsed()`](#elapsed) expressions and flowing comets show in a still picture.
  Defaults to the view's clock.

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
: Where it draws in the picture, overriding its own region.

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
  : JPEG quality, from 1 (smallest) to 100 (sharpest). Defaults to 90.

(imageformat)=

### `ImageFormat`

{.signature}
`type ImageFormat = 'png' | 'jpeg' | 'webp'`

An image file format for [`Image.encode()`](#image-encode).

(video)=

### `Video`

{.signature}
`class Video`

A video being drawn, encoded, and written. Create one with [`Shot.video()`](#shot-video). Draw frames with
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
: Draws the next frame once its views are complete, then writes its bytes, waiting on the
  output's backpressure. Calls must not overlap. A call made before the previous one resolves,
  or after `finish()`, rejects with an `invalid` error. A call after `abort()` rejects with a
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
