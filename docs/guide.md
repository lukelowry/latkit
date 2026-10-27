# Guide

How to use latkit: write and change datasets, describe scenes, show them in views, and draw
pictures and video. The [API reference](reference/api.md) documents every method and option.

## Data

A dataset is a name and a set of tables. A table has rows, each with an id, and fields, each with
one value per row. A [patch](reference/api.md#patch) changes a dataset: all of its changes, or none.

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

- **Ids** are nonnegative safe integers or strings, or `{ count: n }` for rows `0` to `n - 1`.
- **Values** are one column per field: typed arrays, or arrays of numbers, booleans, strings, or
  geometries, with `null` for missing. A `Uint8Array` holds booleans.
- **Geometries** are `[x, y]` points, paths of points, parts (a polygon's rings), or polygons.
- **References** name rows of another table by id: `reference(table, ids)`.

### Change it

`apply` changes a dataset in place; every view drawing it shows the change on the next frame.
`snapshot()` keeps the current version in O(1) by sharing pages, so an undo history costs only the
pages that changed:

```ts
const before = grid.snapshot();
grid.apply(new Patch().set('Bus', [101], { name: ['Northgate'] })); // drawn the next frame
grid.restore(before); // and undone
```

### Record over time

A field becomes sampled with its first frame. A view shows the axis coordinate `view.at`: marks
interpolate each sampled field between the frames on either side of it, or show the last frame at
or before it when read with `field(name).step()`. Sampled values are stored as `f32` for drawing;
axis coordinates stay `f64`.

```ts
grid.apply(new Patch().axis('time', 's'));
grid.apply(new Patch().append('Bus', 0.5, { vm: Float32Array.of(1.01, 0.99, 1.0) }));
grid.apply(new Patch().append('Bus', [1, 1.5], { vm: Float32Array.of(1, 1, 1, 0.98, 0.97, 0.99) }));
grid.apply(new Patch().append('Bus', 2, { vm: [1.02] }, { ids: [101] })); // one row; the rest hold
grid.apply(new Patch().forget(1)); // a rolling window
view.at = 1.2;
```

Each sampled field keeps levels of detail as it records: level `k` holds each row's minimum and
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

A line tracing a field fetches the spans its plot window shows, at the detail it draws; other marks
fetch the frames around `view.at`. While a span loads, the view draws the coarser span above it. In
Rust, `Snapshot::to_tiles` writes the same files.

### Stream

`patch.toBytes()` encodes a patch as one frame, and frames written back to back form a stream that
a server in any language can write ([format](#bytes)). `Patch.stream` yields each patch as its last
byte arrives:

```ts
for await (const patch of Patch.stream((await fetch('/feed')).body!)) grid.apply(patch);
```

`new Patch('grid')` names its dataset; applying it to another dataset fails.

### Read files

```ts
const grid = await Data.read('data/grid.json'); // a JSON document, its slices relative to it
const saved = await Data.read(bytes); // latkit's bytes, as data.toBytes() wrote them
const states = await Data.read(geojson, { name: 'states' }); // GeoJSON, gzip-compressed or not
```

GeoJSON becomes the tables `points`, `lines`, and `polygons`. [Formats](#json) describes the JSON
document. `Patch.read` reads one patch from the same kinds of source.

### Read back

Reading needs no GPU, and queries use the same expressions as marks:

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

[`Dataset`](reference/api.md#dataset) lists the reads, `describe()` and `envelope()` among them. A
`Snapshot` reads its own version the same way.

## Scenes

A scene is plain data: a `space`, a list of `marks` drawn in order, and optional `layout`, `theme`,
`controls`, `ease` (the seconds a change eases over), `title`, and `subtitle`. Setting
`view.scene = next` replaces the scene, and each row eases from where it was drawn.

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

The [scene types](reference/types.md#scene) document every option and its default.

### Spaces

| Space       | Positions                                                             |
| ----------- | --------------------------------------------------------------------- |
| `'plane'`   | plane units with elevation; the camera turns and tilts                |
| `'earth'`   | longitude and latitude in degrees, on a map or a globe                |
| `'plot'`    | the axis coordinate across, values up                                 |
| `'diagram'` | a flat sheet, y down, sizes in position units; ports, groups, layouts |

Written as an object, a space takes options: `{ earth: { projection: 'globe' } }`,
`{ plane: { grid: { lines: { pitch: 10 } } } }`, or a plot's `{ plot: { x, y } }` axes.

### Marks

Every mark names its table with `of: [dataset, table]`. The pointer hovers and clicks vertices,
edges, faces, and a plot's traces; set `pick: true` to make areas and lines respond too.

| Mark       | Draws each row as                                                        |
| ---------- | ------------------------------------------------------------------------ |
| `vertices` | a marker at `position` (or at the point field `geometry`)                |
| `edges`    | a stroke between the two rows its `ends` fields reference                |
| `lines`    | a stroke along a path field; on a plot, a sampled field traced over time |
| `areas`    | the area a polygon field covers                                          |
| `faces`    | a triangle between three vertices                                        |

`flow` animates comets along a stroke. In a diagram, vertices are blocks with `ports`, a vertex
mark with `contains` draws groups around the rows that reference them, and an edges mark of a table
without `ends` draws nets joining the ports that reference it.

### Expressions

Options that vary by row take an expression: a number, a field name, or a builder. A string given
to a color option is a CSS color; a field sets colors through a colormap or a conditional.

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
unless wrapped in `px()` or `units()`. State expressions read the view: `selected()`, `hovered()`,
`pointer()`, `elapsed()`, and `zoom()`. `colormaps()` lists the catalog, and `colormapCss(map)`
gives a colormap's colors as a CSS gradient for legends drawn in HTML.

### Themes, controls, and layouts

- **Theme**: `'dark'`, `'light'`, or overrides of a base theme, grouped by what they style:
  `{ base: 'light', text: { size: 12 }, edge: { width: 2 } }`.
- **Controls**: what the pointer and keys do. By default the pointer pans, zooms, turns, and
  hovers; `'inspect'` leaves the camera to the application, and `'none'` suits a still picture.
- **Layout** places vertex rows that have no position: `'stress'` or `'layered'`. A row keeps its
  place once laid out.

## Views

A `Gpu` creates views and canvases. A view draws one scene from its sources, the datasets its marks
name. A canvas shows views, one per panel, and passes each the pointer and key input on its panel.

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

`view.sources` matches datasets to marks by name: a `Data` draws at its latest version, a
`Snapshot` as it is, and [`Tiles`](reference/api.md#tiles) as the pieces the view needs, from time
tiles or vector tiles.

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

Intent events (`click`, `open`, `menu`, `drag`, `connect`, `delete`) fire once each, in the order
the user acted. Change events (`hovered`, `selection`, `camera`, `waiting`) carry the latest state,
which the property of the same name holds. Setters fire no events.

```ts
view.on('click', ({ hit }) => console.log(hit.row, hit.point));
view.on('drag', ({ hit, position }) => move(hit.row, position)); // where the row goes, as grabbed
view.on('selection', ({ rows }) => inspect(rows));
view.on('error', (error) => console.error(error.code, error.path, error.message));
```

### Rows

A row is `{ data, table, id }`, and a set of rows in one table `{ data, table, ids }`:

```ts
view.selection = [{ data: 'grid', table: 'Bus', ids: [101, 102] }];
const joined = view.neighbors({ data: 'grid', table: 'Bus', id: 101 }); // across edges and nets
const hits = await view.pick([x, y], { radius: 8 }); // rows within 8 CSS pixels, nearest first
const at = await view.screenOf({ data: 'grid', table: 'Bus', id: 101 }); // [x, y] on screen, or null
```

### Layouts into data

`view.arrange()` lays out every vertex row without a position again, and resolves to one patch per
dataset that writes their places into the mark's position fields. Applied, the places become part
of the data:

```ts
for (const patch of await view.arrange()) if (patch.data === grid.name) grid.apply(patch);
```

### Memory

`gpu.budget = { bytes, uploadPerFrame }` caps the GPU memory data takes and the bytes uploaded per
frame; set it before data draws. The views of one GPU share it: a view that needs less than an even
split gets all it needs, and the others divide the rest. A table too large for its view's share is
paged, and the view draws only the pages its camera needs. Each frame does only the work its
changes need: a patch re-evaluates only the pages it wrote.

`view.stats`, `gpu.work`, `gpu.resident`, and `gpu.uploading` report what the views draw and what
the GPU did. A test or benchmark drives frames itself with `gpu.step(now)`, waiting on
`gpu.landed()` between them.

## Pictures and video

A [`Shot`](reference/api.md#shot) is plain data: a size in pixels and the views drawn into it. It
draws views whether or not a canvas shows them, and `canvas.shot()` makes a shot of exactly what a
canvas shows.

```ts
const shot = new Shot([3840, 2160], { scale: 2, layout: [{ view }] }); // 1920 by 1080 CSS pixels
const image = await shot.image(); // once the view is complete and still
const png = await image.encode('png'); // or 'jpeg' with { quality }, or 'webp'
image.destroy();
```

### Video

`shot.video({ fps, output })` encodes H.264 MP4 with WebCodecs as frames are drawn, and writes it
to a `WritableStream`. Each frame draws the views at its own time, `frames / fps` seconds, so motion
follows the video rather than the wall clock, and a frame where nothing moved repeats the one
before. `record(step)` calls `step(time)` before each frame, and finishes the video when it returns
`false`:

```ts
const file = await (await showSaveFilePicker()).createWritable();
const video = new Shot([1920, 1080], { layout: [{ view }] }).video({ fps: 60, output: file });
await video.record((time) => {
  view.at = time;
  return time < 10;
});
```

To draw frames one at a time, call `video.frame()`, then `video.finish()`, or `video.abort()` to
stop.

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

A field is an array of one kind of value, a reference `{ reference, ids }`, or a slice of a binary
file beside the document, `{ file, dtype, offset, count }`: `count` values starting at byte
`offset`, of dtype `f32le`, `f64le`, `i32le`, `u32le`, `u64le`, `u8` (numbers), or `bool` (one byte
each, nonzero is true). A `null` id in a reference leaves that row unconnected.

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
and buckets of `8^k` frames at level `k`, from 0 to 21. A bucket is left out when all eight entries
one level below it are stored, since it can be computed from them. Writers outside latkit should
record frames as `append` changes.

The header is 12 bytes: the magic `LATK` and the frame's length. Readers reject other bytes,
unknown operation or storage tags, truncated frames, and trailing bytes. The format carries no
version: a release that changes it says so, and files written before it no longer open. Rust and
JavaScript tests both check the committed `patch.hex` fixture.

Absolute frame indexes are `u64`; counts within an encoded run are `u32`. JavaScript builders
accept only safe integers. In Rust, `Patch::from_bytes` decodes with the default `DecodeLimits`: a
256 MiB frame and 512 MiB of decoded storage; `Patch::stream(read, limits)` takes others.

## Deploying

Install `latkit` from npm for JavaScript, and `latkit-cli` from Cargo for the `latkit` command.
The Rust library is the `latkit` crate.

| Capability                          | Browser                        | Node                             | Native CLI                   |
| ----------------------------------- | ------------------------------ | -------------------------------- | ---------------------------- |
| Scenes, expressions, patch builders | `latkit`, no WebAssembly       | `latkit`, no WebAssembly         | JSON inputs                  |
| Data and queries                    | WASM, no GPU required          | WASM with a compiled module      | Available without a GPU      |
| Rendering                           | WebGPU in a secure context     | Use the CLI for native rendering | Vulkan, Metal, DX12          |
| File/URL slices                     | Browser fetch and CORS         | Supply data directly             | Local paths and `file:` URLs |
| H.264 MP4                           | WebCodecs Constrained Baseline | Use the CLI                      | Windows Media Foundation     |

Serve WASM with `Content-Type: application/wasm`, and the JavaScript, WASM, and worker from the
same package version. WebGPU requires HTTPS or localhost and a supported device.

### Assets and workers

By default, `load()` finds the WASM and worker files next to the installed modules. With Vite or
another bundler that supports URL imports, pass their URLs, which also works under nested
deployment paths:

```ts
import { load } from 'latkit';
import wasmUrl from 'latkit/wasm?url';
import workerUrl from 'latkit/worker?url';

await load({ wasm: wasmUrl, worker: () => new Worker(workerUrl) });
```

`latkit/worker` is a standalone classic worker, fine as a Blob URL. Workers start on demand and
stop after 30 seconds idle; where workers are unavailable, jobs run on the calling thread. Your
Content Security Policy must allow the WASM asset and data origins in `connect-src`, WebAssembly
compilation (typically `'wasm-unsafe-eval'` in `script-src`), and the worker URL in `worker-src`.

### Server-side builders and data

```ts
import { Patch, field } from 'latkit';

const bytes = new Patch().replace('T', [1], { value: [42] }).toBytes();
const expression = field('value').gt(0).toJSON();
```

Patches and expressions need no WebAssembly. To use datasets and queries in Node, compile the
package's WASM bytes into a `WebAssembly.Module` and pass it to `load({ wasm })`. To render in a
worker, pass an `OffscreenCanvas` to `gpu.canvas`.

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

`Data::read` and `Patch::read` take a `Reading`: the dataset's name, the base its slices are
relative to, and the `resource::Fetch` that fetches them. Every rendering `Host` is also a `Fetch`.
Enable `gpu` for scenes, views, and wgpu rendering; `native` adds system fonts, jobs, files, and
Windows H.264; `web` adds browser integration for the WASM target.

### Share an existing device

```rust
let gpu = latkit::Gpu::from_wgpu(device.clone(), queue.clone())?;
let events = gpu.device_events();
let loss = events.clone();
device.set_device_lost_callback(move |_, _| loss.lost());
device.on_uncaptured_error(std::sync::Arc::new(move |error| events.error(&error)));
```

`from_wgpu` checks the device's limits and leaves its callbacks to you, so forward device loss and
uncaptured errors from your own, as above. Clone one `Gpu` for views that should share caches and a
budget. The [Rust API reference](https://docs.rs/latkit) documents each type, feature, and example.
