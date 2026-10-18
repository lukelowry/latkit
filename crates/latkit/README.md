# latkit

Columnar data drawn as vertices, edges, faces, lines, and areas on the GPU. This file is the plan.
✓ done · ◐ partial · ○ to do.

```sh
cargo xtask check      # fmt, clippy, tests, docs, TypeScript, browser gate
cargo xtask browser    # the browser gate: shader compile budgets, then every example page in Chrome
cargo xtask bench      # every scenario swept over sizes in Chrome: time, work, and how each grows
cargo xtask wasm       # latkit-js → npm/pkg, the npm wrapper → npm/dist (--dev: no wasm-opt)
cargo xtask examples   # wasm --dev, then the examples at http://127.0.0.1:5200 (--open: in the browser)
```

## Foundation

1. **One direction:** data → derived data → motion → pixels. Structure comes from data on the CPU,
   never from a readback; readbacks only answer questions (pick, locate), size GPU work, and carry
   pictures out.
2. **The camera is only an eye:** no derivation reads it. Labels hang from world anchors projected
   every frame; screen-space decisions (legibility, map label collisions) only toggle visibility,
   and only labels that show have their texts set.
3. **Derived data is data:** places, sizes, boxes, routes, lanes, triangles, and earth paths are
   columns the view keeps beside each table, row for row, paged, uploaded, and eased like any column.
   Every derivation shares one lifecycle (`src/derive/`): a stamp of what it reads; work that fits
   the frame's one budget done on it; the rest a host job answering a `Patch`, kept only where what
   it was asked from still holds. Tiles are the camera asking: the one derivation reading it.
4. **Motion eases changes, never drives them:** data and derived data ease alike; changes during a
   drag apply at once; geometry morphs point by point, by fraction along where the counts differ.
   **Time is an input:** every frame and input carries the time of whatever draws it (an animation
   frame, a video frame, a test's step), and each view's clock moves by the steps between, a quarter
   second at most and never back. Eases, flights, coasting, orbits, fades, and `elapsed()` read it,
   never the wall, and what reads it evaluates only when it moves.
5. **Primitives:** points, strokes, triangles, glyphs. A stroke runs along one path kind, fixed per
   pipeline: ends (straight, geodesic, lanes), trace (samples), or geometry (any written polyline);
   a triangle's corners come from ends (faces) or geometry (areas). Geometry is a field: vertices
   read points, lines paths and rings, areas polygons, from `geometry` unless told otherwise. A text
   run is rasterized once as a distance field: any size, halo from the field.
6. **Lists:** count → scan → write. Capacity is a CPU-known bound; a list past it coarsens every
   item instead of dropping the last.
7. **Eyes:** every pass draws through an `Eye` (projection, size, pixel ratio): the view or the shadow
   light. A picture is a frame like any other, drawn at a size of its own.
8. **Geometry is the world's:** lanes bow by a share of their edge's length, arcs follow great
   circles, and both are pieces of the path, so the camera never reshapes them. The globe writes its
   depth a hair under its surface, and a mark past its horizon draws nothing. A segment list keeps
   each segment's distance along its path, so dashes and comets run on across segments.
9. **Work follows what shows:** a view plans what it draws within its share of the `Budget`. A
   table draws whole while it fits and is no denser than a screen shows; a larger one a mark places
   on a map or a plane draws through tiles. A job gives each row the coarsest level it shows at, by
   its size, then its `priority`; edges land by their own, carrying their ends. The rows of the tiles
   the camera wants, as many as the plan holds, are the dataset marks draw, so glow, lanes,
   transitions, and labels work unchanged, and picks and selection name source rows. A table a mark
   traces draws whole, its traces as coarse in time as fit. GPU pages are one size in one pool, the
   least recently drawn evicted first, so what draws always fits.
10. **Complete:** a frame is complete when nothing in it stands in for work under way: no page
    waiting to upload, no tile drawn as its ancestor, no table as its first sample, no row standing
    where it was until a layout lands, no wire drawn as elbows, no area as its earlier triangles, no
    label at its estimated size, no fit due. Every derivation says so of itself, and `Stats::waiting`
    names what a frame stood in for; pictures, video frames, tests, and the benchmark wait on the one
    predicate.
11. **Events tell what the application did not do itself:** setters are silent. An intent (click,
    open, menu, drag, connect, delete) is told once, in the order the user acted; one waiting on a
    pick holds the intents after it. A change (hover, selection, camera, `Waiting`) tells only its
    latest, and its state can always be read (`hovered`, `selection`, `camera`, `Stats::waiting`,
    `failures`), so a listener added late reads what it missed. Every intent and hover carries its
    `Trigger`: point, keys, and device. The keys are a device: Tab and arrows step the hover through
    rows. Events cross to JavaScript as JSON, a batch per dispatch, like all of a view's state.

## Rules

- CPU per frame is O(marks), plus O(changed pages) on new data, O(sampled pages) when `at` moves,
  and O(rows drawn) when the tiles the camera wants change.
- Work superlinear in graph size runs in a host job, never on the frame.
- Picks probe what the frame drew, through the draws' own geometry. Hover follows the frame: what
  the pointer rests on is probed again whenever the frame changes under it, one probe in flight;
  `Controls::hover` only says whether it glows.
- A scene's pipelines are made on its first frame; only custom markers compile WGSL at runtime.
- Every order the user can see comes from count → scan → write, never from atomic appends.
- Every shader passes naga at build time and Chrome within its compile budget.
- Every wait races a deadline; readbacks are taken, never awaited. A view sleeps while it waits:
  readbacks, jobs, fetches, and uploads wake it.
- Size never fails a draw: the plan always fits the budget, and `priority` decides what draws first,
  on top, and labeled.
- No public type before it draws. `Stats::gpu_ms` is the median of the last frames the device timed.
- Work is counted exactly (`Gpu::work`: bytes uploaded and written, rows evaluated, readbacks, jobs,
  texts, pipelines); every write goes through the counting queue. The benchmark (`npm/bench`) climbs
  each scenario's sizes while the last one fits a phase's limit, times each phase from its action to
  the frame where every view is complete, holds it to how it may grow, to the committed work, and to
  this machine's times, and stops the sweep at a lost device.
- A dataset's versions ease from one to the next; another dataset of the same name replaces it, its
  rows fading in as the old fade out. Rows that only fade evaluate once.
- A picture composes on the GPU into exactly the bytes its consumer takes, RGBA for an image and
  NV12 for an encoder; the CPU touches no pixel. A view draws at one size at a time: while a shot
  draws it, its canvas holds its last frame.

## Spaces

| Space     | Positions           | Lengths                   | Camera                           | Only here                                       |
| --------- | ------------------- | ------------------------- | -------------------------------- | ----------------------------------------------- |
| `Earth`   | longitude, latitude | CSS px, or `units`        | pitch, bearing; mercator ↔ globe | geodesic edges, tiles, daylight, atmosphere     |
| `Plane`   | x, y, elevation     | CSS px, or `units`        | pitch, bearing                   |                                                 |
| `Plot`    | axis, value         | CSS px                    | x and y ranges                   | axes, playhead                                  |
| `Diagram` | x, y down           | units: a CSS px at zoom 0 | center, zoom                     | ports, groups, nets, orthogonal routes, layouts |

## Diagram

A 2D sheet. Every length is a unit, theme lengths included; strokes keep at least a hairline, and
only glow, halo, and pick radius stay pixels. Zooming scales one fixed picture.

- **Sheet** (`src/sheet/`): sizes (a block without one fits its label and ports) → places → boxes
  (groups innermost first: members, padding, header band) → wires (routes, or elbows until a job
  lands). It writes a derived table beside each table it draws.
- **Structure reads data only:** position and size can't read hover, zoom, time, or sampled fields
  (a compile error naming the option). Looks read anything on the GPU, so live values recolor a
  diagram without touching its structure. `visible` is a look: hidden rows fade, nothing moves.
- **Stable:** places persist by row id, even after a row leaves, and a row that loses its position
  stays where it stood. A layout places only rows without one, with placed rows as pins. A wire
  routes again only when its terminals move or a box near it changes. `View::arrange` lays every
  row without a position out again; rows stand where they are until it lands, then ease there.
- **Interaction:** a drag's patches show at once; a moved row's wires route again on the frame, and
  a large change routes in a job, its wires keeping their routes, or elbows where their ends moved,
  until it lands. `locate` answers from the sheet.
- **Look:** labels hang from their anchors every frame, scale with the sheet, show while they fit,
  and fade below a legible size; port labels sit inside their markers. Groups draw a header band
  with their title, a hairline border, and a fill tinted by depth. Wires round their bends, dot
  their junctions, and point at inputs; outputs drive their nets. Free ports are hollow. Hover
  glows; nothing grows.

## Geography

- **Data:** `geo::geojson(name, bytes)` reads GeoJSON (gzip-compressed or not) into tables
  `points`, `lines`, and `polygons`, properties as fields; npm reads it in a worker.
- **Tiles:** `View::set_tiles(Tiles::vector(name, url))` takes a PMTiles archive, TileJSON, or a
  `{z}/{x}/{y}` template. The camera picks tiles that draw at most their size, nearest first; the host
  fetches them (`Host::fetch`, ranges for archives); jobs decode them, clipped to their tile, into a
  dataset the view owns. A layer is a table of the kind its marks draw (or `layer:polygons|lines|points`);
  row ids come from the tile and the feature's place, so they are stable. A tile not loaded draws its
  nearest loaded ancestor; fetched bytes stay within a budget, least recently drawn first.
- **Shapes:** areas triangulate by ear clipping with holes, in a job when large, kept per page and per
  row so a tile landing shapes only its rows. On the earth, longitudes unwrap across the antimeridian,
  triangles split along a 2° grid and paths gain points every 2°, so both bend with the globe.
- **Look:** `Earth::daylight(seconds)` lights the ground and what stands on it by the sun at that
  instant plus the view's axis coordinate, down to the theme's `night`; `atmosphere` rings the globe.
  Globe gestures keep the point under the pointer exactly.

## Pictures and video

- **Shot** (`src/shot.rs`): plain data, a picture of views each drawn into its part of `size` pixels
  at `scale` pixels per CSS pixel. `image(views)` steps the views' clocks a sixtieth of a second while
  they ease and waits while work is under way, within a deadline, until every view is complete and
  still; `compute/compose.wesl` then writes each panel's part in whole words, and a plain buffer copy
  reads the RGBA back. `Image::png` writes it; the npm package writes it in a worker.
- **Video** (`src/video/`): a shot's frames at a fixed rate handed in order to a `Sink`, which
  says the `Pixels` it takes (RGBA or NV12), composed on the GPU; three frames under way (one
  drawing, one reading back, one in the sink). A frame where nothing moved is neither drawn nor read
  back: the sink is told it is held. `Mp4` is the sink most videos take: `Host::encoder`, NV12 in and
  Annex B out with no B-frames (WebCodecs in a browser, which npm hands the host; Media Foundation
  natively on Windows, hardware where present), and `mp4.rs`, fragmented MP4 written as it goes, a
  fragment per keyframe run. A frame lasts until the next one's time, so held frames cost nothing.
- **Titles and legends**: a scene's `title`, `subtitle`, and `legends` (a mark's colormap across
  its domain, or a cell a category) draw as overlay sprites with a plot's axes, O(legends).
- **Lending:** views lend themselves to a drawing a step at a time (`shot::Views`), so a canvas's
  view is borrowed only while a step draws it and the page reads it between steps.

## Tree

```
crates/latkit/
├── build.rs, build/   link WESL, validate with naga, mirror shared constants; colormaps; shaders.json
├── shaders/
│   ├── lib/           types, bind, read, trace, project, state, color, focus, points, path, triangles,
│   │                  stroke, marker, label, shade, lists, mark, reduce
│   ├── compute/       evaluate, freeze, bounds, normals, probe, lists, labels (map label collisions),
│   │                  compose (a shot's panels into RGBA or NV12)
│   └── draw/          backdrop (daylight, atmosphere), points, strokes, triangles, areas, glyphs, shade, overlay
├── src/
│   ├── lib.rs         the only entry point
│   ├── error.rs, pending.rs, image.rs (PNG), time.rs (bounded waits)
│   ├── shot.rs        Shot, the drawing that steps views and composes their panels
│   ├── video/         Video, Sink, Pixels, Mp4, Encoder, Encoding, Unit; mp4 (fragmented, as it goes)
│   ├── data/          columns, ids, samples, tables, patches, bytes, JSON, inverse references, geometry pages
│   ├── expr/          compile, decode, color, colormap, cpu: the executor structure reads
│   ├── scene/         Scene, marks (Vertices, Edges, Faces, Lines, Areas), Label, Port, Marker, Layout, Theme,
│   │                  Controls, spaces, decode
│   ├── derive/        Derive, Jobs (one budget, one pool), Derivations: lanes, shapes, tiles; sight (what
│   │                  the camera sees, as tiles), pyramid (each row's level, in jobs), tiled (the rows drawn)
│   ├── sheet/         a diagram's sizes, places, and boxes (mod), and its wires: a derivation
│   ├── layout/        layered, stress, overlap, pack, route (groups as soft obstacles)
│   ├── view/          View; clock, camera, rig, gestures, input, event; probe, focus, query, fit, axes, legends; plan, marks,
│   │                  program, sync, rows, transition, lists, labels, graph, shadows, variants, resources,
│   │                  uniforms, wake, timer, passes, frame
│   ├── gpu/           Gpu, Budget, work (Work, the counting queue), arena (fixed pages, one pool), pipelines,
│   │                  atlas (distance fields), readback, colormaps, icons
│   ├── host/          Host (text, jobs, fetch, encoder), Job, browser (workers, canvas text, fetch, WebCodecs),
│   │                  native (fonts, workers, files, Media Foundation)
│   ├── geo/           geojson, mvt, pmtiles, tiles, shapes, earcut
│   └── web.rs         Canvas: its surface, frames, input, events; pictures and video frames of canvases
└── tests/

npm/bench/             the benchmark: one page (scenarios, the stage measuring phases, data), the runner,
                       the judge (rules, orders, baselines), the report, baselines/ (work, times per machine,
                       the old packages' times)
```

## API

```rust
use latkit::*;

// Data: named, immutable tables, changed only by patches. A reference names rows of another table.
let mut grid = Data::new("grid");
grid.apply(
    Patch::new()
        .set(Table::new("Bus", 3).field("lon", [-97.7, -96.8, -95.4]).field("lat", [30.3, 32.8, 29.8]).field("name", ["A", "B", "C"]).field("kv", [345.0, 138.0, 69.0]))
        .set(Table::new("Branch", 2).reference("from", "Bus", [0_u64, 1]).reference("to", "Bus", [1_u64, 2]).field("p", [120.0, -40.0]).field("kv", [345.0, 138.0])),
)?;
grid.apply(Patch::new().append(0.5, "Bus", [("vm", [1.01, 0.99, 1.0])]))?; // a sampled frame
let grid = Data::from_json(&json, |file, bytes| read(file, bytes))?; // any language's JSON; slices of files

// A map: marks name their data; options are expressions. Geometry is a field.
view.set_data(geo::geojson("states", &bytes)?);
view.set_tiles(geo::Tiles::vector("base", "https://tiles.openfreemap.org/planet"));
let map = Scene::new(Earth::globe().daylight(1_782_043_200.0).atmosphere(true))
    .draw(Areas::of("base", "water").color(Color::hex("#1d3557")?))
    .draw(Areas::of("states", "polygons").color(field("load").colormap(Colormap::MAKO)))
    .draw(Lines::of("base", "transportation").width(field("lanes")))
    .draw(Edges::of("grid", "Branch").ends("from", "to").flow(field("p")).priority(field("kv")))
    .draw(
        Vertices::of("grid", "Bus")
            .position("lon", "lat")
            .priority(field("kv"))                  // draws first, on top, and labeled; shows coarsest
            .color(field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05))
            .label(Label::new("name")),
    );

// A plot of a sampled field across the data's axis.
let plot = Scene::new(Plot::default()).draw(Lines::of("grid", "Bus").trace("vm"));

// A diagram: blocks with ports, nets, and groups, placed in ranks and wired around blocks.
let diagram = Scene::new(Diagram::default())
    .layout(Layered::default())                     // layouts are a diagram's alone
    .controls(Controls { connect: true, delete: true, select_box: true, ..Controls::default() })
    .draw(Vertices::of("plant", "Group").contains("Block", "group").label(Label::new("name")))
    .draw(Edges::of("plant", "Signal").route(Route::Orthogonal).arrows(true))
    .draw(
        Vertices::of("plant", "Block")
            .position("x", "y")                     // rows without x and y are placed
            .size(120.0, 44.0)                      // without it, a block fits its label and ports
            .marker(Shape::Rounded)
            .port("in", Side::Left)
            .port("out", Port::output(Side::Right)) // outputs drive their nets: ranks and arrows follow
            .drag(true)
            .label(Label::new("name")),
    );

// A view draws a scene from data by name into the caller's encoder, and turns input into events.
gpu.set_budget(Budget { bytes: 512 << 20, upload_per_frame: 32 << 20 }); // before data draws
let mut view = View::new(&gpu, diagram)?;
view.set_data(plant);                     // cheap: unchanged pages are shared
view.fit(Fit::All);
view.render(&mut encoder, &frame);        // each frame, at its time; the caller submits
view.input(&input, time);
for event in view.events() {                       // in the order the user acted
    match event {
        Event::Drag { hit, position, .. } => {}         // patch hit.row's x and y to position
        Event::Connect { from, to: Some(to), .. } => {} // name from's net in to's port
        Event::Delete { rows, .. } => {}                // remove the rows
        Event::Menu { hits, trigger } => {}             // a menu at trigger.point, for the keys too
        _ => {}
    }
}
let hits = view.pick([120.0, 80.0], 6.0); // Pending<Vec<Hit>>, nearest first
view.arrange();                           // lay out every row without a position again
let Stats { rows, drawn, resident, budget, waiting, .. } = view.stats(); // rows, GPU bytes, work under way

// Pictures and video: plain data, drawn once every view is complete.
let png = Shot::new([3840, 2160]).scale(2.0).image(&mut [&mut view]).await?.png();
let shot = Shot::new([1920, 1080]).scale(1.5).panel([0.0, 0.0, 1.0, 0.7]).panel([0.0, 0.7, 1.0, 0.3]);
let mut video = shot.video(&gpu, 60.0, Mp4::new(file))?; // or any Sink: raw frames, PNGs
while video.time() < 24.0 {
    map.set_at(video.time() * 3600.0);            // the script is the loop
    video.frame(&mut [&mut map, &mut plot]).await?;
}
video.finish().await?;
```

npm `latkit` mirrors the crate with scenes as JSON; its `Data.apply` returns the next version,
`geojson` and `Image.png` run in a worker, and `Shot.video` encodes with WebCodecs:

```ts
const png = await (await new Shot([3840, 2160]).scale(2).image([view])).png();
const video = new Shot([1920, 1080])
  .panel([0, 0, 1, 0.7])
  .panel([0, 0.7, 1, 0.3])
  .video(gpu, 60, writable);
while (video.time < 24) {
  map.at = plot.at = video.time * 3600;
  await video.frame([map, plot]);
}
await video.finish();
```

## Milestones

| Step                 | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1–M4                | data, expressions, arena, probes; transitions, shadows; labels, picks, samples; graph, layouts, routes, groups                                                                                                                                                                                                                                                                                                                                                   | ✓      |
| Gate, Cutover, Pages | browser gate; host jobs in workers, path kinds, lists that coarsen; telemetry and diagram studio pages                                                                                                                                                                                                                                                                                                                                                           | ✓      |
| Sheet                | `Diagram`; derived data and geometry pages; the CPU executor; the sheet with incremental layout and routing; jobs answer with patches; stress as a job; `Port::output`; `arrange`; anchored labels and distance-field text; drags apply at once; the diagram page rebuilt on it. Removed folding, the GPU groups and stress passes, stand-ins, and the view's layout and route words                                                                             | ✓      |
| M5                   | `src/derive/`: one lifecycle, budget, and pool for the sheet, lanes, shapes, and tiles; geometry as a field (lines along paths and rings); `Areas` (ear clipping in jobs, cached per page and row, earth grid split); `geo::geojson`; `Host::fetch`, PMTiles, TileJSON, MVT decoded in jobs into a view-owned dataset; daylight, atmosphere, exact globe gestures; groups as soft router obstacles; atlas residency by placement; Grid at scale and Colors pages | ✓      |
| Scale                | `cargo xtask bench` and budgets; GPU time in `Stats`; fixed pages in one pool within a `Budget`; plans that always fit; tiles for anything large (pyramids in jobs, edges with their ends); `priority`; views that sleep while they wait; lanes as world-space bows; globe occlusion by depth; dashes and comets along paths; focus draws only lit rows; bulk column reads; the 2M-bus grid and Grid operations pages                                            | ✓      |
| M6                   | time as an input (`Frame`, `input(time)`, the view's clock); `complete`; `Shot` and `Image` (compose pass, PNG in a worker); `Video` (NV12 on the GPU, three frames under way, held frames free, fragmented MP4, `Host::encoder` with WebCodecs); npm `Shot`, `Image`, `Video`                                                                                                                                                                                   | ✓      |
| Interaction          | `Event` as intents and changes in one ordered queue (picks hold their place, changes keep their latest); `Trigger` (point, keys, `Device`) on every intent and hover; silent setters; `hovered`, `failures`, the `Waiting` event; hover follows the frame, `Controls::hover` only glows; the keys step, open, and select; npm events and view state as JSON, a batch per dispatch; ids checked, never truncated                                                  | ✓      |
| CLI                  | `latkit-cli`: render, validate, inspect; `Sink`, `Pixels`, `Mp4`; native H.264 (Media Foundation) and files in `Native`; `Data`/`Patch` and `Shot` as JSON; titles and legends; native shots draw again at once when uploads are due                                                                                                                                                                                                                             | ✓      |
| Retire               | delete `packages/`, `examples/`, `benchmark/`, the old `docs/` and their configs                                                                                                                                                                                                                                                                                                                                                                                 | ○      |
