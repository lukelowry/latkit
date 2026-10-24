# Guide

How latkit works: datasets and the patches that change them, scenes, views, and pictures, and
what it takes to ship them.

## Data

A dataset is a name and its tables. A table is rows, each with an id, and fields, a value per row.
Patches change datasets all at once: every change of a patch, or none.

### Write a dataset

```ts
import { Data, Patch, field, load, reference } from 'latkit';

await load();
const grid = new Data('grid').apply(
  new Patch()
    .replace('Bus', [101, 102, 103], {
      lon: Float64Array.of(-97.7, -97.6, -97.5),
      lat: Float64Array.of(30.2, 30.3, 30.4),
      name: ['North', 'Mid', null],
    })
    .replace(
      'Branch',
      { count: 2 },
      {
        from: reference('Bus', [101, 102]),
        to: reference('Bus', [102, 103]),
        name: ['North-Mid', 'Mid-South'],
        loading: [95, 70],
      },
    ),
);
```

- **Ids** are nonnegative safe integers (`0..2^53 - 1`) or texts, listed, or `{ count: n }` for rows `0` to `n - 1`.
- **Values** are a column per field: typed arrays of numbers (a `Uint8Array` holds booleans), or
  arrays of numbers, booleans, texts, or geometries. `null` is missing.
- **Geometries** are `[x, y]` points, paths of points, parts (a polygon's rings, or a path's
  pieces), or polygons.
- **References** name rows of another table by id: `reference(table, ids)`.

| Change                                               | Does                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `replace(table, ids, fields)`                        | replaces the table, or adds it                                       |
| `set(table, ids, fields)`                            | writes fields for those rows: known ids change, others are added     |
| `remove(table, ids)`                                 | removes the rows                                                     |
| `axis(name, unit)`                                   | names the axis sampled fields are recorded over                      |
| `append(table, at, fields, { ids })`                 | records a frame at each coordinate of `at`, of every row or of `ids` |
| `forget(before)`                                     | forgets the frames before a coordinate                               |
| `frames(table, field, { level, first, at, values })` | holds a run of a sampled field's entries, as a time tile does        |

### Change it

`apply` changes a dataset in place, and every view drawing it draws the change from the next frame.
A snapshot keeps one version in O(1), sharing its pages, so an undo history costs only what
changed:

```ts
const before = grid.snapshot();
grid.apply(new Patch().set('Bus', [101], { name: ['Northgate'] })); // drawn the next frame
grid.restore(before); // and undone
```

### Record over time

Sampled values are stored as `f32`, including values supplied as `Float64Array`; coordinates
remain `f64`. NaN means missing in sampled values and numeric query results. Static columns retain
their original numeric storage. A field's first frame makes it sampled. A view shows the axis
coordinate `view.at`: each sampled field reads its last frame at or before it.

```ts
grid.apply(new Patch().axis('time', 's'));
grid.apply(new Patch().append('Bus', 0.5, { vm: Float32Array.of(1.01, 0.99, 1.0) }));
grid.apply(new Patch().append('Bus', [1, 1.5], { vm: Float32Array.of(1, 1, 1, 0.98, 0.97, 0.99) }));
grid.apply(new Patch().append('Bus', 2, { vm: [1.02] }, { ids: [101] })); // one row; the rest hold
grid.apply(new Patch().forget(1)); // a rolling window
view.at = 1.2;
```

Each sampled field keeps levels of detail as it records: at level `k`, each row's least and
greatest value over buckets of `8^k` frames. A line tracing a field across a plot reads the level
that gives each pixel column a bucket or two, so a long history draws as fast as a short one.

### Fetch long histories in spans

A history too large to load whole is written as time tiles, and a view fetches only what it draws:

```sh
latkit tile history.latk -o history/
```

```ts
view.sources = [new Tiles('grid', 'history/frames.json')];
```

`tile` writes `frames.json`, `base.latk` (the dataset with every sampled field's frames left out),
and each field's history in spans of `--chunk` entries, at every level of detail
(`Snapshot::to_tiles` in Rust). A line tracing a field fetches the spans its plot window draws, at
the detail it draws them, and a mark showing a field fetches the frames about `view.at`. A span
still loading draws the coarser span above it, as a map tile still loading draws the tile a zoom
out.

### Stream

Patches are bytes: `patch.toBytes()` writes one frame, and frames back to back stream. Each frame
says its length up front. The parser holds at most one frame of `limit` bytes (256 MiB by default),
in addition to the input chunk and patches you retain. Breaking iteration cancels the reader. A
server in any language writes the same frames ([format](#bytes)).

```ts
for await (const patch of Patch.stream((await fetch('/feed')).body!)) grid.apply(patch);
```

A patch made with `new Patch('grid')` names its dataset, and `apply` refuses it for another.

### Read files

```ts
const grid = await Data.read('data/grid.json'); // a JSON document, its slices relative to it
const saved = await Data.read(bytes); // latkit's bytes, as data.toBytes() wrote them
const states = await Data.read(geojson, { name: 'states' }); // GeoJSON, gzip-compressed or not
```

GeoJSON becomes tables `points`, `lines`, and `polygons`, each with its geometry as field
`geometry` and its properties as fields; it is read in a worker. The JSON document's form is in
[Formats](#json). `Patch.read(source)` reads one patch the same ways, its bytes without
WebAssembly.

### Read back

Reading needs no GPU. Queries run the expressions marks draw with:

```ts
grid.get('Bus', 101, 'name'); // 'Northgate'
const hot = grid.query({
  of: 'Branch',
  filter: field('loading').gt(90),
  sort: [['loading', 'descending']],
  select: { name: 'name', loading: 'loading' },
  limit: 20,
});
// { table, ids, fields: { name: string[], loading: Float64Array }, total }
```

`total` counts the rows kept before `limit`. `field('name').contains('north')` matches texts in
queries. `describe()` lists tables, rows, fields and their kinds, and the axis and its span.
`envelope({ table, field, range, spans, ids })` gives each row's least and greatest value of a
sampled field over equal spans of the axis, read from levels of detail, so a span costs a few reads
however many frames it covers. A `Snapshot` reads the same way, as of its version.

`patch.extend(next)` appends another patch's operations. `Uint8Array` means booleans in
JavaScript patches; JSON binary slices with dtype `u8` mean numbers. Use `Uint32Array` for unsigned
numeric bytes in a JavaScript patch. For all method signatures, see the
[API reference](reference/api.md).

## Scenes

A scene is plain data: a `space`, `marks` drawn in order, and optionally a `layout`, `theme`,
`controls`, `ease` (seconds changes ease over), and a `title` and `subtitle`. A view draws a scene;
`view.scene = next` replaces it, keeping every row's place in the transition.

```ts
const scene: Scene = {
  space: 'earth',
  marks: [
    { edges: { of: ['grid', 'Branch'], ends: ['from', 'to'], width: 1.5 } },
    {
      vertices: {
        of: ['grid', 'Bus'],
        position: ['lon', 'lat'],
        radius: units('kv', { atLeast: 2 }),
        color: field('vm').colormap('balance').domain(0.95, 1.05),
        label: { text: 'name', priority: 'kv' },
        legend: 'Voltage (pu)',
      },
    },
  ],
  theme: { base: 'light', vertex: { radius: 4 } },
  controls: 'inspect',
};
```

### Spaces

| Space       | Positions                                                         |
| ----------- | ----------------------------------------------------------------- |
| `'plane'`   | plane units with elevation; the camera turns and tilts            |
| `'earth'`   | longitude and latitude in degrees, on a map or a globe            |
| `'plot'`    | the axis coordinate across, values up                             |
| `'diagram'` | a flat sheet, y down, every length a unit; ports, groups, layouts |

Each takes options as `{ plane: { grid } }`, `{ diagram: { grid } }`, `{ earth: { projection,
graticule, daylight, atmosphere } }`, or `{ plot: { x, y } }`. The earth's `projection` is
`'mercator'` (the default) or `'globe'`. A grid is `'off'`, `{ lines: { pitch } }`, or
`{ dots: { pitch, snap } }`. A plot's axes measure their labels and titles and leave room for them.

### Marks

Every mark names its table, `of: [dataset, table]`, and takes `color`, `visible`, `priority`,
`label`, `legend`, `name`, and `pick`, `select`, and `drag`. Unless `pick` says, rows
that are things are hovered, clicked, and probed (vertices, edges, faces, a plot's traces) and
geometry is not (areas, and lines along paths: coasts, borders, roads), so hovering probes none of
it; `pick: true` makes a map's states or cells answer the pointer.

| Mark       | Draws each row as                                                  | Its own options                                                                |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `vertices` | a marker at `position` (or the point field `geometry`)             | `elevation`, `radius`, `size`, `marker`, `ring`, `ports`, `contains`, `shadow` |
| `edges`    | a stroke between the rows two reference fields name                | `ends`, `bends`, `route`, `arrows`, `width`, `dash`, `flow`                    |
| `lines`    | a path field's stroke; on a plot, a sampled field traced over time | `geometry`, `trace`, `interpolation`, `width`, `dash`, `flow`                  |
| `areas`    | the area a polygon field covers                                    | `geometry`                                                                     |
| `faces`    | a triangle between three vertices                                  | `corners`                                                                      |

A `flow` sends comets along a stroke. In a diagram, vertices are blocks with `ports`, a vertex mark
with `contains` draws groups around the rows that name it, and edges of a table without `ends` are
nets joining the ports that name them. The theme's `diagram` group (`outline`, `corner`,
`portSize`, `bend`) sets how blocks, groups, ports, and wires look, and `shadow: true` lifts blocks
and groups off the sheet.

Edges whose ends lie far apart draw within the budget too: the vertices they end at are held a row
at a time where few of a table's pages hold them.

### Expressions

Options that vary by row take expressions: a number, a field name, or a builder. Colors are values
of their own: a string is a CSS color, and a field colors rows through a colormap or a condition.

```ts
import { field, when, selected, units, px } from 'latkit';

field('load').div(field('capacity')).clamp(0, 1); // arithmetic and comparisons
field('vm').colormap('balance').domain(0.95, 1.05); // a color through a colormap
field('kv').scale(2, 8); // onto a range
when(selected()).then('#ffb000').otherwise(field('kind').colormap('tableau10')); // colors
units('radius', { atLeast: 2 }); // a size in position units, kept within pixels
px(3); // a size in CSS pixels, however the view zooms
field('vm').from('weather', 'Station'); // read from another dataset, joined by id
```

A size is CSS pixels on a plane, the earth, and a plot, and position units in a diagram, unless
`px()` or `units()` says. State expressions read the view: `selected()`, `hovered()`, `pointer()`,
`elapsed()`, `zoom()`. Colormaps are a catalog name or your own colors, `{ kind, colors }`; a
categorical map can name its `categories` for its legend. `colormapCss(map)` gives the same colors
as a CSS gradient.

### Themes, controls, and layouts

- **Theme**: `'dark'`, `'light'`, or options over a base, a group for each kind of thing drawn:
  `{ base: 'light', text: { size: 12 }, edge: { width: 2 } }`. `edge: { color: null }` blends each
  edge's ends' colors, and `focus: { selected: null }` glows in each row's own color. A comet's
  spacing and length take `{ px: n }` or `{ units: n }`.
- **Controls**: `'inspect'` (the default), `'none'`, or options: `pan`, `zoom`, `turn`,
  `keyboard`, `hover`, `pickRadius`, `selectBox`, `connect`, `delete`, `cycle`, `press`, `motion`.
- **Layout** places vertex rows without positions: `'stress'`, `'layered'`, or their options. A
  place, once given, holds; `view.arrange()` lays every row out again.

## Views

A `Gpu` makes views and canvases. A view draws one scene from its sources, each a dataset by its
name; a canvas shows views, one per panel, and passes each the input on its panel.

```ts
const gpu = await Gpu.create();
const map = gpu.view(mapScene, { sources: [grid] });
const plot = gpu.view(plotScene, { sources: [grid] });
gpu.canvas(element, {
  layout: [
    { view: map, at: [0, 0, 1, 0.7] },
    { view: plot, at: [0, 0.7, 1, 0.3] },
  ],
});
```

### Sources

`view.sources` lists what a view draws, each by its name: a `Data`, its latest version, from the
frame after each patch applies; a `Snapshot`, as it is; or `Tiles`, fetched in pieces as the view
asks for them, every view of a GPU sharing what is fetched: [time tiles](#fetch-long-histories-in-spans),
a `frames.json` manifest, or vector tiles as the camera asks for them (a PMTiles archive, a TileJSON
document, or a `{z}/{x}/{y}` template), each layer a table of the kind marks draw it as, or named
`layer:polygons`, `layer:lines`, or `layer:points`. `view.snapshot(name)` is the version of a
source the view draws now, tiles fetched so far included.

### Camera

```ts
view.fit(); // everything drawn
view.fit({ rows: [{ data: 'grid', table: 'Bus', ids: [101, 102] }] });
view.fly({ center: [-97.7, 30.3], zoom: 8, pitch: 40, bearing: 0 }); // ease there
view.camera = { x: [0, 60], y: null }; // a plot's camera: the axis range, values fitted
view.insets = [48, 0, 0, 320]; // CSS pixels kept clear: top, right, bottom, left
view.orbit = 6; // degrees a second
```

### Events

`view.on(type, listener)` returns a function that stops listening. Intents are told once each, in
the order the user acted: `click`, `open`, `menu`, `drag`, `connect`, `delete`. Changes tell only
their latest, and their state can always be read: `hovered` (`view.hovered`), `selection`
(`view.selection`), `camera`, and `waiting` (`view.waiting`). A view tells only what the
application did not do: its setters change state silently.

```ts
view.on('click', ({ hit }) => console.log(hit.row, hit.point));
view.on('drag', ({ hit, position }) => move(hit.row, position)); // where the row goes, as grabbed
view.on('selection', ({ rows }) => inspect(rows));
view.on('error', (error) => console.error(error.code, error.path, error.message));
```

### Rows

A row is `{ data, table, id }`; a set of rows of one table is `{ data, table, ids }`. The selection,
`selection` events, `delete` events, fits, and neighbors are sets:

```ts
view.selection = [{ data: 'grid', table: 'Bus', ids: [101, 102] }];
const joined = view.neighbors({ data: 'grid', table: 'Bus', id: 101 }); // across edges and nets
const hits = await view.pick([x, y], { radius: 8 }); // rows within 8 CSS pixels, nearest first
const at = await view.screenOf({ data: 'grid', table: 'Bus', id: 101 }); // [x, y] on screen, or null
```

Picks and locations answer once a frame draws the view. Every wait takes `{ signal }` and ends at
it, 30 seconds unless given: it rejects with `timeout` when it timed out, and with `cancelled` when
it was aborted or the view was destroyed.

### Layouts into data

In a diagram, or on a plane with a layout, rows without positions are placed by it.
`view.arrange()` lays every row out again and answers a patch to each dataset writing the places
into its position fields:

```ts
for (const patch of await view.arrange()) if (patch.data === grid.name) grid.apply(patch);
```

### Stats and memory

`view.stats` tells rows drawn, draw calls, tiles, and CPU and GPU milliseconds a frame;
`gpu.resident` and `gpu.uploading` the bytes of data on the GPU and waiting to upload, for every
view of it. `gpu.work` counts exactly what the GPU did: bytes uploaded, written, and cleared, rows
evaluated, whose ends it found, and packed, readbacks, jobs, texts, and pipelines.
`gpu.budget = { bytes, uploadPerFrame }` sets how much memory data takes, and how much of it a frame
uploads. The GPU's views share it: a view gets what it asks while an even split covers it, and the
rest split what is left; pages several views draw count once. A table too large for its view's
share draws through the tiles in view, a page of its order at a time; a page it drew stays on the
GPU while its share leaves room, so the camera coming back draws it again for nothing.

A frame does the work of what changed: a patch evaluates only the pages it wrote, unless a fitted
domain or a join reads them; a transition evaluates once and blends each frame; and rows drawn
through tiles keep their places while the camera moves, so only arriving rows upload.

`Data`, `Snapshot`, `Gpu`, `View`, `Canvas`, and `Image` have an idempotent `destroy()` and
`Symbol.dispose`; destroying a `Gpu` destroys its canvases, views, and frame listeners.

Videos are asynchronous resources: finish them with `await video.finish()` or cancel with
`await video.abort(reason)`. `record` cleans up on errors automatically.

`gpu.lost` tells whether the device is gone. Create a new GPU, views, and canvases to recover,
then supply retained scenes and datasets. `view.failures` contains input/loading failures;
`view.wantsFrame` is useful for custom scheduling. For manual rendering use `gpu.step(now)`;
`gpu.done()` waits for drawing to settle, and `gpu.landed()` waits for pending work to arrive.
`view.position([x, y])` is the position under a canvas point, and `view.screen(position)` the
point a position draws at.

## Pictures and video

A `Shot` is plain data: a size in pixels, and how views are drawn into it. It draws views whether or
not a canvas shows them; a canvas showing one holds its last frame meanwhile. `canvas.shot()` is a
picture of exactly what a canvas shows.

```ts
const shot = new Shot([3840, 2160], { scale: 2, layout: [{ view }] }); // 1920 by 1080 CSS pixels
const image = await shot.image(); // once the view is complete and still
const png = await image.encode('png'); // or 'jpeg' with { quality }, or 'webp'
image.destroy();
```

| Option        | Does                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `scale`       | draws `scale` pixels per CSS pixel                                      |
| `layout`      | the views and where each draws, `at: [x, y, width, height]` fractions   |
| `transparent` | keeps alpha where the themes' backgrounds are                           |
| `capture`     | once views are complete and still (`'still'`), or as they are (`'now'`) |
| `elapsed`     | fixes time-reading expressions and effects at `elapsed` seconds         |

Files are encoded in a worker when workers are available; otherwise encoding runs on the calling thread.

### Video

`shot.video({ fps, output, bitrate })` encodes H.264 in MP4 with WebCodecs as frames are drawn, and
writes it to a `WritableStream`: a file handle's, or a buffer's. `record` steps the views to each
frame's time; returning `false` finishes the video.

```ts
const file = await (await showSaveFilePicker()).createWritable();
const video = new Shot([1920, 1080], { layout: [{ view }] }).video({
  fps: 60,
  output: file,
  bitrate: 12e6,
});
await video.record((time) => {
  view.at = time;
  return time < 10;
});
```

Width and height are multiples of 4 and 2. A frame where nothing moved is held rather than drawn.
`{ signal }` aborts a video: its output is aborted and its views are given back.

For manual control, call `await video.frame()` one frame at a time, then `await video.finish()`.
Finish and abort are idempotent; both release the output's writer lock, encoder, and abort
listener. Frame/time counters remain readable after completion. A failed step, frame, write, or
progress callback aborts `record`. Cancellation interrupts pending rendering and encoding; an
arbitrary writable sink must still settle its own in-flight write before its lock can be released.
Browser output uses Constrained Baseline H.264, with output timestamps checked against input order.

## Formats

### Schema

Everything latkit reads and writes as JSON has a JSON Schema, derived from the same declarations
that read and write it: `latkit schema` prints it, and the npm package's types are written from it.
Its `$defs` are the inputs (`Scene`, `Data`, `Patch`, `Query`, `Camera`, `Fit`, `Budget`, `Shot`)
and its `outputs` what latkit writes back (`ViewEvent`, `Stats`, `Work`, `Description`, `Rows`,
`Camera`, `Budget`, `Value`, `Failure`).

(json)=

### JSON

A dataset's document is its name and the patch that builds it. A patch is a list of changes, each
named by its method with its parameters by name:

```json
{
  "name": "grid",
  "patch": [
    {
      "replace": {
        "table": "Bus",
        "ids": [101, 205],
        "fields": { "x": [0, 10], "name": ["North", null] }
      }
    },
    {
      "replace": {
        "table": "Branch",
        "ids": { "count": 1 },
        "fields": {
          "from": { "reference": "Bus", "ids": [101] },
          "to": { "reference": "Bus", "ids": [205] }
        }
      }
    },
    { "axis": { "name": "time", "unit": "s" } },
    {
      "append": {
        "at": [0, 0.5],
        "table": "Bus",
        "fields": { "vm": { "file": "vm.f32", "dtype": "f32le", "count": 4 } }
      }
    }
  ]
}
```

- `replace` and `set` take `{ table, ids, fields }`, `remove` `{ table, ids }`, `append`
  `{ at, table, ids?, fields }`, `forget` `{ before }`, `axis` `{ name, unit }`, and `frames`
  `{ table, field, level?, first, at, values }`, a run of a sampled field's entries as a
  [time tile](#fetch-long-histories-in-spans) holds them.
- `ids` are numbers or texts, or `{ "count": n }`; `null` leaves a reference unwired.
- A field is an array of one kind of value, a reference `{ reference, ids }`, or a slice of a binary
  file beside the document, `{ file, dtype, offset, count }`: `count` values from byte `offset`, of
  dtype `f32le`, `f64le`, `i32le`, `u32le`, `u64le`, `u8`, or `bool` (a byte each, nonzero true).

(bytes)=

### Bytes

LATK v1 encodes a patch as one frame; a dataset's bytes are the patch that builds it. A frame says its
length up front, so frames back to back split without decoding. Little endian throughout.

| Part         | Layout                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| frame        | `LATK`, `u16` version (1), `u16` flags (0), `u64` length of the whole frame, dataset name (empty for none), `u32` op count, ops                                                                                           |
| op           | `u8` tag: 0 axis, 1 replace, 2 set, 3 remove, 4 append, 5 forget, 6 frames; then its payload                                                                                                                              |
| axis         | name, unit                                                                                                                                                                                                                |
| replace, set | table name, ids, `u32` field count; per field: name, `u8` 0 values, 1 reference (target table name, ids as values), or 2 samples                                                                                          |
| remove       | table name, ids                                                                                                                                                                                                           |
| append       | table name, `u8` 1 and ids or `u8` 0 for every row, `u32` frames, `f64` coordinates, `u32` field count; per field: name, values frame-major                                                                               |
| forget       | `f64` before                                                                                                                                                                                                              |
| frames       | table name, field name, `u32` rows, run                                                                                                                                                                                   |
| samples      | `u32` rows, `u64` first frame read, `u64` frames read, `u8` highest stored level, `u32` run count, runs                                                                                                                   |
| run          | `u8` level, `u64` first entry, `u32` entries, `f64` coordinates (a frame's; a bucket's first and last frame's), `f32` values: a frame's per row, or each bucket's least per row, then each bucket's greatest; NaN missing |
| ids          | `u8` 0 and `u32` count, or `u8` 1 and values: `u64`, `u32`, or texts                                                                                                                                                      |
| values       | `u8` storage, `u32` length, data, `u8` 1 and validity bits, or `u8` 0                                                                                                                                                     |
| storage      | 0 `f64`, 1 `f32`, 2 `i32`, 3 `u32`, 4 `u64`, 5 bits, 6 texts (`u32` offsets, then `u32` byte length and UTF-8), 7 geometry (`u8` depth, each level's `u32` count and offsets, `u32` point count, `f64` x y pairs)         |
| text         | `u32` byte length, UTF-8                                                                                                                                                                                                  |

Bits are `u64` words, low bit first. A sampled field's entries are frames at level 0, and at level
`k` buckets of `8^k` frames; a bucket whose eight entries a level below are held is left out, as it
follows from them. A writer outside latkit writes frames as `append` changes.

The header is 16 bytes. The version is independent of the crate/npm version. Readers reject
unknown versions, nonzero flags, unknown operation/storage tags, truncated frames, and trailing
bytes. The checked-in `latk-v1.hex` fixture is tested by Rust and JavaScript.

Absolute frame indexes are `u64`; counts within an encoded run remain `u32`. A run's end and its
span in frames must fit in `u64`. JavaScript builders accept only safe integers, including the
run's end (`2^53 - 1` at most). Levels 0 through 21 are legal; the writer records the highest
stored level so changing the renderer's detail policy does not change the file's interpretation.
Normal appends currently derive up to six levels. Tile manifests record each field's `levels`.
Sample indexes in query/pick JSON outputs use decimal strings above JavaScript's safe-integer range.

Sample values and extrema are `f32`, with NaN representing missing values. Axis coordinates and
geometry coordinates are `f64`. An appended `Float64Array` is normalized to sampled `f32` storage;
this is a visualization history, not a lossless float64 archive. Static float64 columns stay float64.

`Patch.stream` limits one encoded frame (256 MiB by default), in addition to the supplied input
chunk and patches retained by the caller. It validates the header before allocating the frame body
and cancels its reader on failure or early termination. Rust decoding defaults to a 256 MiB frame
limit and a 512 MiB conservative decoded-storage budget; `Patch::decode_with_limits` accepts
`DecodeLimits` for applications with different needs. Applying patches and retaining snapshots
have their own memory costs, separate from decoding.

## Deploying

Install `latkit` from npm for JavaScript and `latkit-cli` from Cargo for the `latkit` command.
The Rust library is the `latkit` crate. The WASM binding crate is an implementation detail.

| Capability                          | Browser                        | Node                             | Native CLI                   |
| ----------------------------------- | ------------------------------ | -------------------------------- | ---------------------------- |
| Scenes, expressions, patch builders | `latkit`, no WebAssembly       | `latkit`, no WebAssembly         | JSON inputs                  |
| Data and queries                    | WASM, no GPU required          | WASM with a compiled module      | Available without a GPU      |
| Rendering                           | WebGPU in a secure context     | Use the CLI for native rendering | Vulkan, Metal, DX12          |
| File/URL slices                     | Browser fetch and CORS         | Supply data directly             | Local paths and `file:` URLs |
| H.264 MP4                           | WebCodecs Constrained Baseline | Use the CLI                      | Windows Media Foundation     |

Serve WASM with `Content-Type: application/wasm`. WebGPU requires HTTPS or localhost and a
supported device. Keep the JavaScript, WASM, and worker from the same package version together.
Images and raw frame output are available where native MP4 encoding is unavailable.

### Assets and workers

Default loading resolves assets beside the installed modules. With Vite or another bundler
supporting URL imports, explicit assets also work under nested deployment paths:

```ts
import { load } from 'latkit';
import wasmUrl from 'latkit/wasm?url';
import workerUrl from 'latkit/worker?url';

await load({ wasm: wasmUrl, worker: () => new Worker(workerUrl) });
```

`latkit/worker` is a standalone classic worker. A custom factory may use a Blob URL; retain the
URL while the factory can be called and revoke it on application teardown. Workers are created
on demand and retire when idle. Where workers are unavailable, jobs run on the calling thread.

Your Content Security Policy must allow the WASM asset and data origins in `connect-src`,
WebAssembly compilation (typically `'wasm-unsafe-eval'` in `script-src`), and the worker URL in
`worker-src`. Add `blob:` only when using Blob workers. Cross-origin resources need appropriate
CORS headers. These requirements are deployment choices; latkit does not change your policy.

### Server-side builders and data

```ts
import { Patch, field } from 'latkit';

const bytes = new Patch().replace('T', [1], { value: [42] }).toBytes();
const expression = field('value').gt(0).toJSON();
```

Patches and expressions need no WebAssembly. For Node data/query operations, load the package's
matching WASM bytes as a `WebAssembly.Module` and pass it to `load({ wasm })`. For worker
rendering, provide an `OffscreenCanvas` and drive `gpu.step(now)` if the environment has no
animation-frame loop.

See [resource lifetimes](#stats-and-memory) and [video cleanup](#video).

## In Rust

For CPU data processing, opt out of the default GPU feature:

```toml
[dependencies]
latkit = { version = "0.3", default-features = false }
```

```rust
use latkit::{Data, Ids, Patch, Query, Reading, Table, field};

let grid = Data::new("grid");
grid.apply(Patch::new().replace(Table::new("Bus", Ids::count(2)).field("kv", vec![115.0, 230.0])))?;
let high = grid.snapshot().query(&Query::of("Bus").filter(field("kv").ge(200.0)))?;
let saved = grid.snapshot().to_bytes();
let restored = Data::read(&saved, Reading::default()).await?;
```

A `Data` changes in place and its clones share it; a view drawing it draws its latest version, and
a `Snapshot` keeps one version. `Data::read` and `Patch::read` take a `Reading`: the name a dataset
takes, the base its slices are relative to, and the `resource::Fetch` that fetches them. Implement
`fetch(&Request) -> Pending<Vec<u8>>`; `Pending::ready` wraps immediate results, and `Pending::new`
returns a resolver for asynchronous work. A rendering `Host` implements this smaller interface, so
the native and browser hosts read slices as they are.

Enable `gpu` for scenes, views, and wgpu rendering; `native` adds system fonts, jobs, files, and
Windows H.264. `web` enables browser integration for the WASM target. Native file loading does
not include an HTTP client; applications can provide one through `Fetch` or `Host`.

### Share an existing device

```rust
let gpu = latkit::Gpu::from_wgpu(device.clone(), queue.clone())?;
let events = gpu.device_events();
let loss = events.clone();
device.set_device_lost_callback(move |_, _| loss.lost());
device.on_uncaptured_error(std::sync::Arc::new(move |error| events.error(&error)));
```

Forward these events from your application's existing callbacks. `from_wgpu` validates device
limits and preserves callback ownership. Clone one `Gpu` for views that should share caches and
budgets. `Gpu::new` owns its device and installs its own callbacks. Device loss requires a new
device and views; datasets and scene descriptions can be retained.

The [Rust API reference](https://docs.rs/latkit) documents each type, method, feature, and example.
The [format specification](#bytes) describes cross-language LATK storage.
