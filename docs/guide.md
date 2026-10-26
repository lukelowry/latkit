# Guide

How latkit works: datasets and the patches that change them, scenes, views, pictures and video,
the data formats, and deployment.

## Data

A dataset is a name and a set of tables. A table has rows, each with an id, and fields, each with
one value per row. A patch applies atomically: all of its changes, or none.

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

- **Ids** are a list of nonnegative safe integers (`0..2^53 - 1`) or strings, or `{ count: n }`
  for rows `0` to `n - 1`.
- **Values** are one column per field: typed arrays of numbers, or arrays of numbers, booleans,
  strings, or geometries. `null` is missing. A `Uint8Array` holds booleans, so use `Uint32Array`
  for small unsigned integers.
- **Geometries** are `[x, y]` points, paths of points, parts (a polygon's rings, or a path's
  pieces), or polygons.
- **References** name rows of another table by id: `reference(table, ids)`.

| Change                                               | Does                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `replace(table, ids, fields)`                        | replaces the table, or adds it                                          |
| `set(table, ids, fields)`                            | updates those rows and adds unknown ids; other fields keep their values |
| `remove(table, ids)`                                 | removes the rows                                                        |
| `axis(name, unit)`                                   | names the axis that sampled fields are recorded over                    |
| `append(table, at, fields, { ids })`                 | records a frame at each coordinate of `at`, for every row or for `ids`  |
| `forget(before)`                                     | drops the frames before a coordinate                                    |
| `frames(table, field, { level, first, at, values })` | adds a run of a sampled field's stored entries, as a time tile does     |

`patch.extend(next)` appends another patch's changes.

### Change it

`apply` changes a dataset in place; every view drawing it shows the change on the next frame.
`snapshot()` keeps the current version in O(1) by sharing pages with the dataset, so an undo history
costs only the pages that changed:

```ts
const before = grid.snapshot();
grid.apply(new Patch().set('Bus', [101], { name: ['Northgate'] })); // drawn the next frame
grid.restore(before); // and undone
```

### Record over time

A field becomes sampled with its first frame. Sampled values are stored as `f32`, even when given
as a `Float64Array`, so a history is for visualization, not a lossless `f64` archive. Axis
coordinates stay `f64`, and static columns keep their original numeric type. NaN marks a missing
value in sampled fields and in numeric query results. A view shows the axis coordinate `view.at`:
marks interpolate each sampled field linearly between the frames on either side of it, or show the
last frame at or before it when read with `field(name).step()`. `get` and `query` read the last
frame at or before the `at` they are given, or the last frame without one.

```ts
grid.apply(new Patch().axis('time', 's'));
grid.apply(new Patch().append('Bus', 0.5, { vm: Float32Array.of(1.01, 0.99, 1.0) }));
grid.apply(new Patch().append('Bus', [1, 1.5], { vm: Float32Array.of(1, 1, 1, 0.98, 0.97, 0.99) }));
grid.apply(new Patch().append('Bus', 2, { vm: [1.02] }, { ids: [101] })); // one row; the rest hold
grid.apply(new Patch().forget(1)); // a rolling window
view.at = 1.2;
```

As it records, each sampled field keeps levels of detail: level `k` holds each row's minimum and
maximum over buckets of `8^k` frames. A line tracing a field on a plot reads the level that gives
each pixel column one or two buckets, so a long history draws as fast as a short one.

### Fetch long histories in spans

Write a history too large to load at once as time tiles; a view then fetches only what it draws:

```sh
latkit tile history.latk -o history/
```

```ts
view.sources = [new Tiles('grid', 'history/frames.json')];
```

`tile` writes `frames.json`, `base.latk` (the dataset without its sampled fields' frames), and each
sampled field's history in spans of `--chunk` entries (256 by default) at every level of detail. In
Rust, `Snapshot::to_tiles` writes the same files. A line tracing a field fetches the spans its plot
window shows, at the detail it draws. A mark showing a field fetches the frames around `view.at`.
While a span loads, the view draws the coarser span above it, as a map shows the parent tile while a
tile loads.

### Stream

`patch.toBytes()` encodes a patch as one frame, and frames written back to back form a stream. Each
frame's header gives its length, so `Patch.stream` refuses a frame longer than `limit` (256 MiB by
default) before reading its body. It buffers at most one frame, besides the current input chunk and
the patches you keep, and cancels the reader on an error or when you break out of the loop. A server
in any language can write the same frames ([format](#bytes)).

```ts
for await (const patch of Patch.stream((await fetch('/feed')).body!)) grid.apply(patch);
```

`new Patch('grid')` names its dataset; applying it to any other dataset throws.

### Read files

```ts
const grid = await Data.read('data/grid.json'); // a JSON document, its slices relative to it
const saved = await Data.read(bytes); // latkit's bytes, as data.toBytes() wrote them
const states = await Data.read(geojson, { name: 'states' }); // GeoJSON, gzip-compressed or not
```

GeoJSON becomes the tables `points`, `lines`, and `polygons`, each with a `geometry` field and one
field per property; it is parsed in a worker. [Formats](#json) describes the JSON document.
`Patch.read(source)` reads one patch from the same kinds of source; reading bytes needs no
WebAssembly.

### Read back

Reading needs no GPU. Queries use the same expressions as marks:

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

`total` is the number of rows the query matched before `limit`. `field('name').contains('north')`
matches text, ignoring case. `describe()` lists the tables, their rows, their fields and field
kinds, and the axis with its span. `envelope({ table, field, range, spans, ids })` returns each
row's minimum and maximum of a sampled field over equal spans of the axis. It reads the levels of
detail, so each span costs a few reads however many frames it covers. A `Snapshot` has the same
read methods and reads its own version.

The [API reference](reference/api.md) lists every method's signature.

## Scenes

A scene is plain data: a `space`, a list of `marks` drawn in order, and optional `layout`, `theme`,
`controls`, `ease` (the seconds a change eases over, 0.3 by default), `title`, and `subtitle`.
Setting `view.scene = next` replaces the scene, and each row eases from where it was drawn.

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

| Space       | Positions                                                             |
| ----------- | --------------------------------------------------------------------- |
| `'plane'`   | plane units with elevation; the camera turns and tilts                |
| `'earth'`   | longitude and latitude in degrees, on a map or a globe                |
| `'plot'`    | the axis coordinate across, values up                                 |
| `'diagram'` | a flat sheet, y down, sizes in position units; ports, groups, layouts |

To set options, write the space as an object: `{ plane: { grid } }`, `{ diagram: { grid } }`,
`{ earth: { projection, graticule, daylight, atmosphere } }`, or `{ plot: { x, y } }`. The earth's
`projection` is `'mercator'` (the default) or `'globe'`. A grid is `'off'`, `{ lines: { pitch } }`,
or `{ dots: { pitch, snap } }`. A plot's axes reserve room for their labels and titles.

### Marks

Every mark names its table with `of: [dataset, table]` and takes `color`, `visible`, `priority`,
`label`, `legend`, `name`, `pick`, `select`, and `drag`. By default, the pointer hovers, clicks,
and probes vertices, edges, faces, and a plot's traces, but not geometry such as areas and lines
along paths (coasts, borders, roads). Set `pick: true` to make, for example, a map's states or cells
respond to the pointer.

| Mark       | Draws each row as                                                        | Its own options                                                                |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `vertices` | a marker at `position` (or at the point field `geometry`)                | `elevation`, `radius`, `size`, `marker`, `ring`, `ports`, `contains`, `shadow` |
| `edges`    | a stroke between the two rows its `ends` fields reference                | `ends`, `bends`, `route`, `arrows`, `width`, `dash`, `flow`                    |
| `lines`    | a stroke along a path field; on a plot, a sampled field traced over time | `geometry`, `trace`, `interpolation`, `width`, `dash`, `flow`                  |
| `areas`    | the area a polygon field covers                                          | `geometry`                                                                     |
| `faces`    | a triangle between three vertices                                        | `corners`                                                                      |

`flow` animates comets along a stroke. In a diagram, vertices are blocks with `ports`. A vertex mark
with `contains` draws each row as a group around the rows that reference it. An edges mark of a
table without `ends` draws nets, each joining the ports that reference it. The theme's `diagram`
group (`outline`, `corner`, `portSize`, `bend`) styles blocks, groups, ports, and wires, and
`shadow: true` gives blocks and groups a drop shadow.

### Expressions

Options that vary by row take an expression: a number, a field name, or a builder. Color options
differ: a string is a CSS color, and a field sets colors only through a colormap or a conditional.

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

Sizes are in CSS pixels on a plane, the earth, and a plot, and in position units in a diagram,
unless wrapped in `px()` or `units()`; on the earth a position unit is a degree. State expressions
read the view: `selected()`, `hovered()`, `pointer()`, `elapsed()`, and `zoom()`. A colormap is a
catalog name or your own `{ kind, colors }`; a categorical colormap can name its `categories` for
the legend. A colormap draws a missing value in the theme's `missing` color, while an option given
`missing()` takes its theme value. `colormapCss(map)` returns the same colors as a CSS gradient.

### Themes, controls, and layouts

- **Theme**: `'dark'`, `'light'`, or overrides of a base theme, grouped by what they style:
  `{ base: 'light', text: { size: 12 }, edge: { width: 2 } }`. `edge: { color: null }` colors each
  edge by blending its two vertices' colors, and `focus: { selected: null }` draws the selection
  glow in each row's own color. The `flow` group's comet `spacing` and `length` take `{ px: n }` or
  `{ units: n }`.
- **Controls**: options `pan`, `zoom`, `turn`, `keyboard`, `hover`, `pickRadius`, `selectBox`,
  `connect`, `delete`, `cycle`, `press`, and `motion`; by default the pointer pans, zooms, turns,
  and hovers. The presets are `'inspect'`, which leaves the camera to the application, and
  `'none'`, for a still picture.
- **Layout** places vertex rows that have no position, in any space but a plot: `'stress'`,
  `'layered'`, or their options. Without a layout, such rows are not drawn. A row keeps its place
  once laid out; `view.arrange()` lays out every row again.

## Views

A `Gpu` creates views and canvases. A view draws one scene from its sources, the datasets its marks
name. A canvas shows views, one per panel, and passes each view the pointer and key input on its
panel.

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

`view.sources` lists the datasets a view draws, each matched by its name. A source is one of:

- `Data`: the view draws its latest version, from the frame after each patch applies.
- `Snapshot`: the view draws that version, unchanged.
- `Tiles`: pieces fetched as the view needs them, shared by every view of the GPU. The URL is a
  [time tiles](#fetch-long-histories-in-spans) `frames.json` manifest, or vector tiles fetched as
  the camera moves: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` template. Each vector
  layer becomes a table of the features that match the mark drawing it (polygons, lines, or points);
  name the table `layer:polygons`, `layer:lines`, or `layer:points` to choose explicitly.

`view.snapshot(name)` returns the version of a source the view draws now, including the tiles
fetched so far.

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

`view.on(type, listener)` returns a function that removes the listener. Intent events (`click`,
`open`, `menu`, `drag`, `connect`, `delete`) fire once each, in the order the user acted. Change
events (`hovered`, `selection`, `camera`, `waiting`) report only the latest state, which the
property of the same name always holds (`view.hovered`, `view.selection`, and so on). Setters fire
no events, so events report only what the application did not do itself.

```ts
view.on('click', ({ hit }) => console.log(hit.row, hit.point));
view.on('drag', ({ hit, position }) => move(hit.row, position)); // where the row goes, as grabbed
view.on('selection', ({ rows }) => inspect(rows));
view.on('error', (error) => console.error(error.code, error.path, error.message));
```

### Rows

A row is `{ data, table, id }`. A set of rows in one table is `{ data, table, ids }`; the
selection, `selection` and `delete` events, fits, and `neighbors` use sets:

```ts
view.selection = [{ data: 'grid', table: 'Bus', ids: [101, 102] }];
const joined = view.neighbors({ data: 'grid', table: 'Bus', id: 101 }); // across edges and nets
const hits = await view.pick([x, y], { radius: 8 }); // rows within 8 CSS pixels, nearest first
const at = await view.screenOf({ data: 'grid', table: 'Bus', id: 101 }); // [x, y] on screen, or null
```

`pick` and `screenOf` resolve once a frame draws the view. Calls that wait take `{ signal }` and
stop waiting when it aborts; without one, they time out after 30 seconds. They reject with code
`timeout` on a timeout, and `cancelled` when aborted or when the view is destroyed.

### Layouts into data

A scene's `layout` places vertex rows that have no position. `view.arrange()` lays them all out
again and resolves to one patch per dataset that writes their places into the mark's position
fields. Applied, the places become part of the data:

```ts
for (const patch of await view.arrange()) if (patch.data === grid.name) grid.apply(patch);
```

### Stats and memory

`view.stats` reports, per frame, the rows drawn, draw calls, tiles, and CPU and GPU milliseconds.
`gpu.resident` and `gpu.uploading` are the bytes of data on the GPU and waiting to upload, across all
views of that GPU. `gpu.work` counts exactly what the GPU did: bytes uploaded, written, and cleared;
rows evaluated, resolved (edge and face endpoints found), and packed; readbacks, jobs, texts, and
pipelines compiled.

`gpu.budget = { bytes, uploadPerFrame }` caps the GPU memory data may take (by default half the
device's largest storage buffer) and the bytes uploaded per frame (32 MiB by default). Set it before
data draws: the memory pool grows as needed and never shrinks. The views of one GPU share the
budget: a view that needs less than an even split gets all it needs, and the others divide the
rest. Pages that several views draw count once.

A table too large for its view's share is paged: the view draws only the pages the camera needs. A
page the camera leaves stays resident while the budget allows, so returning to it needs no upload.
Drawn edges need their endpoints resident: a vertex page that many drawn edges end in is made
resident whole, and scattered endpoints are made resident individually, so edges between far-apart
vertices still fit the budget.

Each frame does only the work its changes need. A patch re-evaluates only the pages it wrote, unless
a fitted domain or a join reads them. A transition evaluates once, then blends each frame. Rows of a
paged table keep their GPU slots while the camera moves, so only newly needed rows upload.

`Data`, `Snapshot`, `Gpu`, `View`, `Canvas`, and `Image` have an idempotent `destroy()` and
`Symbol.dispose`, so they work with `using`. Destroying a `Gpu` also destroys its canvases, views,
and frame listeners.

Finish a video with `await video.finish()` or cancel it with `await video.abort(reason)`. `record`
finishes the video itself, and aborts it on an error.

`gpu.lost` tells whether the device is gone. To recover, create a new `Gpu`, views, and canvases,
and give them your scenes and datasets again. `view.failures` lists the marks that draw nothing
because their data no longer fits them, with the reason. To drive frames yourself, call
`gpu.step(now)`: after the first call, latkit stops requesting animation frames, and
`view.wantsFrame` tells whether a view needs one. `gpu.done()` resolves once submitted GPU work,
readbacks, and requested pipeline compiles have finished; `gpu.landed()` resolves when work a view
waits on (a readback, compile, job, text, or fetch) arrives, or a view needs a frame.
`view.position([x, y])` is the position under a canvas point, and `view.screen(position)` is the
screen point where a position draws.

## Pictures and video

A `Shot` is plain data: a size in pixels and how views are drawn into it. It draws views whether or
not a canvas shows them; a canvas showing one keeps its last frame while the shot draws.
`canvas.shot()` makes a shot of exactly what the canvas shows.

```ts
const shot = new Shot([3840, 2160], { scale: 2, layout: [{ view }] }); // 1920 by 1080 CSS pixels
const image = await shot.image(); // once the view is complete and still
const png = await image.encode('png'); // or 'jpeg' with { quality }, or 'webp'
image.destroy();
```

| Option        | Does                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| `scale`       | draws `scale` pixels per CSS pixel (1 by default)                                             |
| `layout`      | the views and where each draws, `at: [x, y, width, height]` as fractions                      |
| `transparent` | keeps alpha where the themes' backgrounds would be                                            |
| `capture`     | waits until views are complete and still (`'still'`, the default), or only complete (`'now'`) |
| `elapsed`     | fixes `elapsed()` and animated effects, such as comets, at `elapsed` seconds                  |

Images are encoded in a worker where workers are available, and on the calling thread otherwise.

### Video

`shot.video({ fps, output, bitrate })` encodes H.264 MP4 with WebCodecs as frames are drawn, and
writes it to a `WritableStream`, such as a file's or an in-memory buffer's. `bitrate` defaults to
about 0.15 bits per pixel per frame. Each frame draws the views at its own time, `frames / fps`
seconds, so motion follows the video rather than the wall clock. `record(step)` calls `step(time)`
before each frame and finishes the video when it returns `false`.

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

The width is rounded down to a multiple of 4 and the height to a multiple of 2, as H.264 needs. A
frame where nothing moved is not drawn; the previous frame is shown again. A `signal` passed to
`shot.video` aborts the video: its output is aborted and its views are released.

For manual control, call `await video.frame()` for each frame, then `await video.finish()`.
`finish` and `abort` are idempotent; both release the output's writer lock, the encoder, and the
abort listener. `frames` and `time` stay readable afterwards. An error in a step, frame, write, or
progress callback aborts `record`. Aborting cancels pending drawing and encoding at once, but the
writer lock is released only after the stream settles its in-flight write. In the browser, the
output is Constrained Baseline H.264, with output timestamps checked against input order.

## Formats

### Schema

All JSON latkit reads and writes has a JSON Schema, generated from the same declarations that read
and write it. `latkit schema` prints it, and the npm package's types are generated from it. Its
`$defs` are the inputs (`Scene`, `Data`, `Patch`, `Query`, `Camera`, `Fit`, `Budget`, `Shot`), and
its `outputs` are what latkit returns (`ViewEvent`, `Stats`, `Work`, `Description`, `Rows`,
`Camera`, `Budget`, `Value`, `Failure`, and the types they use).

(json)=

### JSON

A dataset's document is its name and the patch that builds it. A patch is a list of changes, each
an object keyed by its method name, with its parameters by name:

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
  `{ table, field, level?, first, at, values }`, a run of a sampled field's entries as stored in a
  [time tile](#fetch-long-histories-in-spans).
- `ids` are numbers or strings, or `{ "count": n }`; a `null` id in a reference leaves that row
  unconnected.
- A field is an array of one kind of value, a reference `{ reference, ids }`, or a slice of a binary
  file beside the document, `{ file, dtype, offset, count }`: `count` values starting at byte
  `offset`, of dtype `f32le`, `f64le`, `i32le`, `u32le`, `u64le`, `u8` (numbers), or `bool` (one
  byte each, nonzero is true).

(bytes)=

### Bytes

A patch encodes as one frame; a dataset's bytes are the patch that builds it. A frame's header
gives its length, so frames written back to back split without decoding. All values are little
endian.

| Part         | Layout                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| frame        | `LATK`, `u64` length of the whole frame, dataset name (empty for none), `u32` op count, ops                                                                                                                               |
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

Bits are packed into `u64` words, low bit first. A sampled field's entries are frames at level 0,
and buckets of `8^k` frames at level `k`. A bucket is left out when all eight entries one level
below it are stored, since it can be computed from them. Writers outside latkit should record
frames as `append` changes.

The header is 12 bytes: the magic `LATK` and the frame's length. Readers reject other bytes,
unknown operation or storage tags, truncated frames, and trailing bytes. The format carries no
version: a release that changes it says so, and files written before it no longer open. Rust and
JavaScript tests both check the committed `patch.hex` fixture.

Absolute frame indexes are `u64`; counts within an encoded run are `u32`. A run's end and its span
in frames must fit in `u64`. JavaScript builders accept only safe integers, including the run's end
(`2^53 - 1` at most). Levels 0 through 21 are valid. The writer records the highest stored level, so
a change to the renderer's detail policy does not change how a file reads. Appends currently derive
up to six levels. Tile manifests record each field's `levels`. In query and pick JSON output, sample
indexes above JavaScript's safe-integer range are written as decimal strings.

[Stream](#stream) describes the limits `Patch.stream` applies. In Rust, `Patch::from_bytes` decodes
with the default `DecodeLimits`: a 256 MiB frame and 512 MiB of decoded storage (a conservative
estimate). `Patch::stream(read, limits)` takes other limits. Applying patches and keeping snapshots
cost memory beyond decoding.

## Deploying

Install `latkit` from npm for JavaScript, and `latkit-cli` from Cargo for the `latkit` command.
The Rust library is the `latkit` crate; the crate that binds it to WebAssembly is internal.

| Capability                          | Browser                        | Node                             | Native CLI                   |
| ----------------------------------- | ------------------------------ | -------------------------------- | ---------------------------- |
| Scenes, expressions, patch builders | `latkit`, no WebAssembly       | `latkit`, no WebAssembly         | JSON inputs                  |
| Data and queries                    | WASM, no GPU required          | WASM with a compiled module      | Available without a GPU      |
| Rendering                           | WebGPU in a secure context     | Use the CLI for native rendering | Vulkan, Metal, DX12          |
| File/URL slices                     | Browser fetch and CORS         | Supply data directly             | Local paths and `file:` URLs |
| H.264 MP4                           | WebCodecs Constrained Baseline | Use the CLI                      | Windows Media Foundation     |

Serve WASM with `Content-Type: application/wasm`. WebGPU requires HTTPS or localhost and a
supported device. Serve the JavaScript, WASM, and worker from the same package version. Where native
MP4 encoding is unavailable, the CLI still writes images and raw frames.

### Assets and workers

By default, `load()` finds the WASM and worker files next to the installed modules. With Vite or
another bundler that supports URL imports, you can pass their URLs explicitly, which also works under
nested deployment paths:

```ts
import { load } from 'latkit';
import wasmUrl from 'latkit/wasm?url';
import workerUrl from 'latkit/worker?url';

await load({ wasm: wasmUrl, worker: () => new Worker(workerUrl) });
```

`latkit/worker` is a standalone classic worker. A custom factory may use a Blob URL; keep the URL
valid while the factory can be called, and revoke it when the application shuts down. Workers start
on demand and stop after 30 seconds idle. Where workers are unavailable, jobs run on the calling
thread.

Your Content Security Policy must allow the WASM asset and data origins in `connect-src`,
WebAssembly compilation (typically `'wasm-unsafe-eval'` in `script-src`), and the worker URL in
`worker-src`. Add `blob:` only when using Blob workers. Cross-origin resources need CORS headers.
latkit never changes your policy.

### Server-side builders and data

```ts
import { Patch, field } from 'latkit';

const bytes = new Patch().replace('T', [1], { value: [42] }).toBytes();
const expression = field('value').gt(0).toJSON();
```

Patches and expressions need no WebAssembly. To use datasets and queries in Node, compile the
package's WASM bytes into a `WebAssembly.Module` and pass it to `load({ wasm })`. To render in a
worker, pass an `OffscreenCanvas` to `gpu.canvas`, and call `gpu.step(now)` yourself if the
environment has no animation-frame loop.

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

A `Data` changes in place, and its clones share it; a view drawing it draws its latest version, and
a `Snapshot` keeps one version. `Data::read` and `Patch::read` take a `Reading`: the dataset's name,
the base its slices are relative to, and the `resource::Fetch` that fetches them. A `Fetch`
implements `fetch(&Request) -> Pending<Vec<u8>>`; `Pending::ready` wraps an immediate result, and
`Pending::new` returns a pending value with a resolver for asynchronous work. Every rendering
`Host` is also a `Fetch`, so the native and browser hosts read slices directly.

Enable `gpu` for scenes, views, and wgpu rendering; `native` adds system fonts, jobs, files, and
Windows H.264. `web` enables browser integration for the WASM target. Native file loading includes
no HTTP client; applications can provide one through `Fetch` or `Host`.

### Share an existing device

```rust
let gpu = latkit::Gpu::from_wgpu(device.clone(), queue.clone())?;
let events = gpu.device_events();
let loss = events.clone();
device.set_device_lost_callback(move |_, _| loss.lost());
device.on_uncaptured_error(std::sync::Arc::new(move |error| events.error(&error)));
```

Forward device loss and uncaptured errors from your application's own callbacks, as above.
`from_wgpu` checks the device's limits and leaves its callbacks to you. Clone one `Gpu` for views
that should share caches and a budget. `Gpu::new` instead creates its own device and installs its
own callbacks. After device loss, create a new device and views; datasets and scenes can be reused.

The [Rust API reference](https://docs.rs/latkit) documents each type, method, feature, and example.
The [format specification](#bytes) describes cross-language LATK storage.
