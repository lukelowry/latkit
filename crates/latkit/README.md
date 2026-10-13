# latkit

Columnar data drawn as vertices, edges, faces, lines, and areas on the GPU. This file is the plan:
the target tree, the foundation every feature builds on, and the public API still to implement.
✓ done · ◐ partial · ○ to do.

```sh
cargo xtask check      # fmt, clippy (no-default, all features, wasm32), tests, docs, TypeScript
cargo xtask wasm       # latkit-js → npm/pkg, then the npm wrapper → npm/dist (--dev: faster, no wasm-opt)
cargo xtask examples   # wasm --dev, then the example suite at http://127.0.0.1:5200
```

## Foundation

Five concepts; every feature is a source or a stage of one of them.

| Concept | What it is | Used by |
|---|---|---|
| **Primitives** | Four draw shaders: points, strokes, triangles, glyphs. A mark compiles to one or more `Draw`s, each a primitive fed by a source. One geometry function per primitive serves draw, cast, probe, bounds, and label anchors. | every mark |
| **Lists** | count → scan → write: per-item counts, a reduce-then-scan, each item writes at its offset. Totals land in indirect draw and dispatch arguments; capacity is a CPU-known bound. | variable segments, picks, box select |
| **Motion** | A store mode of `evaluate`: while a mark eases, every store blends from the row's `frozen` state. Exits are rows past `mark.rows`, fading. Draws, probes, bounds, labels, and shadows read one state. | scene and data changes, layouts |
| **Eyes** | Every pass draws through an `Eye` uniform (projection, size, pixel ratio); `Frame` holds the rest. Main view, shadow light, and exported images are eyes; `cast` swaps only the fragment output. | shadows, image, video |
| **Derived** | What the view derives from data rebuilds only when a stamp of the versions it reads changes. On the CPU: graph words beside each mark's program (lanes, bends and routes, net terminals, ports, group members) and layouts' `places`. On the GPU: group bounds and stand-ins, segment lists, normals, shadows, labels. | graph, layouts, groups, normals, shadows, labels |

| Mark | Draws |
|---|---|
| `Vertices` | points(rows, groups around members) · points(ports) · glyphs(labels) |
| `Edges` | strokes(ends: straight, geodesic, bends, routes, lanes · nets: stars or routes at ports) · glyphs |
| `Faces` | triangles(slots) |
| `Lines` | strokes(trace: levels, steps) · glyphs |
| `Areas` | triangles(geometry) + strokes(rings) · glyphs |

## Frame

| Stage | Runs when | CPU | GPU |
|---|---|---|---|
| settle | readbacks landed: probe, fit, pick, locate, glyphs | O(marks) | — |
| advance | rig, transition progress | O(marks) | — |
| sync + derive | data, scene, or `at` changed | O(changed pages) | — |
| pump | uploads pending | O(bytes) | copies |
| rows + pack | rows or marks changed | O(marks) | region copies |
| compute | freeze → evaluate → reduce → groups\* → segments\* → normals\* → bounds\* | O(marks) | O(dirty rows) |
| place | a layout's or a route's inputs changed\*: stress rounds, readbacks for layered and routes | O(graph), on change | O(terms) |
| shadow | casters or eye moved\* | O(casters) | casters + levels |
| labels | labeled marks moved\* | O(marks) | claim, decide rounds |
| main | always | O(draws) | backdrop, draws, overlay |
| probe | a probe or a query waits | O(marks) | O(instances) |

\* only when its stamp changed.

## Tree

```
crates/latkit/
├── Cargo.toml                     ◐ features: gpu (default), serde, web · geo, video, winit ○
├── build.rs, build/               ✓ link (WESL), validate (naga), mirror the contract; colormap catalog
├── shaders/
│   ├── lib/
│   │   ├── types.wesl             ✓ every struct and constant shared with Rust: Frame, Eye, Mark, Shade
│   │   ├── bind.wesl              ✓ group 0 frame, eye (dynamic), pages, program, focus · 1 mark · 2 pass
│   │   ├── read.wesl, trace.wesl  ✓ columns as bits, joins; traces at a level of detail
│   │   ├── project.wesl           ✓ plane, plot, mercator, globe through the eye; hi/lo; reversed depth
│   │   ├── state.wesl             ✓ row state in two planes; vertex slots and the folded groups standing in
│   │   ├── color.wesl, focus.wesl ✓ colormaps, sRGB output; selected, hovered, dimmed, presence
│   │   ├── points.wesl            ✓ point(row), ports, any slot's size in pixels
│   │   ├── path.wesl              ✓ segment(instance): ends (straight, geodesic, written), nets, traces,
│   │   │                            geometry; lanes, ports, outlines; each source made once
│   │   ├── triangles.wesl         ✓ triangle(instance): faces
│   │   ├── stroke.wesl            ✓ antialiased segments, dashes, comets, arrows
│   │   ├── marker.wesl            ✓ shapes, block, status, gauge, pie, icon, glow; custom WGSL
│   │   ├── shade.wesl             ✓ the shadow map: cast, lit
│   │   ├── lists.wesl, places.wesl ✓ list headers and entries; layouts' places
│   │   └── mark.wesl, reduce.wesl ✓ px(); ordered floats for atomics
│   ├── compute/
│   │   ├── evaluate.wesl          ✓ expression machine; eased stores; fading exits; vertex size flags
│   │   ├── freeze.wesl            ✓ what rows showed, gathered by id, for transitions
│   │   ├── bounds.wesl            ✓ extents of every primitive's instances
│   │   ├── normals.wesl           ✓ vertex normals from faces, fixed point
│   │   ├── probe.wesl             ✓ nearest, topmost, describe, under, hits, boxes, locate; a pipeline
│   │   │                            per primitive
│   │   ├── lists.wesl             ✓ count, scan, write; segment lists; indirect arguments
│   │   ├── labels.wesl            ✓ candidates, claim, decide, wanted runs
│   │   ├── groups.wesl            ✓ groups around members, folded stand-ins, by level
│   │   └── stress.wesl            ✓ Jacobi rounds over pivot terms, from earlier places
│   └── draw/
│       ├── backdrop.wesl          ◐ grid, graticule, ground shadows · daylight, atmosphere ○
│       ├── points.wesl            ✓ markers, glow, status · cast · ports
│       ├── strokes.wesl           ✓ every stroke, drawn directly or from a segment list · cast
│       ├── triangles.wesl         ✓ lit faces, shadows received · cast
│       ├── glyphs.wesl            ✓ label runs with halos
│       ├── shade.wesl             ✓ shadow map levels
│       └── overlay.wesl           ✓ axes, box, connection being drawn: lines and text
├── src/
│   ├── lib.rs                     ✓ the only entry point
│   ├── error.rs                   ✓ Error with code(), Path, Step
│   ├── data/                      ◐ name, buffer, bits, text, geometry, values, column, ids, samples
│   │                                (levels by 8), table, data, patch, bytes, tests · sparse tables ○
│   ├── expr/                      ✓ mod, color, colormap, compile, decode
│   ├── scene/
│   │   ├── mod.rs, controls.rs    ✓ Scene, Controls
│   │   ├── mark.rs                ✓ Mark, Draw, Primitive, shared style, interaction, label, keys
│   │   ├── vertices.rs            ✓ position, radius, size, elevation, marker, status, ports, groups
│   │   ├── edges.rs               ✓ ends, nets, width, dash, flow, bends, route, arrows
│   │   ├── faces.rs, lines.rs     ✓ corners; samples, width, dash, interpolation · path ○
│   │   ├── label.rs, port.rs      ✓ Label; Port, Side
│   │   ├── marker.rs              ✓ shapes, block, gauge, pie, icon, wgsl
│   │   ├── space.rs               ◐ Earth, Plane, Plot, Axis (ticks, format) · daylight, atmosphere ○
│   │   ├── theme.rs               ✓ colors, sizes, Shadow, halo, edge spacing, arrow, group padding
│   │   ├── layout.rs              ✓ Layout, Stress, Layered, Route, Interpolation
│   │   └── decode.rs              ✓ JSON form; `#hex` strings are colors
│   ├── gpu/                       ✓ Gpu, Budget · arena, pipelines (prepare), colormaps, icons,
│   │                                dictionary, shaders, readback (pool), atlas (LRU)
│   ├── host/                      ◐ Host (rasterize, wrap), TextRun, Raster, browser · spawn, fetch ○
│   ├── layout/                    ✓ layered (ranks, crossings, groups), pack, route (orthogonal; nets as
│   │                                trees)
│   ├── view/
│   │   ├── mod.rs                 ✓ View API
│   │   ├── camera.rs, rig.rs      ✓ Camera, projection, gestures' geometry; motion owed and paid out
│   │   ├── gestures.rs, input.rs  ✓ press, drag, pan, turn, pinch, wheel, keys, box, connect, menu
│   │   ├── probe.rs, focus.rs     ✓ probes, anchors, hover; selection and fit words
│   │   ├── query.rs               ✓ Pending; picks, box select, locate
│   │   ├── event.rs, fit.rs       ✓ Event, Hit, End, Sample, Drag, Fit, Cursor, Stats; fits
│   │   ├── axes.rs                ✓ ticks (auto, given), formats, playhead
│   │   ├── rows.rs                ✓ row regions in every per-row buffer; moves by copy
│   │   ├── transition.rs          ✓ freeze, remap by id, exits, slot remap
│   │   ├── lists.rs               ✓ List, scans, segment lists laid out and counted
│   │   ├── shadows.rs             ✓ the light's eye, the map, its levels
│   │   ├── labels.rs              ✓ run tables, wanted runs, placement passes
│   │   ├── graph.rs               ✓ graph words: lanes, bends and routes, terminals, ports, members;
│   │   │                            neighbors
│   │   ├── places.rs              ✓ layouts (layered on the CPU, stress on the GPU) and orthogonal
│   │   │                            routes around what shows, folded groups included
│   │   ├── marks, sync, program, resources, uniforms, passes, frame  ✓
│   │   ├── history.rs             — replaced by sample levels in data
│   │   └── tiles.rs               ○ visible tiles (M5)
│   ├── geo/, video/               ○ geojson, mvt, pmtiles, tiles; record, mp4, webm
│   ├── web.rs                     ✓ Canvas, one frame per Gpu, input, events, cursor, prepare
│   └── winit.rs                   ○ Input from winit events
├── tests/                         ✓ render, scenes, transitions, shadows, labels, markers, picks, graph,
│                                    groups, layouts, gestures
└── benches/, examples/            ○
```

## Decisions

- **Probes are a compute pass** over what the frame drew, depth-tested, through the same geometry
  functions the draws use: what you see is what you pick.
- **Gestures move about the point under the pointer**; the rig pays out owed motion; fits bound it.
- **The camera looks at a point in space**: `center` is `[x, y, elevation]`.
- **One frame per `Gpu` in browsers**: frame listeners, then every canvas, then one submit.
- **Shadows**: one RGBA16F map fitted to the ground from a world-fixed light, blended by MIN (1 −
  coverage, lowest caster, −highest caster). The ground darkens at the level its lowest caster
  sets; faces compare their height to the highest. Flat marks cast as if raised by `lift`.
- **Multisampling**: 4× below a pixel ratio of 1.75, else 1×; depth is stored only when probed.
- **Labels** are runs the host sets; claim/decide on an 8 px grid places them by priority; runs not
  yet in the atlas are asked for and appear a frame later.
- **Edges on the earth are geodesic** unless their route says otherwise.
- **A port is a reference field** of a vertex table naming a net row; an `Edges` mark without ends
  draws its rows as nets joining the ports that name them.
- **Graph words, not data fields**: lanes, bends, routes, terminals, ports, and members are written
  beside each mark's program and rebuilt when the topology they read changes.
- **Strokes stop at vertex outlines** (a box when sized, else a circle), so arrowheads show. Each
  vertex row's flags say whether its size is in position units, so any reader of a slot knows it.
- **Groups** are vertex marks that contain rows: a groups pass stands each around its members, or at
  its own size when folded, and writes the folded group standing in for each slot; every read of a
  vertex slot follows it, so edges end at the group and members hide.
- **Layouts place unpinned vertices** and write `places`, which the position store eases toward:
  layered on the CPU from sizes and pins read back once, stress on the GPU in Jacobi rounds over
  pivot terms. A fit waits for a layout to land.
- **Routes** are worked out on the CPU around what shows, from vertex boxes read back once vertices
  settle; an edge with ends runs from its vertices' middles through its route.
- **Probe pipelines are made per primitive, on first use**: a pipeline constant keeps each to one
  primitive's geometry, since Chrome's shader compilers took seconds on the combined probe.
- **One view per canvas.** No public types before they draw.

## Public API

```rust
impl View {
    pub fn pick(&mut self, point: [f32; 2], radius: f32) -> Pending<Vec<Hit>>;   // ✓ nearest first
    pub fn locate(&mut self, row: &Row) -> Pending<Option<[f32; 2]>>;            // ✓
    pub fn neighbors(&self, row: &Row) -> Vec<Row>;                              // ✓
    pub fn image(&mut self, size: [u32; 2], pixel_ratio: f32, camera: &Camera) -> Pending<Image>;  // ○ M6
    pub fn set_tiles(&mut self, tiles: geo::Tiles);                              // ○ M5
}
pub struct Pending<T>;   // ✓ a Future the view's frames resolve
pub enum Event { /* + */ Menu { point: [f32; 2], hits: Vec<Hit>, keyboard: bool, modifiers: Modifiers },
                 Connect { from: End, to: Option<End>, edge: Option<Row>, point: [f32; 2] },
                 Delete(Vec<Row>) }                                              // ✓
pub struct Hit { /* + */ pub port: Option<Name>, pub sample: Option<Sample> }   // ✓
pub struct End { pub row: Row, pub port: Option<Name> }                          // ✓
pub struct Sample { pub frame: u32, pub at: f64, pub value: f64 }                // ✓
pub struct Controls { /* + */ pub select_box: bool, pub connect: bool, pub delete: bool }  // ✓

impl Vertices { pub fn status(self, color: impl Into<Expr>) -> Self;            // ✓
                pub fn port(self, reference: impl Into<Name>, port: impl Into<Port>) -> Self;
                pub fn contains(self, table: impl Into<Name>, reference: impl Into<Name>) -> Self;
                pub fn collapsed(self, collapsed: impl Into<Expr>) -> Self; }   // ✓
impl Edges { pub fn bends(self, field: impl Into<Name>) -> Self; pub fn route(self, route: Route) -> Self;
             pub fn arrows(self, on: bool) -> Self; pub fn shadow(self, on: bool) -> Self; }   // ✓
impl Lines { pub fn interpolation(self, i: Interpolation) -> Self;               // ✓
             pub fn path(self, field: impl Into<Name>) -> Self; }                // ○ M5
// every mark: .label(Label)                                                     // ✓
pub struct Label;   // new(text), size, color, priority, spacing, max_width       ✓
pub struct Areas;   // of, rings(field), outline(Size)                            ○ M5
pub enum Marker { Shape(Shape), Block { corner: f32 }, Gauge { fill: Expr, shape: Shape },
                  Pie { slices: Vec<Expr>, colors: Vec<Color>, hole: f32 },
                  Icon { images: Vec<Image>, index: Expr }, Wgsl { source: Arc<str>, inputs: Vec<Expr> } }  // ✓
pub struct Image { pub size: [u32; 2], pub rgba: Arc<[u8]> }                     // ✓ + png() ○
pub struct Port { pub side: Side, pub order: Option<u32>, pub label: Option<String>, pub shape: Shape }  // ✓ · label drawn ○ M5
pub enum Side { Left, Right, Top, Bottom }                                       // ✓
pub enum Route { Straight, Geodesic, Orthogonal }                                // ✓
pub enum Interpolation { Linear, StepBefore, StepAfter }                         // ✓

pub struct Theme { /* + */ pub shadow: Shadow, pub halo: f32, pub edge_spacing: f32, pub arrow: f32, pub group_padding: f32 }  // ✓
pub struct Shadow { pub color: Color, pub light: [f32; 3], pub softness: f32, pub lift: f32 }    // ✓
pub struct Axis { /* + */ pub ticks: Option<Vec<(f64, Option<String>)>>, pub format: Format, pub precision: Option<u8> }  // ✓
pub enum Format { Auto, Fixed, Scientific, Engineering }                         // ✓
pub struct Earth { /* + */ pub daylight: Daylight, pub atmosphere: Option<Color> }  // ○ M5
pub enum Daylight { Off, Now, At(f64) }                                          // ○ M5

impl Gpu { pub fn prepare(&self, format: wgpu::TextureFormat, samples: u32); }   // ✓
pub mod host { /* Host + */ fn spawn(&self, job: Job); fn fetch(&self, url: &str, range: Option<Range<u64>>) -> Loading<Arc<[u8]>>; }  // ○
pub mod geo { pub fn geojson(name: impl Into<Name>, bytes: &[u8]) -> Result<Data>; pub struct Tiles; }   // ○ M5
pub mod video { pub async fn record(..) -> Result<()>; }                         // ○ M6
pub mod winit { pub fn input(event: &winit::event::WindowEvent, scale: f64) -> Option<Input>; }  // ○ M6
```

npm `latkit` mirrors the crate.

## Milestones

| Step | Contents | Status |
|---|---|---|
| M1 | data, expressions, arena, probes, rig, ground; bunny and grid | ✓ |
| M2 | the five concepts; shadows; transitions; frame fixes (samples by ratio, depth on probe frames, normals by version, readback pool, prepared pipelines, device loss) | ✓ |
| M3 | labels; pick, locate, box select; sample levels, steps, axis formats, `Hit.sample`; gauge, pie, icon, WGSL markers | ✓ |
| M4 | graph words, nets, ports, bends, orthogonal routes, lanes, arrows, groups and folding, stress, layered; Connect, Delete, Menu; `neighbors`; the diagram example | ✓ |
| M5 | Areas, `Lines.path`, GeoJSON, tiles, daylight, atmosphere, exact globe gestures, port labels | ○ |
| M6 | `image`, video, winit, benchmarks, docs | ○ |

## Rules

- CPU per frame is O(marks), plus O(pages of changed columns) on new data, plus O(sampled row pages)
  when `at` moves. Streaming appends never lay marks out again.
- Only custom markers compile WGSL at runtime; expressions, data, and scenes never do.
- Every order the user can see comes from count → scan → write, never from atomic appends.
- Every shader passes naga at build time and Chrome at runtime (browser smoke test).
- Every wait races a deadline: GPU tests poll with a timeout, readbacks are taken, never awaited.
