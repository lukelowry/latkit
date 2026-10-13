# latkit

Columnar data drawn as vertices, edges, faces, lines, and areas on the GPU. This file is the plan:
the target tree and the public API still to implement. ✓ done · ◐ partial · ○ to do.

Today a `View` draws `Vertices`, straight `Edges`, lit `Faces`, and `Lines` tracing sampled fields
from `Data` on a plane, the earth (mercator or globe), or a plot; evaluates expressions on the GPU;
plays sampled fields back at `at`; answers the pointer through GPU probes; and moves its camera
through one rig. `web::Canvas` and the npm package run it in a browser; `npm/examples` is the suite.

```sh
cargo xtask check      # fmt, clippy (no-default, all features, wasm32), tests, docs, TypeScript
cargo xtask wasm       # latkit-js → npm/pkg, then the npm wrapper → npm/dist (--dev: faster, no wasm-opt)
cargo xtask examples   # wasm --dev, then the example suite at http://127.0.0.1:5200
```

## Tree

```
crates/latkit/
├── Cargo.toml                     ◐ features: gpu (default), serde, web · geo, video, winit ○
├── build.rs, build/               ✓ link (WESL), validate (naga), mirror the contract; colormap catalog
├── colormaps/                     ✓ catalog.txt, provenance.json, NOTICES.md
├── shaders/
│   ├── lib/
│   │   ├── types.wesl             ✓ every struct and constant shared with Rust
│   │   ├── bind.wesl              ✓ group 0 view, group 1 mark, group 2 pass
│   │   ├── read.wesl              ✓ columns as bits: pages, cursors, joins
│   │   ├── trace.wesl             ✓ every frame in view of a traced column
│   │   ├── project.wesl           ✓ plane, plot, mercator, globe; hi/lo precision; reversed depth
│   │   ├── state.wesl             ✓ row state accessors
│   │   ├── color.wesl             ✓ colormaps, scales, sRGB output
│   │   ├── focus.wesl             ✓ selected, hovered, dimmed
│   │   ├── stroke.wesl            ✓ antialiased segments, dashes, comets
│   │   ├── mark.wesl              ✓ px() and helpers every mark shares
│   │   ├── reduce.wesl            ✓ floats ordered as u32 for atomic min and max
│   │   ├── motion.wesl            ◐ easing from previous state (not bound yet)
│   │   ├── marker.wesl            ◐ shapes, block, glow, shadow · gauge, pie, icon, custom ○
│   │   └── scan.wesl              ○ prefix scan: count → scan → write
│   ├── compute/
│   │   ├── evaluate.wesl          ✓ expression machine: evaluate, reduce fitted domains
│   │   ├── bounds.wesl            ✓ extents of vertices and traces, of all rows or those marked to fit
│   │   ├── normals.wesl           ✓ vertex normals summed from faces in fixed point
│   │   ├── probe.wesl             ✓ nearest visible row, then topmost; depth drawn under the pointer
│   │   ├── lists.wesl             ○ focus and exit lists, multi-hit picks
│   │   ├── route.wesl             ○ edge segments: bends, nets, geodesics, parallel lanes
│   │   ├── stress.wesl            ○ stress layout, Jacobi iterations
│   │   ├── sort.wesl              ○ radix sort for label ranks
│   │   └── labels.wesl            ○ label placement: claim, decide
│   └── draw/
│       ├── backdrop.wesl          ◐ grid and graticule, seamless steps, grazing and distance fades · atmosphere, daylight ○
│       ├── vertices.wesl          ◐ markers, glow, shadow · custom marker variant ○
│       ├── edges.wesl             ◐ straight · routed segments, arrows ○
│       ├── faces.wesl             ✓ lit from the camera, corner colors, ground shadow
│       ├── lines.wesl             ◐ traces over a plot's axis · tiled paths, long-history decimation ○
│       ├── areas.wesl             ○ tiled fills and outlines
│       └── overlay.wesl           ✓ axes, ticks, titles, playhead: lines and text from the atlas
├── src/
│   ├── lib.rs                     ✓ the only entry point
│   ├── error.rs                   ✓ Error with code(), Path, Step
│   ├── data/                      ✓ name, buffer, bits, text, geometry, values, column, ids, samples
│   │                                (forget by whole pages), table, data, patch, bytes, tests
│   ├── expr/                      ✓ mod, color, colormap, compile, decode
│   ├── scene/
│   │   ├── mod.rs, controls.rs    ✓ Scene, Controls
│   │   ├── mark.rs                ✓ Mark, shared style and interaction, keys
│   │   ├── vertices.rs            ◐ position, radius, size, elevation, marker, shadow · status, ports, groups, label ○
│   │   ├── edges.rs               ◐ ends, width, dash, flow · nets, bends, routes, arrows, label ○
│   │   ├── faces.rs               ✓ corners, shadow
│   │   ├── lines.rs               ◐ samples, width, dash · path, route, flow, interpolation ○
│   │   ├── areas.rs, label.rs     ○
│   │   ├── port.rs, route.rs      ○ Port, Side; Route, Interpolation
│   │   ├── marker.rs              ◐ shapes, block · gauge, pie, icon, wgsl ○
│   │   ├── space.rs               ◐ Earth (graticule), Plane, Plot · daylight, atmosphere, axis ticks ○
│   │   ├── theme.rs               ◐ text, font, line, shading, shadow, playhead · halo, area, outline ○
│   │   ├── layout.rs              ✓ types only; layouts run in src/layout ○
│   │   └── decode.rs              ✓ JSON form; `#hex` strings are colors
│   ├── gpu/                       ✓ Gpu, Budget, host · arena, pipelines, colormaps, dictionary,
│   │                                shaders, readback, atlas · stats, prepare ○
│   ├── host/                      ◐ Host (rasterize), TextRun, Raster, browser · spawn, fetch, native ○
│   ├── view/
│   │   ├── mod.rs                 ✓ View API
│   │   ├── camera.rs              ✓ Camera, projection, pivoted pan, turn, and zoom, framing, limits
│   │   ├── rig.rs                 ✓ motion owed and paid out, flights, orbit, bounds
│   │   ├── gestures.rs, input.rs  ✓ press, drag, pan, turn, pinch, wheel, keys, clicks
│   │   ├── probe.rs, focus.rs     ✓ probes, anchors, hover; selection, hover, and fit words
│   │   ├── event.rs, fit.rs       ✓ Event, Hit, Drag, Fit, Cursor, Stats; fits and plot value ranges
│   │   ├── axes.rs                ✓ round ticks, labels, playhead
│   │   ├── marks, sync, program, resources, uniforms, passes, frame  ✓
│   │   ├── graph.rs               ○ vertex slots, ends, nets, lanes, groups, neighbors
│   │   ├── transition.rs          ○ double-buffered state, remap by id, exits
│   │   ├── index.rs, labels.rs    ○ screen bins from bounds; label placement
│   │   ├── history.rs             ○ progressive trace history
│   │   └── tiles.rs               ○ visible tiles, tile cache
│   ├── layout/                    ○ csr, stress (pivots), layered, orthogonal, pack, tiling
│   ├── geo/, video/               ○ geojson, mvt, pmtiles, tiles; record, mp4, webm
│   ├── web.rs                     ✓ Canvas, one frame per Gpu, input, events, cursor
│   └── winit.rs                   ○ Input from winit events
├── tests/                         ◐ render (faces, depth, probes, drags, traces), scenes ✓ · transition, layout, geo ○
└── benches/, examples/            ○
```

## Decisions

- **Probes are a compute pass** over what the frame drew, depth-tested: what you see is what you pick.
- **Gestures move about the point under the pointer.** Pan, turn, and zoom move the camera rigidly
  about it, so it keeps its place on screen; the wheel, keys, and released drags owe motion the rig
  pays out exponentially; a fit bounds where the camera can go.
- **The camera looks at a point in space**: `center` is `[x, y, elevation]`, and turns go about it.
- **One frame per `Gpu` in browsers**: frame listeners, then every canvas, then one submit.
- **Shadows are per mark**: vertices drop a soft shadow, faces cast one on the ground.
- **One view per canvas.** Anti-aliasing is fixed at 4×. No public types before they draw.

## Public API to implement

```rust
impl View {
    pub fn neighbors(&self, row: &Row) -> Vec<Row>;
    pub fn set_tiles(&mut self, tiles: geo::Tiles);
    pub fn set_samples(&mut self, samples: u32);
    pub fn pick(&self, point: [f32; 2], radius: f32) -> impl Future<Output = Result<Vec<Hit>>> + 'static;
    pub fn locate(&self, row: &Row) -> impl Future<Output = Result<Option<[f32; 2]>>> + 'static;
    pub fn image(&self, size: [u32; 2], pixel_ratio: f32, camera: &Camera) -> impl Future<Output = Result<Image>> + 'static;
    pub fn ready(&mut self) -> impl Future<Output = Result<()>> + '_;
}
pub enum Event { /* + */ Menu { point: [f32; 2], hits: Vec<Hit>, keyboard: bool, modifiers: Modifiers },
                 Connect { from: End, to: Option<End>, replaces: Option<End>, point: [f32; 2] }, Delete(Vec<Row>) }
pub struct Hit { /* + */ pub port: Option<Name>, pub sample: Option<Sample> }
pub struct End { pub row: Row, pub port: Option<Name> }
pub struct Sample { pub frame: u32, pub at: f64, pub value: f64 }
pub struct Image { pub size: [u32; 2], pub rgba: Arc<[u8]> }   // + png()

impl Vertices { pub fn status(self, color: impl Into<Expr>) -> Self; pub fn port(self, reference: impl Into<Name>, port: impl Into<Port>) -> Self;
                pub fn contains(self, table: impl Into<Name>, reference: impl Into<Name>) -> Self; pub fn collapsed(self, field: impl Into<Name>) -> Self; }
impl Edges { pub fn bends(self, field: impl Into<Name>) -> Self; pub fn route(self, route: Route) -> Self; pub fn arrows(self, on: bool) -> Self; }
impl Lines { pub fn path(self, field: impl Into<Name>) -> Self; pub fn interpolation(self, i: Interpolation) -> Self; pub fn flow(self, e: impl Into<Expr>) -> Self; }
pub struct Areas;   // of, rings(field), outline(Size)
pub struct Label;   // new(text), size, color, priority, limit, spacing, max_width, wrap; every mark: label(..)
pub enum Marker { /* + */ Gauge { fill: Expr, shape: Shape }, Pie { slices: Vec<Expr>, colors: Vec<Color>, hole: f32 },
                  Icon { images: Vec<Image>, index: Expr }, Wgsl(WgslMarker) }
pub struct Port { pub side: Side, pub order: Option<u32>, pub label: Option<String>, pub shape: Shape }
pub enum Side { Left, Right, Top, Bottom }
pub enum Route { Straight, Geodesic, Orthogonal }
pub enum Interpolation { Linear, StepBefore, StepAfter }

pub struct Earth { /* + */ pub daylight: Daylight, pub atmosphere: Option<Color> }
pub enum Daylight { Off, Now, At(f64) }
pub struct Axis { /* + */ pub ticks: Option<Vec<(f64, Option<String>)>>, pub format: Format, pub precision: Option<u8> }
pub enum Format { Auto, Fixed, Scientific, Engineering }
pub struct Theme { /* + */ pub halo: f32, pub area: Color, pub outline: Color, pub edge_spacing: f32 }

impl Gpu { pub fn stats(&self) -> GpuStats; pub fn prepare(&self, format: wgpu::TextureFormat); }
pub mod host { /* Host + */ fn spawn(&self, job: Job); fn fetch(&self, url: &str, range: Option<Range<u64>>) -> Loading<Arc<[u8]>>; }
pub mod geo { pub fn geojson(name: impl Into<Name>, bytes: &[u8]) -> Result<Data>; pub struct Tiles; }
pub mod video { pub async fn record(view: &mut View, video: &Video, encoder: &mut dyn Encoder, sink: &mut impl Sink,
                                    frame: impl AsyncFnMut(f64, &mut View)) -> Result<()>; }
pub mod winit { pub fn input(event: &winit::event::WindowEvent, scale: f64) -> Option<Input>; }
```

npm `latkit` mirrors the crate; to do there: `pick`, `locate`, `image`, `geojson`, `tiles`,
`exportVideo`.

## Internals to implement

Double-buffered transitions; focus and exit lists by scan; screen index from bounds; graph job (nets,
lanes, groups, incidence); stress on the GPU, layered and orthogonal on jobs; routes; label placement;
long trace history; tile streaming; pipeline warm-up.

## Rules

- CPU per frame is O(marks), plus O(pages of changed columns) on new data, plus O(sampled row pages)
  when `at` moves. Streaming appends never lay marks out again.
- Only custom markers compile WGSL at runtime; expressions, data, and scenes never do.
- Every order the user can see comes from count → scan → write, never from atomic appends.
- Every shader passes naga at build time and Chrome at runtime (browser smoke test).
- Every wait races a deadline: GPU tests poll with a timeout, readbacks are taken, never awaited.
