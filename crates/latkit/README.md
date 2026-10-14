# latkit

Columnar data drawn as vertices, edges, faces, lines, and areas on the GPU. This file is the plan.
✓ done · ◐ partial · ○ to do.

```sh
cargo xtask check      # fmt, clippy, tests, docs, TypeScript, browser gate
cargo xtask browser    # the browser gate: shader compile budgets, then every example page in Chrome
cargo xtask wasm       # latkit-js → npm/pkg, the npm wrapper → npm/dist (--dev: no wasm-opt)
cargo xtask examples   # wasm --dev, then the examples at http://127.0.0.1:5200
```

## Foundation

1. **One direction:** data → derived data → motion → pixels. Structure comes from data on the CPU,
   never from a readback; readbacks only answer questions (pick, locate, image) and size GPU work.
2. **The camera is only an eye:** no derivation reads it. Labels hang from world anchors projected
   every frame; screen-space decisions (legibility, map label collisions) only toggle visibility.
3. **Derived data is data:** places, boxes, routes, lanes, and label anchors are columns of a
   view-owned dataset joined by row id, paged, uploaded, and eased like any column. Small changes
   apply on the frame; superlinear work is a host job that answers with a `Patch`; an answer whose
   inputs changed is dropped.
4. **Motion eases changes, never drives them:** data and derived data ease alike; changes during a
   drag apply at once; geometry with as many points blends, otherwise it crossfades.
5. **Primitives:** points, strokes, triangles, glyphs. A stroke runs along one path kind, fixed per
   pipeline: ends (straight, geodesic, lanes), trace (samples), or geometry (any written polyline).
   A text run is rasterized once as a distance field: any size, halo from the field.
6. **Lists:** count → scan → write. Capacity is a CPU-known bound; a list past it coarsens every
   item instead of dropping the last.
7. **Eyes:** every pass draws through an `Eye` (projection, size, pixel ratio): the view, the shadow
   light, an exported image.

## Rules

- CPU per frame is O(marks), plus O(changed pages) on new data and O(sampled pages) when `at` moves.
- Work superlinear in graph size runs in a host job, never on the frame.
- Picks probe what the frame drew, through the draws' own geometry.
- A scene's pipelines are made on its first frame; only custom markers compile WGSL at runtime.
- Every order the user can see comes from count → scan → write, never from atomic appends.
- Every shader passes naga at build time and Chrome within its compile budget.
- Every wait races a deadline; readbacks are taken, never awaited.
- No public type before it draws. Benchmarks gate on work, which is exact, and report time.

## Spaces

| Space | Positions | Lengths | Camera | Only here |
|---|---|---|---|---|
| `Earth` | longitude, latitude | CSS px, or `units` | pitch, bearing; mercator ↔ globe | geodesic edges, tiles ○, daylight ○ |
| `Plane` | x, y, elevation | CSS px, or `units` | pitch, bearing | |
| `Plot` | axis, value | CSS px | x and y ranges | axes, playhead |
| `Diagram` ○ | x, y down | units: a CSS px at zoom 0 | center, zoom | ports, groups, nets, orthogonal routes |

## Diagram ○

A 2D sheet. Every length is a unit, theme lengths included; strokes keep at least a hairline, and
only glow, halo, and pick radius stay pixels. Zooming scales one fixed picture.

- **Sheet** (`src/sheet/`): sizes → places → boxes (groups innermost first: members, padding,
  header band) → ports → wires (routes, or elbows until one lands) → labels (anchor, wrap, and
  collisions once, since text and boxes scale together). It writes derived data.
- **Structure reads data only:** position and size can't read hover, zoom, time, or sampled fields
  (a compile error naming the option). Looks read anything on the GPU, so live values recolor a
  diagram without touching its structure. `visible` is a look: hidden rows fade, nothing moves.
- **Stable:** places persist by row id, even after a row leaves. A layout places only rows without
  one, with placed rows as pins. A net routes again only when its terminals move or change, or a
  new box covers it. `View::arrange` lays everything out again, eased.
- **Interaction:** a drag's patches show at once; a moved row's nets route again on the frame (the
  router works locally), and a large move draws elbows until its job lands. `locate` answers from
  the sheet.
- **Look:** text scales with the sheet and fades below a legible size; a block's label wraps to it;
  port labels hang at their ports. Groups draw a header band with their title, a hairline border,
  and a fill tinted by depth. Wires round their bends, dot their junctions, and point at inputs.
  Free ports are hollow. Hover glows; nothing grows.

## Tree

```
crates/latkit/
├── build.rs, build/   link WESL, validate with naga, mirror shared constants; colormaps; shaders.json
├── shaders/
│   ├── lib/           types, bind, read, trace, project, state, color, focus, points, path, triangles,
│   │                  stroke, marker, shade, lists, mark, reduce
│   ├── compute/       evaluate, freeze, bounds, normals, probe, lists, labels (map label collisions)
│   └── draw/          backdrop (daylight, atmosphere ○), points, strokes, triangles, glyphs, shade, overlay
├── src/
│   ├── lib.rs         the only entry point
│   ├── error.rs, pending.rs
│   ├── data/          columns, ids, samples, tables, patches, bytes, inverse references · geometry pages ○
│   ├── expr/          compile, decode, color, colormap · cpu ○: the executor structure reads
│   ├── scene/         Scene, marks, Label, Port, Marker, Layout, Theme, Controls, decode · Diagram ○, Areas ○
│   ├── sheet/         ○ a diagram's sizes, places, boxes, ports, wires, labels → derived data
│   ├── layout/        layered, overlap, pack, route · stress as a job ○, incremental routes ○
│   ├── view/          View; camera, rig, gestures, input; probe, focus, query, fit, axes; marks, sync, rows,
│   │                  transition, lists, labels, shadows, derived, variants, resources, uniforms, passes, frame
│   ├── gpu/           Gpu, arena, pipelines, atlas (distance fields ○), readback, colormaps, icons
│   ├── host/          Host, Job, browser workers · answers as patches ○, fetch ○, native threads ○
│   ├── geo/           ○ geojson, mvt, pmtiles, tiles, triangles
│   ├── web.rs         Canvas: frames, input, events
│   └── winit.rs       ○ input from winit
├── tests/
└── benches/           ○ work gates, time reports
```

## API

```rust
use latkit::*;

// Data: named, immutable tables, changed only by patches. A reference names rows of another table.
let mut grid = Data::new("grid");
grid.apply(
    Patch::new()
        .set(Table::new("Bus", 3).field("lon", [-97.7, -96.8, -95.4]).field("lat", [30.3, 32.8, 29.8]).field("name", ["A", "B", "C"]))
        .set(Table::new("Branch", 2).reference("from", "Bus", [0_u64, 1]).reference("to", "Bus", [1_u64, 2]).field("p", [120.0, -40.0])),
)?;
grid.apply(Patch::new().append(0.5, "Bus", [("vm", [1.01, 0.99, 1.0])]))?; // a sampled frame

// A map: marks name their data; options are expressions.
let map = Scene::new(Earth::globe())
    .draw(Edges::of("grid", "Branch").ends("from", "to").flow(field("p")))
    .draw(
        Vertices::of("grid", "Bus")
            .position("lon", "lat")
            .color(field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05))
            .label(Label::new("name")),
    );

// A plot of a sampled field across the data's axis.
let plot = Scene::new(Plot::default()).draw(Lines::of("grid", "Bus").trace("vm"));

// A diagram ○: blocks with ports, nets, and groups, placed in ranks and wired around blocks.
let diagram = Scene::new(Diagram::default())
    .layout(Layered::default())
    .controls(Controls { connect: true, delete: true, select_box: true, ..Controls::default() })
    .draw(Vertices::of("plant", "Group").contains("Block", "group").label(Label::new("name")))
    .draw(Edges::of("plant", "Signal").route(Route::Orthogonal).arrows(true))
    .draw(
        Vertices::of("plant", "Block")
            .position("x", "y")                     // rows without x and y are placed
            .size(120.0, 44.0)                      // without it, a block fits its label and ports
            .marker(Shape::Rounded)
            .port("in", Side::Left)
            .port("out", Port::output(Side::Right)) // ○ outputs drive their nets: ranks and arrows follow
            .drag(true)
            .label(Label::new("name")),
    );

// A view draws a scene from data by name into the caller's encoder, and turns input into events.
let mut view = View::new(&gpu, diagram)?;
view.set_data(plant);                     // cheap: unchanged pages are shared
view.fit(Fit::All);
view.render(&mut encoder, &target);       // each frame; the caller submits
view.input(&input);
for event in view.events() {
    match event {
        Event::Drag(drag) => {}                         // patch drag.hit.row's x and y
        Event::Connect { from, to: Some(to), .. } => {} // name from's net in to's port
        Event::Delete(rows) => {}                       // remove the rows
        _ => {}
    }
}
let hits = view.pick([120.0, 80.0], 6.0); // Pending<Vec<Hit>>, nearest first
view.arrange();                           // ○ lay out every row without a position again
```

Still to add: `Areas::of(..).rings(field)`, `geo::{geojson, Tiles}` with `View::set_tiles`, and
`Earth { daylight, atmosphere }` (M5); `View::image` and `winit::input` (M6). npm `latkit` mirrors the
crate with scenes as JSON; its `Data.apply` returns the next version.

## Milestones

| Step | Contents | Status |
|---|---|---|
| M1–M4 | data, expressions, arena, probes; transitions, shadows; labels, picks, samples; graph, layouts, routes, groups | ✓ |
| Gate, Cutover, Pages | browser gate; host jobs in workers, path kinds, lists that coarsen; telemetry and diagram studio pages | ✓ |
| Sheet | `Diagram`; derived data and geometry pages; the CPU executor; the sheet with incremental layout and routing; jobs answer with patches; stress as a job; `Port::output`; `arrange`; anchored labels and distance-field text; drags apply at once; the studio rebuilt on it. Removes folding (`collapsed`), `groups.wesl`, `stress.wesl`, `places.wesl`, stand-ins, `PATH_NET`, graph words, `view/layouts.rs`, `view/routes.rs` | ○ |
| M5 | Areas (a triangulation job), GeoJSON, tiles and `Host::fetch`, daylight, atmosphere, exact globe gestures; Grid at scale and Colors pages | ○ |
| Scale | `cargo xtask bench` with work gates, GPU timestamps, native jobs on threads, 1M-row grids | ○ |
| M6 | `image`, `png`, npm `view.video`, winit, docs; the Video page | ○ |
| Retire | delete `packages/`, `examples/`, `benchmark/`, the old `docs/` and their configs | ○ |
