# latkit

Columnar data drawn as vertices, edges, lines, and areas on the GPU. This file is the plan: the
target tree and the public API still to implement. ✓ done · ◐ partial · ○ to do.

Today a `View` draws `Vertices` and straight `Edges` from `Data` on a plane, the earth (mercator or
globe), or a plot; evaluates expressions on the GPU; plays sampled fields back at `at`; and fits the
camera from GPU bounds. `web::Canvas` and the npm package run it in a browser.

```sh
cargo xtask check   # fmt, clippy (no-default, all features, wasm32), tests, docs, TypeScript fixture
cargo xtask wasm    # latkit-js → npm/pkg, then the npm wrapper → npm/dist
```

## Tree

```
crates/latkit/
├── Cargo.toml                     ◐ features: gpu (default), serde, web · geo, video, winit ○
├── build.rs                       ✓
├── build/
│   ├── shaders.rs                 ✓ link (WESL), validate (naga), mirror structs and consts, reflect layouts
│   └── colormaps.rs               ✓ catalog → 256 texels per map
├── colormaps/                     ✓ catalog.txt, provenance.json, NOTICES.md
├── shaders/
│   ├── lib/
│   │   ├── types.wesl             ✓ every struct and constant shared with Rust
│   │   ├── bind.wesl              ✓ group 0 view, group 1 mark, group 2 pass
│   │   ├── read.wesl              ✓ columns as bits: pages, cursors, joins
│   │   ├── project.wesl           ✓ plane, plot, mercator, globe; hi/lo precision
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
│   │   ├── bounds.wesl            ◐ extents per vertex mark for fit · plot y, screen bins ○
│   │   ├── pick.wesl              ○ nearest distance, then topmost row
│   │   ├── lists.wesl             ○ focus and exit lists
│   │   ├── route.wesl             ○ edge segments: bends, nets, geodesics, parallel lanes
│   │   ├── stress.wesl            ○ stress layout, Jacobi iterations
│   │   ├── sort.wesl              ○ radix sort for label ranks
│   │   └── labels.wesl            ○ label placement: claim, decide
│   └── draw/
│       ├── backdrop.wesl          ◐ plane grid, globe disc · graticule, atmosphere, daylight ○
│       ├── vertices.wesl          ◐ markers, glow, shadow · custom marker variant ○
│       ├── edges.wesl             ◐ straight · routed segments, arrows ○
│       ├── lines.wesl             ○ tiled paths
│       ├── areas.wesl             ○ tiled fills and outlines
│       ├── traces.wesl            ○ sampled lines over a plot's axis (history)
│       ├── axes.wesl              ○ plot axes, ticks, cursor
│       └── glyphs.wesl            ○ label rasters from the atlas
├── src/
│   ├── lib.rs                     ✓ the only entry point
│   ├── error.rs                   ✓ Error with code(), Path, Step
│   ├── data/                      ✓ name, buffer, bits, text, geometry, values, column, ids, samples,
│   │                                table, data, patch, bytes, tests
│   ├── expr/                      ✓ mod, color, colormap, compile, decode
│   ├── scene/
│   │   ├── mod.rs                 ✓ Scene
│   │   ├── mark.rs                ✓ Mark, shared style, MarkKind, keys
│   │   ├── vertices.rs            ◐ position, radius, size, elevation, marker · status, ports, groups, label ○
│   │   ├── edges.rs               ◐ ends, width, dash, flow · nets, bends, routes, arrows, label ○
│   │   ├── lines.rs               ○
│   │   ├── areas.rs               ○
│   │   ├── label.rs               ○
│   │   ├── port.rs                ○ Port, Side
│   │   ├── route.rs               ○ Route, Interpolation
│   │   ├── marker.rs              ◐ shapes, block · gauge, pie, icon, wgsl ○
│   │   ├── space.rs               ◐ Earth, Plane, Plot · daylight, atmosphere, graticule, orbit, axis ticks ○
│   │   ├── theme.rs               ◐ · font, text, halo, line, area, outline colors and widths ○
│   │   ├── layout.rs              ✓ types only; layouts run in src/layout ○
│   │   └── decode.rs              ✓ JSON form; null clears an optional theme color
│   ├── gpu/
│   │   ├── mod.rs                 ◐ Gpu, Budget · set_host, stats, prepare ○
│   │   ├── arena.rs               ✓ pages, size classes, pins, LRU, frame tails, requeue on failure
│   │   ├── pipelines.rs           ✓ lazy, keyed by shader, format, samples
│   │   ├── colormaps.rs           ✓ texture array layers
│   │   ├── dictionary.rs          ✓ text codes
│   │   ├── shaders.rs             ✓ the generated contract
│   │   ├── readback.rs            ✓ copy, map on submit, take
│   │   └── atlas.rs               ○ label rasters, with eviction
│   ├── view/
│   │   ├── mod.rs                 ✓ View API
│   │   ├── camera.rs              ✓ Camera, projection, fit, ease
│   │   ├── marks.rs               ✓ Shown: program, region, offsets, dirty channels
│   │   ├── sync.rs                ✓ page tables, cursors, joins; rebuilds changed columns only
│   │   ├── program.rs             ✓ program buffer regions, written per changed mark
│   │   ├── resources.rs           ✓ grown buffers, bind groups, MSAA target
│   │   ├── uniforms.rs            ✓ frame, theme, and mark uniforms
│   │   ├── passes.rs              ✓ compute (evaluate, reduce, bounds), draw (backdrop, marks)
│   │   ├── frame.rs               ✓ render order, uploads, layout
│   │   ├── fit.rs                 ✓ GPU bounds → readback → camera
│   │   ├── input.rs               ○ Input, Key, Button, Modifiers
│   │   ├── gestures.rs            ○ pan, zoom, turn, pinch, click, double click, box, drag
│   │   ├── event.rs               ○ Event, Edit, Hit, End, Sample
│   │   ├── focus.rs               ○ selection, hover → focus words
│   │   ├── pick.rs                ○ pick, locate, hover throttling
│   │   ├── graph.rs               ○ vertex slots, ends, nets, lanes, groups, neighbors
│   │   ├── transition.rs          ○ double-buffered state, remap by id, exits
│   │   ├── index.rs               ○ screen bins from bounds (pick, labels)
│   │   ├── labels.rs              ○ placement, rasters, atlas
│   │   ├── history.rs             ○ progressive trace history
│   │   └── tiles.rs               ○ visible tiles, tile cache
│   ├── layout/                    ○ csr, stress (pivots), layered/{acyclic, rank, order, place},
│   │                                orthogonal, pack, tiling (clip, simplify, triangulate)
│   ├── host/                      ○ mod (Host, Job, TextRun, Raster), native, browser
│   ├── geo/                       ○ geojson, mvt, pmtiles, tilejson, tiles
│   ├── video/                     ○ mod (record, Video, Encoder, Sink), mp4, webm
│   ├── web.rs                     ◐ Canvas, frame loop, resize · input, events ○
│   └── winit.rs                   ○ Input from winit events
├── tests/                         ◐ render, scenes (npm fixture) ✓ · pick, input, transition, layout, geo, plot ○
├── benches/                       ○ data, frame
└── examples/                      ○ grid, plot, editor, embed (winit)
```

## Decisions

- **Picking is a compute pass**, not a pick render pass: simpler and deterministic. A custom WGSL
  marker compiles its `marker()` into a pick variant to hit exactly.
- **One view per canvas.** No panes or regions; canvases share one device cheaply.
- **Anti-aliasing is a view option** (`set_samples`), not a theme field. Fixed at 4× today.
- **No public types before they draw.** Lines, Areas, Label, and the rest stay out of `lib.rs` until
  they render; their target signatures live here.

## Public API to implement

### View

```rust
impl View {
    pub fn input(&mut self, input: &Input);
    pub fn mode(&self) -> Mode;
    pub fn set_mode(&mut self, mode: Mode);
    pub fn selection(&self) -> &[Row];
    pub fn select(&mut self, rows: impl IntoIterator<Item = Row>);
    pub fn hovered(&self) -> Option<&Hit>;
    pub fn neighbors(&self, row: &Row) -> Vec<Row>;
    pub fn fit(&mut self, fit: Fit);                           // replaces today's fit()
    pub fn set_tiles(&mut self, tiles: geo::Tiles);
    pub fn set_samples(&mut self, samples: u32);               // MSAA: 1 or 4
    pub fn pick(&self, point: [f32; 2], radius: f32) -> impl Future<Output = Result<Vec<Hit>>> + 'static;
    pub fn locate(&self, row: &Row) -> impl Future<Output = Result<Option<[f32; 2]>>> + 'static;
    pub fn image(&self, size: [u32; 2], pixel_ratio: f32, camera: &Camera) -> impl Future<Output = Result<Image>> + 'static;
    pub fn ready(&mut self) -> impl Future<Output = Result<()>> + '_;
    pub fn stats(&self) -> Stats;
}
pub enum Fit { All, Rows(Vec<Row>), Reveal(Row) }
pub enum Mode { Navigate, Inspect, Edit, Off }
pub enum Event {                                               // today: Error only
    Hover(Option<Hit>), Select(Vec<Row>), Open(Hit),
    Menu { point: [f32; 2], hits: Vec<Hit>, keyboard: bool, modifiers: Modifiers },
    Camera, Edit(Edit), Error(Error),
}
pub enum Edit { Move(Patch), Delete(Patch), Connect { from: End, to: Option<End>, replaces: Option<End>, point: [f32; 2] } }
pub struct Hit { pub row: Row, pub mark: usize, pub port: Option<Name>, pub sample: Option<Sample>, pub point: [f32; 2], pub distance: f32 }
pub struct End { pub row: Row, pub port: Option<Name> }
pub struct Sample { pub frame: u32, pub at: f64, pub value: f64 }
pub enum Input {
    Down { pointer: u32, point: [f32; 2], button: Button, modifiers: Modifiers },
    Move { pointer: u32, point: [f32; 2], modifiers: Modifiers },
    Up { pointer: u32, point: [f32; 2], modifiers: Modifiers },
    Cancel { pointer: u32 },
    Wheel { point: [f32; 2], delta: [f32; 2], modifiers: Modifiers },
    Key { key: Key, down: bool, modifiers: Modifiers },
    Leave,
}
pub enum Button { Primary, Secondary, Middle }
pub struct Modifiers { pub shift: bool, pub control: bool, pub alt: bool, pub meta: bool }
pub enum Key { Escape, Enter, Delete, Backspace, Home, Tab, Space, Plus, Minus, Left, Right, Up, Down, Other }
pub struct Image { pub size: [u32; 2], pub rgba: Arc<[u8]> }   // + png()
pub struct Stats { pub frames: u64, pub rows: u32, pub pages: u32, pub uploading: u64, pub gpu_bytes: u64 }
```

### Marks

```rust
impl Vertices {
    pub fn status(self, color: impl Into<Expr>) -> Self;
    pub fn port(self, reference: impl Into<Name>, port: impl Into<Port>) -> Self;
    pub fn contains(self, table: impl Into<Name>, reference: impl Into<Name>) -> Self;  // groups
    pub fn collapsed(self, field: impl Into<Name>) -> Self;
}
impl Edges {   // without ends, each row is a net of the vertices whose references name it
    pub fn bends(self, field: impl Into<Name>) -> Self;
    pub fn route(self, route: Route) -> Self;
    pub fn arrows(self, on: bool) -> Self;
}
pub struct Lines;   // of, path(field), samples(field), interpolation, route, width, dash, flow
pub struct Areas;   // of, rings(field), outline(Size)
// every mark: label(impl Into<Label>)
pub struct Label;   // new(text), size, color, priority, limit, spacing, max_width, wrap
pub enum Marker { Shape(Shape), Block { corner: f32 }, Gauge { fill: Expr, shape: Shape },
                  Pie { slices: Vec<Expr>, colors: Vec<Color>, hole: f32 }, Icon { images: Vec<Image>, index: Expr },
                  Wgsl(WgslMarker) }   // Marker::wgsl(source).input(name, expr) → Marker
pub struct Port { pub side: Side, pub order: Option<u32>, pub label: Option<String>, pub shape: Shape }
pub enum Side { Left, Right, Top, Bottom }
pub enum Route { Straight, Geodesic, Orthogonal }
pub enum Interpolation { Linear, StepBefore, StepAfter }
```

### Spaces and theme

```rust
pub struct Earth { /* + */ pub daylight: Daylight, pub atmosphere: Option<Color>, pub graticule: bool }
pub enum Daylight { Off, Now, At(f64) }
pub struct Axis { /* + */ pub ticks: Option<Vec<(f64, Option<String>)>>, pub format: Format, pub precision: Option<u8> }
pub enum Format { Auto, Fixed, Scientific, Engineering }
pub struct Theme { /* + */ pub text: Color, pub font: Arc<str>, pub font_size: f32, pub halo: f32,
                   pub line: Color, pub line_width: f32, pub area: Color, pub outline: Color, pub edge_spacing: f32 }
// Camera::Map gains orbit (degrees per second of bearing turn)
```

### GPU and platform

```rust
impl Gpu { pub fn set_host(&self, host: impl host::Host); pub fn stats(&self) -> GpuStats; pub fn prepare(&self, format: wgpu::TextureFormat); }
pub mod host {
    pub trait Host: Send + Sync + 'static {
        fn spawn(&self, job: Job);
        fn fetch(&self, url: &str, range: Option<Range<u64>>) -> Loading<Arc<[u8]>>;
        fn rasterize(&self, text: &TextRun) -> Loading<Raster>;
    }
    pub struct Job;     // run(self); into_bytes(self) -> (Vec<u8>, Reply); run_bytes(&[u8]) -> Vec<u8>
    pub struct TextRun { pub text: Arc<str>, pub font: Arc<str>, pub size_px: u32, pub max_width_px: Option<u32> }
    pub struct Raster { pub size: [u32; 2], pub coverage: Vec<u8>, pub baseline: f32 }
}
pub mod geo {   // feature geo
    pub fn geojson(name: impl Into<Name>, bytes: &[u8]) -> Result<Data>;
    pub struct Tiles;   // pmtiles(name, url), template(name, url), tilejson(name, url)
}
pub mod video {   // feature video
    pub async fn record(view: &mut View, video: &Video, encoder: &mut dyn Encoder, sink: &mut impl Sink,
                        frame: impl AsyncFnMut(f64, &mut View)) -> Result<()>;
    pub struct Video { pub size: [u32; 2], pub pixel_ratio: f32, pub fps: u32, pub seconds: f64, pub codec: Codec, pub bitrate: Option<u32> }
}
pub mod web { impl Canvas { pub fn on(&self, listener: impl FnMut(&Event) + 'static) -> Listener; } }   // + input
pub mod winit { pub fn input(event: &winit::event::WindowEvent, scale: f64) -> Option<Input>; }
```

### npm `latkit`

Done: errors carry `code` and `path` (`LatkitError`); scenes type-check as JSON (`ExprNode`), and
`npm/test/scenes.js` is decoded by `tests/scenes.rs`. To do: `view.on(type, listener)`, `pick`,
`locate`, `image`, `geojson`, `tiles`, `exportVideo`.

## Internals to implement

Double-buffered transitions; focus and exit lists by scan; screen index from bounds; graph job (nets,
lanes, groups, incidence); stress on the GPU, layered and orthogonal on jobs; routes; label placement
and atlas; trace history; tile streaming; pipeline warm-up. The theme's line, area, and text uniform
slots are placeholders until those marks add their fields.

## Rules

- CPU per frame is O(marks), plus O(pages of changed columns) on new data, plus O(sampled row pages)
  when `at` moves.
- Only custom markers compile WGSL at runtime; expressions, data, and scenes never do.
- Every order the user can see comes from count → scan → write, never from atomic appends.
- Every shader passes naga at build time and Chrome at runtime (browser smoke test).
- Every wait races a deadline: GPU tests poll with a timeout, readbacks are taken, never awaited.
