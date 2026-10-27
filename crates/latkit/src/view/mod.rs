//! The view. Draws a scene from its sources into any wgpu frame and handles input.

mod axes;
mod camera;
mod clock;
mod drawing;
mod ends;
mod event;
mod fit;
mod focus;
mod frame;
mod gestures;
mod graph;
mod input;
mod kept;
mod labels;
mod legends;
mod lists;
mod marks;
mod passes;
mod plan;
mod probe;
mod program;
mod query;
mod resources;
mod rig;
mod sync;
mod timer;
mod transition;
mod uniforms;
mod variants;
mod wake;
mod words;

use std::sync::Arc;
use std::task::Waker;
use std::time::Duration;

pub use camera::Camera;
pub(crate) use camera::Projected;
pub use event::{Cursor, End, Event, Fit, Hit, Phase, Sample, Stats, Trigger, Waiting};
pub use input::{Button, Device, Input, Key, Modifiers};
pub(crate) use resources::DEPTH;
#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub(crate) use variants::common;
pub(crate) use wake::Signal;

use camera::Area;
use clock::Clock;
use event::Events;
use fit::Fitting;
use focus::Focus;
use gestures::Gestures;
use marks::Shown;
use probe::Probing;
use program::Regions;
use resources::Resources;
use rig::Rig;

use crate::derive::{Derivations, Derived};
use crate::expr::compile::Deps;
use crate::scene::mark::Context;
use crate::{Error, Gpu, Name, Patch, Pending, Result, Row, Rows, Scene, Snapshot, Source, Space};

/// A frame to draw: the target texture view, its format and size, the pixel ratio, and the time.
#[derive(Clone, Copy, Debug)]
pub struct Frame<'a> {
    /// The texture view to draw into.
    pub target: &'a wgpu::TextureView,
    /// The target's format. Both sRGB and non-sRGB formats work.
    pub format: wgpu::TextureFormat,
    /// The target's width and height in physical pixels.
    pub size: [u32; 2],
    /// Physical pixels per CSS pixel.
    pub pixel_ratio: f32,
    /// Seconds on the caller's clock: an animation frame's timestamp, a video frame's time, or a
    /// test's step. Motion advances by the time since the previous frame, clamped to between 0 and
    /// 0.25 seconds, so it never jumps or runs backward.
    pub time: f64,
}

/// Draws a scene from its sources (named datasets) and handles input.
///
/// The application owns the data and the scene. The view owns the camera, the axis coordinate, the
/// selection, and the GPU state for drawing. It has no loop of its own:
/// [`render`](View::render) records a frame into an encoder the application submits, and
/// [`input`](View::input) takes the platform's pointer and key events.
///
/// ```no_run
/// # async fn example() -> latkit::Result<()> {
/// use latkit::{Data, Gpu, Ids, Plane, Scene, Table, Vertices, View, field};
/// let gpu = Gpu::new().await?;
/// let graph = Data::new("graph");
/// graph.apply(Table::new("Node", Ids::count(3)).field("x", vec![0.0, 1.0, 2.0]).field("y", vec![0.0, 1.0, 0.0]))?;
/// let nodes = Vertices::of("graph", "Node").position(field("x"), field("y"));
/// let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(nodes))?;
/// view.set_sources([&graph])?;
/// view.fit(latkit::Fit::All);
/// // The next frame draws this change: a view draws the latest version of each Data it is given.
/// graph.apply(Table::new("Node", [1_u64]).field("y", vec![2.0]))?;
/// # Ok(()) }
/// ```
pub struct View {
    gpu: Gpu,
    /// This view's id among the GPU's views. The GPU's ledger keys budget shares by it.
    id: u64,
    scene: Scene,
    /// Incremented whenever the scene changes.
    scene_version: u64,
    /// The sources the application gave, each a named dataset.
    sources: Vec<Source>,
    /// The version of each dataset the view draws, sorted by name: a given snapshot, the latest
    /// version of a `Data` as of the last refresh, or the tiles loaded so far.
    snapshots: Vec<Snapshot>,
    /// The parts of each paged table the camera chose to draw this frame.
    choices: crate::derive::tiled::Choices,
    /// Each paged table's drawing, by dataset and table.
    drawings: crate::data::Keyed<(Name, Name), drawing::Drawn>,
    /// The marks' rebuilt tables, per dataset. They replace the current tables once their pages
    /// arrive.
    staged: crate::data::Keyed<Name, sync::Staged>,
    /// Whether this frame's pages fit in the arena, and if not, how the next frame makes space.
    room: frame::Room,
    /// Set once the view has reported that its data exceeds the GPU budget. Until a new data
    /// version publishes, a full arena and a due fit (with nothing drawn to measure) stop
    /// requesting frames.
    limited: bool,
    /// Tables derived from the data and the scene, row for row with the drawn tables. Marks read
    /// them like data.
    derived: Derivations,
    marks: Vec<Shown>,
    camera: Camera,
    rig: Rig,
    /// CSS pixels kept clear at the top, right, bottom, and left.
    insets: [f32; 4],
    /// The space a plot's axes take around the plot area, and the stamp of the scene and pixel
    /// ratio it was measured for.
    gutters: (u64, axes::Gutters),
    fitting: Fitting,
    /// The value range fitted to the traces, shown when the plot camera sets none.
    plot_y: Option<[f64; 2]>,
    at: f64,
    clock: Clock,
    effect_time: f64,
    events: Events,
    /// The signal that finished work wakes, and a waker for it. Readbacks, jobs, and fetches keep
    /// clones of the waker.
    signal: Arc<wake::Signal>,
    waker: Waker,
    resources: Option<Resources>,
    /// Each mark's word range in the program buffer.
    regions: Regions,
    /// Something visible changed since the last frame.
    changed: bool,
    /// Whether the device loss has been reported.
    told_lost: bool,
    /// The pending work the last frame showed placeholders for.
    waiting: Waiting,
    /// The pipelines requested for each target the frames draw into.
    asked: Vec<variants::Asking>,
    /// While the draw pipelines compile, how many compiles had finished at the last check. The view
    /// draws nothing new until they all finish, and sleeps until the next one finishes.
    compiling: Option<u64>,
    /// The same, while the pipelines for lit rows, probes, and queries compile. Meanwhile frames
    /// draw without lit rows, and probes and queries wait.
    answering: Option<u64>,
    /// The same, while the text pipelines compile. Meanwhile frames draw without labels, glyphs,
    /// and the overlay.
    texting: Option<u64>,
    /// Callers waiting for the arrangement in progress.
    arranging: Vec<crate::Resolver<Vec<Patch>>>,
    /// Whether the platform requests reduced motion, which `Motion::System` follows.
    reduced_motion: bool,
    /// The stamp of the inputs the face normals were last summed from.
    normals: Derived<()>,
    /// Measures the GPU time of frames, where the device supports it.
    timer: Option<timer::Timer>,
    focus: Focus,
    probing: Probing,
    queries: query::Queries,
    /// The number of words the marks' segment lists use at the start of the lists buffer.
    list_words: u32,
    labels: labels::Labels,
    gestures: Gestures,
    /// The pointer over the view: its point, pressed modifier keys, and device. `None` once it
    /// leaves.
    pointer: Option<Trigger>,
    /// The size of the last frame in CSS pixels, and its pixel ratio.
    size: [f64; 2],
    pixel_ratio: f32,
    /// How each table draws within the view's budget share, and the costs the plan used.
    planning: plan::Planning,
    /// The most pixel columns a trace may span, set by the plan.
    trace_columns: u32,
    stats: Stats,
}

/// The number of views created, used to give each view its id.
static VIEWS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl View {
    /// Creates a view that draws `scene` with `gpu`. Its marks draw nothing until
    /// [`set_sources`](View::set_sources) provides their datasets. Errors if the scene is invalid.
    pub fn new(gpu: &Gpu, scene: Scene) -> Result<View> {
        scene.check()?;
        let camera = Camera::default_for(&scene.space);
        let signal = Arc::new(wake::Signal::default());
        let mut view = View {
            gpu: gpu.clone(),
            id: VIEWS.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            scene: Scene::new(scene.space.clone()),
            scene_version: 0,
            sources: Vec::new(),
            snapshots: Vec::new(),
            choices: crate::derive::tiled::Choices::default(),
            drawings: crate::data::Keyed::default(),
            staged: crate::data::Keyed::default(),
            room: frame::Room::Found,
            limited: false,
            derived: Derivations::default(),
            marks: Vec::new(),
            camera,
            rig: Rig::default(),
            insets: [0.0; 4],
            gutters: (0, axes::Gutters::default()),
            fitting: Fitting::default(),
            plot_y: None,
            at: f64::INFINITY,
            clock: Clock::default(),
            effect_time: f64::NAN,
            events: Events::default(),
            waker: Waker::from(signal.clone()),
            signal,
            resources: None,
            regions: Regions::default(),
            changed: true,
            told_lost: false,
            waiting: Waiting::default(),
            asked: Vec::new(),
            compiling: None,
            answering: None,
            texting: None,
            arranging: Vec::new(),
            reduced_motion: false,
            normals: Derived::default(),
            timer: timer::Timer::new(&gpu.0.device, &gpu.0.queue),
            focus: Focus::default(),
            probing: Probing::default(),
            queries: query::Queries::default(),
            list_words: 0,
            labels: labels::Labels::default(),
            gestures: Gestures::default(),
            pointer: None,
            size: [0.0; 2],
            pixel_ratio: 1.0,
            planning: plan::Planning::default(),
            trace_columns: u32::MAX,
            stats: Stats::default(),
        };
        view.set_scene(scene)?;
        // Queue the pipelines nearly every scene uses, so later views find them compiled. They
        // compile once this view's draw pipelines are ready.
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        gpu.warm();
        // Until its first frame, the view reports all the work that frame would wait on.
        view.waiting = view.under_way();
        Ok(view)
    }

    /// The scene the view draws.
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Replaces the scene, compiling its marks against the latest version of each
    /// [`Data`](crate::Data) source. A mark that matches a current mark by kind, data, table, and
    /// name keeps its state and eases to its new options. Errors if the scene is invalid or a mark
    /// fails to compile, and the current scene stays.
    pub fn set_scene(&mut self, scene: Scene) -> Result<()> {
        scene.check()?;
        let gpu = self.gpu.clone();
        let mut inner = gpu.0.lock();
        self.refresh(&mut inner);
        // Every mark recompiles if the theme, the kind of space, or the presence of a layout
        // changed.
        let kind_changed = std::mem::discriminant(&scene.space) != std::mem::discriminant(&self.scene.space);
        let context_changed = scene.theme != self.scene.theme
            || kind_changed
            || matches!(scene.layout, crate::Layout::None) != matches!(self.scene.layout, crate::Layout::None);
        let context = Context { theme: &scene.theme, space: &scene.space, layout: &scene.layout };
        // Compile every new or changed mark before changing anything.
        let mut fresh = Vec::with_capacity(scene.marks.len());
        for (i, mark) in scene.marks.iter().enumerate() {
            let kept = !context_changed && self.marks.iter().any(|s| s.mark.draws_like(mark));
            if kept {
                fresh.push(None);
                continue;
            }
            let mut shown = Shown::new(mark.clone());
            shown.compile(&self.snapshots, context, &mut inner).map_err(|e| e.at(i).at("marks"))?;
            fresh.push(Some(shown));
        }
        let mut old: Vec<Option<Shown>> = std::mem::take(&mut self.marks).into_iter().map(Some).collect();
        let easing = !scene.ease.is_zero() && self.moves_with(&scene.controls);
        self.marks = scene
            .marks
            .iter()
            .zip(fresh)
            .map(|(mark, fresh)| {
                let Some(mut shown) = fresh else {
                    let mut kept = old
                        .iter_mut()
                        .find(|s| s.as_ref().is_some_and(|s| s.mark.draws_like(mark)))
                        .and_then(Option::take)
                        .expect("the unchanged mark's previous state");
                    kept.mark = mark.clone();
                    return kept;
                };
                // A changed mark takes over the rows of the old mark with its key, and eases from
                // them.
                let before = old.iter_mut().find(|s| s.as_ref().is_some_and(|s| s.key == shown.key));
                if let Some(mut before) = before.and_then(Option::take) {
                    before.tables.release(&mut inner);
                    shown.inherit(&mut before);
                    if easing && shown.compiled.is_some() {
                        shown.begin(None);
                    }
                }
                shown
            })
            .collect();
        for mut dropped in old.into_iter().flatten() {
            dropped.release(&mut inner);
        }
        // Mark indices may have changed, so staged tables are dropped and rebuilt.
        for (_, staged) in std::mem::take(&mut self.staged) {
            staged.release(&mut inner);
        }
        for shown in self.marks.iter_mut().filter(|s| s.failure.is_none()) {
            shown.failure = absent(shown, &self.snapshots, &self.derived.tiles).map(|error| (error, false));
        }
        drop(inner);
        if !self.camera.fits(&scene.space) {
            self.camera = Camera::default_for(&scene.space);
            self.plot_y = None;
        }
        // Fit bounds and running motion refer to the old space's positions, so they do not carry
        // over to another kind of space. The next frame places the camera within the new space's
        // zoom and pan limits.
        if kind_changed {
            self.rig.bounds = None;
            self.rig.hold();
        }
        if matches!(scene.space, Space::Diagram(_)) {
            self.rig.orbit = 0.0;
        }
        self.scene = scene;
        self.scene_version += 1;
        // Request the new scene's pipelines again. They compile while its data syncs and its sheet
        // is arranged. Pipelines shared with the old scene are already compiled.
        self.asked.clear();
        self.compiling = None;
        self.answering = None;
        self.texting = None;
        // If the GPU's sample count is known, start compiling now. Otherwise the first frame asks.
        if let Some(samples) = gpu.samples() {
            self.ask(&mut gpu.0.lock(), (crate::gpu::FORMAT, samples), true);
        }
        self.focus.dirty = true;
        self.gestures.keys.stale();
        self.invalidate();
        Ok(())
    }

    /// Replaces the view's sources, each a named dataset. A [`Data`](crate::Data) draws its latest
    /// version, starting the frame after each patch applies. A [`Snapshot`] draws as given.
    /// [`Tiles`](crate::Tiles) loads the pieces in view.
    ///
    /// This is cheap: unchanged pages are shared and only changed fields evaluate again. A mark
    /// whose dataset no longer fits it draws nothing, and the next frame reports why unless a new
    /// scene replaces that mark first. So the sources and the scene can be set in either order.
    /// Errors if two sources share a name.
    pub fn set_sources<S: Into<Source>>(&mut self, sources: impl IntoIterator<Item = S>) -> Result<()> {
        let sources: Vec<Source> = sources.into_iter().map(Into::into).collect();
        for (i, source) in sources.iter().enumerate() {
            if sources[..i].iter().any(|other| other.name() == source.name()) {
                return Err(Error::invalid(format!("two sources named '{}'", source.name())).at(i).at("sources"));
            }
        }
        let gpu = self.gpu.clone();
        let mut inner = gpu.0.lock();
        // Forget datasets no source provides any more, and those whose source switched to or from
        // tiles: the view draws the new source from scratch.
        let tiled = |source: &Source| matches!(source, Source::Tiles(_));
        let gone: Vec<Name> = self
            .sources
            .iter()
            .filter(|old| !sources.iter().any(|new| new.name() == old.name() && tiled(new) == tiled(old)))
            .map(|old| old.name().clone())
            .collect();
        let forgot = !gone.is_empty();
        for name in gone {
            self.forget(&name, &mut inner);
        }
        for old in &self.sources {
            if let Source::Data(data) = old {
                data.watchers().unwatch(self.id);
            }
        }
        for source in &sources {
            match source {
                Source::Data(data) => {
                    data.watchers().watch(self.id, &self.waker);
                    self.take_newer(data.snapshot(), &mut inner);
                }
                Source::Snapshot(snapshot) => self.take_newer(snapshot.clone(), &mut inner),
                Source::Tiles(tiles) => self.derived.tiles.set(tiles.clone(), &mut inner.tiles),
            }
        }
        self.sources = sources;
        drop(inner);
        // Marks that lost their tables need the program laid out again.
        if forgot {
            self.invalidate();
        } else {
            self.wake();
        }
        Ok(())
    }

    /// The sources the view draws.
    pub fn sources(&self) -> &[Source] {
        &self.sources
    }

    /// The version of dataset `name` the view draws: the latest version it took of a
    /// [`Data`](crate::Data), a given snapshot, or the pieces of [`Tiles`](crate::Tiles) loaded for
    /// its camera. `None` if the view has no such dataset.
    pub fn snapshot(&self, name: &str) -> Option<&Snapshot> {
        let i = self.snapshots.binary_search_by(|s| s.name().as_str().cmp(name)).ok()?;
        Some(&self.snapshots[i])
    }

    /// Updates every source before the frame reads it: the tiles the camera and the plot window
    /// need, the pieces that arrived for them, and the latest version of each changed `Data`. A
    /// frame compiles marks, requests pipelines, derives, and draws from one version of each
    /// dataset, so no pipeline reads a field added after the pipeline was requested. While a shot
    /// keeps the view's data unchanged, `Data` sources stay at the versions taken when it began,
    /// but tiles still arrive.
    fn refresh(&mut self, inner: &mut crate::gpu::Inner) {
        self.update_tiles(inner);
        for data in self.derived.tiles.take_changed() {
            self.take_data(data, inner);
        }
        if self.signal.holding() {
            return;
        }
        for i in 0..self.sources.len() {
            let Source::Data(data) = &self.sources[i] else { continue };
            let now = data.snapshot();
            self.take_newer(now, inner);
        }
    }

    /// Takes `snapshot` unless the view draws that version already.
    fn take_newer(&mut self, snapshot: Snapshot, inner: &mut crate::gpu::Inner) {
        if self.snapshot(snapshot.name()).is_none_or(|drawn| drawn.version() != snapshot.version()) {
            self.take_data(snapshot, inner);
        }
    }

    /// Takes a new version of a dataset, with the GPU's state locked. Marks whose schema it changed
    /// recompile. A mark that fails keeps its error until the data fits it again, and the next
    /// frame reports the error. A caller outside a frame requests a frame to draw the data.
    fn take_data(&mut self, data: Snapshot, inner: &mut crate::gpu::Inner) {
        let at = match self.snapshots.binary_search_by(|d| d.name().cmp(data.name())) {
            Ok(i) => {
                self.snapshots[i] = data;
                i
            }
            Err(i) => {
                self.snapshots.insert(i, data);
                i
            }
        };
        let context = Context { theme: &self.scene.theme, space: &self.scene.space, layout: &self.scene.layout };
        for (i, shown) in self.marks.iter_mut().enumerate() {
            if shown.stale(&self.snapshots[at]) {
                if let Some(staged) = self.staged.get_mut(&shown.mark.style().data) {
                    staged.forget(i, inner);
                }
                let failed = shown.compile(&self.snapshots, context, inner).err();
                let failed = failed.or_else(|| absent(shown, &self.snapshots, &self.derived.tiles));
                shown.failure = failed.map(|error| (error, false));
            }
        }
        // Rows may have moved under the focus and the keyboard-stepped hover.
        self.focus.dirty = true;
        self.gestures.keys.stale();
        self.fitting.plot_due = true;
    }

    /// Stops drawing dataset `name` until a source provides it again, and releases the GPU tables
    /// its marks use.
    fn forget(&mut self, name: &str, inner: &mut crate::gpu::Inner) {
        self.derived.tiles.remove(name, &mut inner.tiles);
        self.snapshots.retain(|d| d.name() != name);
        self.drawings.retain(|key, _| key.0 != name);
        for (i, shown) in self.marks.iter_mut().enumerate() {
            if shown.mark.style().data == *name {
                shown.failure = None;
            }
            if shown.compiled.as_ref().is_some_and(|c| c.schemas.iter().any(|(n, _)| n == name)) {
                if let Some(staged) = self.staged.get_mut(&shown.mark.style().data) {
                    staged.forget(i, inner);
                }
                shown.tables.release(inner);
                shown.compiled = None;
                shown.rows = 0;
                shown.exits = 0;
                shown.holding = None;
            }
        }
    }

    /// The axis coordinate shown. Every sampled field shows its last frame at or before it.
    pub fn at(&self) -> f64 {
        self.at
    }

    /// Shows axis coordinate `at`. Only options that read sampled fields evaluate again.
    pub fn set_at(&mut self, at: f64) {
        if at.to_bits() != self.at.to_bits() {
            self.at = at;
            self.wake();
        }
    }

    /// The view's camera.
    pub fn camera(&self) -> &Camera {
        &self.camera
    }

    /// Moves to `camera` at once, stopping any flight or coasting. Like every setter, it emits no
    /// event. Ignored unless `camera` [fits](Camera::fits) the scene's space.
    ///
    /// Every camera move stays within the camera's zoom and pan limits. On the earth, the limits
    /// are those [`Earth`](crate::Earth) describes, for the part of the view inside the
    /// [`insets`](View::insets). After a fit, the camera zooms at most 3 levels out and 8 in from
    /// the fit, and its center stays within one box size of the box the fit framed. The view learns
    /// its size from its first frame. When its size, insets, or space change, the next frame moves
    /// the camera back within the limits and emits a [`Camera`](Event::Camera) event.
    pub fn set_camera(&mut self, camera: Camera) {
        if camera.fits(&self.scene.space) {
            self.rig.hold();
            self.place_camera(camera);
        }
    }

    /// Sets whether the platform requests reduced motion, like a browser's
    /// `prefers-reduced-motion`. `Motion::System` follows it. A canvas sets it automatically.
    pub fn set_reduced_motion(&mut self, reduced: bool) {
        if reduced != self.reduced_motion {
            self.reduced_motion = reduced;
            self.wake();
        }
    }

    /// Whether motion is enabled, so the view animates on its own: eases, flights, coasting,
    /// orbits, comets, and expressions that read `elapsed()`.
    pub(super) fn moves(&self) -> bool {
        self.moves_with(&self.scene.controls)
    }

    fn moves_with(&self, controls: &crate::Controls) -> bool {
        match controls.motion {
            crate::Motion::Full => true,
            crate::Motion::Reduced => false,
            crate::Motion::System => !self.reduced_motion,
        }
    }

    /// How long changes ease: the scene's ease, or zero when motion is disabled.
    pub(super) fn ease(&self) -> Duration {
        if self.moves() { self.scene.ease } else { Duration::ZERO }
    }

    /// Eases to `camera` over twice the scene's ease, on the view's clock. The target stays within
    /// the zoom and pan limits [`set_camera`](View::set_camera) describes. Ignored unless `camera`
    /// [fits](Camera::fits) the scene's space.
    pub fn fly(&mut self, camera: Camera) {
        if camera.fits(&self.scene.space) {
            let seconds = (self.ease().max(Duration::from_millis(1)) * 2).as_secs_f64();
            let to = camera.within(&self.reach());
            self.rig.fly(self.camera, to, self.clock.now(), seconds);
            self.wake();
        }
    }

    /// The screen point of `position` (x, y, and elevation), in CSS pixels from the top left.
    /// `None` behind the camera. Use it to anchor overlays to what the view draws.
    pub fn screen(&self, position: [f64; 3]) -> Option<[f32; 2]> {
        let view = self.projected();
        view.screen(view.world(position)).map(|s| [s[0] as f32, s[1] as f32])
    }

    /// The ground position under screen point `point` (CSS pixels from the top left). On a plane
    /// it is the point at elevation 0, on the earth the point on the map or globe, and on a plot
    /// the values there. `None` where the point misses the ground.
    pub fn position(&self, point: [f32; 2]) -> Option<[f64; 3]> {
        let view = self.projected();
        view.ground(point.map(f64::from)).map(|w| view.position(w))
    }

    /// Runs the scene's layout again on every vertex row without a position: a diagram's blocks, or
    /// the points on a plane or the earth. Without this call, laid-out positions persist and rows
    /// added later are placed around them.
    ///
    /// Once the layout finishes, resolves to one patch per dataset. Each patch writes the laid-out
    /// positions into the mark's position fields (or its point `geometry`). Applying the patches
    /// makes the positions part of the data. Marks whose position is not a pair of fields are
    /// skipped.
    pub fn arrange(&mut self) -> Pending<Vec<Patch>> {
        let (pending, resolver) = Pending::new();
        self.arranging.push(resolver);
        self.derived.arrange(matches!(self.scene.space, Space::Diagram(_)));
        self.wake();
        pending
    }

    /// Resolves the pending `arrange` calls once their layout has finished.
    fn answer_arranging(&mut self) {
        let Some(placed) = self.derived.take_arranged() else { return };
        let patches = arranged(&self.scene, placed);
        for resolver in self.arranging.drain(..) {
            resolver.resolve(Ok(patches.clone()));
        }
    }

    /// Frames what `fit` names on the next frame, keeping pitch and bearing.
    pub fn fit(&mut self, fit: Fit) {
        self.focus.fitting = match &fit {
            Fit::Rows(rows) => Rows::flatten(rows.iter().cloned()),
            Fit::Reveal(row) => vec![row.clone()],
            _ => Vec::new(),
        };
        self.focus.dirty = true;
        self.fitting.wanted = Some(fit);
        self.wake();
    }

    /// CSS pixels kept clear at the top, right, bottom, and left, for panels that cover part of the
    /// view. The camera centers and fits within the rest.
    pub fn insets(&self) -> [f32; 4] {
        self.insets
    }

    /// Sets the [`insets`](View::insets).
    pub fn set_insets(&mut self, insets: [f32; 4]) {
        if insets != self.insets {
            self.insets = insets;
            self.wake();
        }
    }

    /// The orbit speed: degrees of bearing per second that a map or plane turns about its center.
    pub fn orbit(&self) -> f64 {
        self.rig.orbit
    }

    /// Turns the camera about its center at `degrees_per_second`. Zero stops it. A diagram never
    /// turns.
    pub fn set_orbit(&mut self, degrees_per_second: f64) {
        let turns = degrees_per_second.is_finite() && !matches!(self.scene.space, Space::Diagram(_));
        self.rig.orbit = if turns { degrees_per_second } else { 0.0 };
        self.wake();
    }

    /// The selected rows, one set per table, in the order each table was first selected.
    pub fn selection(&self) -> Vec<Rows> {
        Rows::group(self.focus.selection.iter().cloned())
    }

    /// Selects exactly `rows`, without emitting an event. Rows that the data drops, or that no
    /// pickable mark shows, later leave the selection with a [`Selection`](Event::Selection) event
    /// that has no trigger.
    pub fn set_selection(&mut self, rows: impl IntoIterator<Item = Rows>) {
        let rows = Rows::flatten(rows);
        if rows != self.focus.selection {
            self.focus.selection = rows;
            self.focus.dirty = true;
            self.wake();
        }
    }

    /// The hovered row: the row under the pointer, or the row the keyboard stepped to.
    pub fn hovered(&self) -> Option<&Hit> {
        self.focus.hovered.as_ref()
    }

    /// An error for every mark that draws nothing because its data no longer fits it.
    pub fn failures(&self) -> impl Iterator<Item = crate::Error> + '_ {
        self.marks.iter().enumerate().filter_map(|(i, shown)| Some(shown.failure.as_ref()?.0.clone().at(i).at("marks")))
    }

    /// The cursor the view requests for what is under the pointer.
    pub fn cursor(&self) -> Cursor {
        self.gestures.cursor(self.probing.hovered(), &self.scene)
    }

    /// Counters of the view's work and its last frame.
    pub fn stats(&self) -> Stats {
        let rows = |m: &Shown| {
            let style = m.mark.style();
            self.snapshot(&style.data).and_then(|d| d.table(&style.table)).map_or(0, |t| t.len() as u64)
        };
        let [tiles, tiles_loading] = self.derived.tiles.counts(&self.gpu.0.lock().tiles);
        Stats {
            rows: self.marks.iter().map(rows).sum(),
            drawn: self.marks.iter().map(|m| u64::from(m.steady_rows())).sum(),
            tiles,
            tiles_loading,
            ..self.stats
        }
    }

    /// Whether the last frame drew everything the data, scene, and camera describe, with no
    /// placeholder for pending work. A frame is incomplete while a pipeline it draws with compiles,
    /// a changed page waits to upload, a tile shows its ancestor, a large table shows an even
    /// sample of its rows, a row keeps its old position until a layout arrives, a wire shows an
    /// elbow until its route arrives, an area shows its previous triangles, a label shows its
    /// estimated size, or a fit is due. Shots and videos wait until it is true.
    /// [`waiting`](View::waiting) lists what is pending.
    pub fn complete(&self) -> bool {
        self.waiting.is_empty()
    }

    /// The kinds of pending work the last frame showed placeholders for. Empty once the view is
    /// [complete](View::complete). [`Waiting`](Event::Waiting) events report changes to it.
    pub fn waiting(&self) -> Waiting {
        self.waiting
    }

    /// The events since the last call, in order. See [`Event`]. An intent that needs a pick result
    /// waits until the pick finishes, and later intents wait behind it.
    pub fn events(&mut self) -> impl Iterator<Item = Event> + use<> {
        self.events.drain()
    }

    /// Sets the waker called when the view needs a frame on its own: when pending work arrives, or
    /// the data or the camera changes.
    pub fn set_waker(&mut self, waker: Waker) {
        self.signal.set_waker(waker);
    }

    /// The view's wake signal. A shot drawing the view waits on it.
    pub(crate) fn signal(&self) -> &Arc<wake::Signal> {
        &self.signal
    }

    /// Whether a [`Shot`](crate::Shot) or a [`Video`](crate::Video) is drawing the view. Nothing
    /// else should draw it meanwhile, since a view draws at one size at a time. A canvas or window
    /// keeps showing its last frame.
    pub fn lent(&self) -> bool {
        self.signal.lent()
    }

    /// The GPU the view draws with.
    pub(crate) fn gpu(&self) -> &Gpu {
        &self.gpu
    }

    /// The error a shot or video fails with: the first error not yet taken from the events. It
    /// stays queued for the view's owner.
    pub(crate) fn shot_error(&mut self) -> Option<crate::Error> {
        self.tell_gpu_errors();
        self.events.error().cloned()
    }

    /// Whether the view can draw frames into `format` at `pixel_ratio` now, because the scene's
    /// draw pipelines for that target are compiled.
    ///
    /// The first call for a target requests every pipeline the scene uses, draw pipelines first. In
    /// a browser they compile in parallel off the GPU thread, and each one that finishes wakes the
    /// view. Until the draw pipelines are ready, the view draws nothing new, so a canvas keeps
    /// showing the last frame. Until the rest are ready, frames omit text and lit rows, and probes
    /// and queries wait. Natively the view can always draw. [`render`](View::render) checks this
    /// itself and records nothing until it is true.
    pub fn ready(&mut self, format: wgpu::TextureFormat, pixel_ratio: f32) -> bool {
        self.ready_for(format, pixel_ratio, true)
    }

    /// Like [`ready`](View::ready), for frames that take `input` or not. It refreshes the sources
    /// first, so the pipelines a newly added field needs are requested before a frame reads it.
    pub(crate) fn ready_for(&mut self, format: wgpu::TextureFormat, pixel_ratio: f32, input: bool) -> bool {
        let gpu = self.gpu.clone();
        let samples = gpu.samples_for(pixel_ratio);
        let mut inner = gpu.0.lock();
        self.refresh(&mut inner);
        let draws = self.pipelines_ready(&mut inner, format, samples, input);
        let answers = self.answers_ready(&inner);
        let texts = self.texts_ready(&inner);
        let landed = inner.pipelines.landed();
        drop(inner);
        self.compiling = (!draws).then_some(landed);
        self.answering = (!answers).then_some(landed);
        self.texting = (!texts).then_some(landed);
        let compiling = self.compiling.is_some() || self.answering.is_some() || self.texting.is_some();
        if self.waiting.compiling != compiling {
            self.waiting.compiling = compiling;
            self.events.tell(Event::Waiting(self.waiting));
        }
        draws
    }

    /// Whether probes and queries can run: the probe, query, and lit-row pipelines are compiled.
    fn answers(&self) -> bool {
        self.answering.is_none()
    }

    /// Whether frames draw text: the label, glyph, and overlay pipelines are compiled.
    fn texts(&self) -> bool {
        self.texting.is_none()
    }

    /// Whether the draw pipelines are still compiling. The view draws nothing new until they have
    /// all finished.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) fn compiling(&self) -> bool {
        self.compiling.is_some()
    }

    /// Whether a new frame would differ from the last one: something changed, animates, or streams
    /// in, or pending work arrived. While the view only waits, it needs no frame. The work it waits
    /// on wakes it.
    pub fn needs_render(&self) -> bool {
        let landed = || self.gpu.0.lock().pipelines.landed();
        // While draw pipelines compile, the view draws nothing new. Each finished compile wakes it.
        if let Some(seen) = self.compiling {
            return landed() != seen;
        }
        // Self-driven motion counts only while motion is enabled: under reduced motion, orbits,
        // comets, and `elapsed()` hold still.
        let moves = self.moves();
        self.changed
            || self.signal.landed()
            || self.derived.tiles.pending()
            || self.rig.easing()
            || (self.rig.orbit != 0.0 && moves)
            || (self.fitting.due() && !self.limited)
            // Probes and queries wait for their pipelines, which wake the view as they compile.
            || (self.answers() && (self.probing.due() || self.queries.due()))
            || self.answering.is_some_and(|seen| landed() != seen)
            || self.texting.is_some_and(|seen| landed() != seen)
            || self.fading()
            // A mark evaluates once its columns are synced. Until then, the pages they wait for
            // wake the view.
            || self.marks.iter().any(|m| (m.drawable() && (m.dirty != 0 || m.reduce)) || m.begin.is_some() || m.transition.is_some())
            || (moves && self.marks.iter().any(|m| m.compiled.as_ref().is_some_and(|c| c.program.reads().intersects(Deps::TIME))))
            || (moves && self.flowing())
            || self.gpu.0.lock().arena.uploading()
            || self.room != frame::Room::Found
    }

    /// Whether the view wants a frame: one that would differ
    /// ([`needs_render`](View::needs_render)), or one that only checks whether a touch has been
    /// pressed long enough to open a menu. A loop that draws on demand, like a canvas, draws while
    /// this is true. A video repeats its last frame rather than draw frames that only check.
    pub fn wants_frame(&self) -> bool {
        self.needs_render() || (self.compiling.is_none() && self.holding())
    }

    /// Whether comets travel along some mark's rows: a flowing mark is drawable, and the theme's
    /// flow color is visible.
    fn flowing(&self) -> bool {
        self.scene.theme.flow.color.a > 0.0 && self.marks.iter().any(|m| m.drawable() && m.mark.flows())
    }

    /// Whether this frame left work for the next one (taking `input` or not): pages over the
    /// frame's upload budget, pages that did not fit in the arena, a due fit, probe, or query, tile
    /// pieces to take, or a transition to begin. Nothing else would wake the view for these. Jobs,
    /// texts, fetches, and readbacks wake it themselves when they arrive.
    fn due(&self, input: bool) -> bool {
        self.gpu.0.lock().arena.uploading()
            || self.room != frame::Room::Found
            || (self.fitting.due() && !self.limited)
            || (input && self.answers() && (self.probing.due() || self.queries.due()))
            || self.derived.tiles.pending()
            || self.marks.iter().any(|m| m.begin.is_some())
    }

    fn wake(&mut self) {
        self.changed = true;
        self.signal.ask();
    }

    /// The pending work a frame drawn now would show placeholders for. See
    /// [`complete`](View::complete). A mark waits for its dataset until a source provides it. A
    /// mark that failed, or whose dataset comes from tiles (which may never contain its table),
    /// waits for nothing.
    fn under_way(&self) -> Waiting {
        let marks = || self.marks.iter().filter(|m| m.compiled.is_some());
        let given = |m: &Shown| {
            let data = &m.mark.style().data;
            m.compiled.is_some()
                || m.failure.is_some()
                || self.snapshot(data).is_some()
                || self.derived.tiles.owns(data)
        };
        Waiting {
            compiling: self.asked.is_empty()
                || self.compiling.is_some()
                || self.answering.is_some()
                || self.texting.is_some(),
            data: !self.marks.iter().all(given)
                || marks().any(|m| !m.tables.synced())
                || self.staged.values().any(|s| !s.is_empty()),
            derived: !self.derived.complete(),
            labels: !self.labels.complete(),
            fit: self.fitting.due() || self.fitting.reading(),
            marks: marks().any(|m| m.counting() || m.begin.is_some()),
        }
    }

    /// Whether something is easing to rest: a transition, a flight, coasting, or a tile fade.
    /// Orbits, comets, and other continuous motion never settle and do not count.
    pub(crate) fn easing(&self) -> bool {
        self.rig.easing() || self.fading() || self.marks.iter().any(|m| m.begin.is_some() || m.transition.is_some())
    }

    /// Whether tiles of a paged table are fading in or out.
    fn fading(&self) -> bool {
        self.drawings.values().any(|d| d.current.as_ref().is_some_and(|c| c.fades))
    }

    fn invalidate(&mut self) {
        self.regions.relayout = true;
        self.fitting.plot_due = true;
        self.wake();
    }

    /// The part of the view the camera frames, in CSS pixels: inside the insets, and on a plot
    /// inside its axes. At least one pixel each way.
    fn area(&self) -> Area {
        let [w, h] = self.size;
        let [top, right, bottom, left] = self.insets.map(f64::from);
        let mut area = [left, top, w - right, h - bottom];
        if matches!(self.scene.space, Space::Plot(_)) {
            // A plot's axes start below its title, which the other spaces draw over.
            let [top, right, bottom, left] = self.gutters.1.room;
            area = [area[0] + left, area[1] + self.title_band() + top, area[2] - right, area[3] - bottom];
        }
        if area[2] - area[0] < 1.0 {
            area[2] = area[0] + 1.0;
        }
        if area[3] - area[1] < 1.0 {
            area[3] = area[1] + 1.0;
        }
        area
    }

    /// The camera the frame draws through: a plot without a value range shows the fitted one.
    fn drawn_camera(&self) -> Camera {
        match self.camera {
            Camera::Plot { x, y: None } => Camera::Plot { x, y: Some(self.plot_y.unwrap_or([0.0, 1.0])) },
            camera => camera,
        }
    }

    fn projected(&self) -> Projected {
        self.projected_with(&self.drawn_camera())
    }

    /// The projection through `camera`. A plot camera without a value range uses the fitted one,
    /// as the frame does.
    fn projected_with(&self, camera: &Camera) -> Projected {
        let camera = match *camera {
            Camera::Plot { x, y: None } => Camera::Plot { x, y: Some(self.plot_y.unwrap_or([0.0, 1.0])) },
            camera => camera,
        };
        let space = &self.scene.space;
        Projected::new(space, &camera, self.size, self.area(), Projected::globe_of(space))
    }
}

impl Drop for View {
    fn drop(&mut self) {
        let gpu = self.gpu.clone();
        let mut inner = gpu.0.lock();
        for shown in &mut self.marks {
            shown.release(&mut inner);
        }
        for (_, staged) in std::mem::take(&mut self.staged) {
            staged.release(&mut inner);
        }
        self.derived.tiles.release(&mut inner.tiles);
        inner.ledger.leave(self.id);
        drop(inner);
        for source in &self.sources {
            if let Source::Data(data) = source {
                data.watchers().unwatch(self.id);
            }
        }
    }
}

impl std::fmt::Debug for View {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("View")
            .field("scene", &self.scene)
            .field("camera", &self.camera)
            .field("at", &self.at)
            .finish_non_exhaustive()
    }
}

/// One patch per dataset that writes each laid-out row's position into the position fields of the
/// vertex mark drawing its table, or into its point geometry.
fn arranged(scene: &Scene, placed: Vec<(Row, [f64; 2])>) -> Vec<Patch> {
    /// A table's laid-out rows: its dataset and table names, the row ids, and their positions.
    type Laid = ((Name, Name), Vec<crate::Id>, Vec<[f64; 2]>);
    let mut tables: Vec<Laid> = Vec::new();
    for (row, place) in placed {
        let key = (row.data, row.table);
        match tables.iter_mut().find(|(k, ..)| *k == key) {
            Some((_, ids, places)) => {
                ids.push(row.id);
                places.push(place);
            }
            None => tables.push((key, vec![row.id], vec![place])),
        }
    }
    let mut patches: Vec<Patch> = Vec::new();
    for ((data, table), ids, places) in tables {
        let mark = scene.marks.iter().find_map(|m| match m {
            crate::Mark::Vertices(v) if v.style.data == data && v.style.table == table => Some(v),
            _ => None,
        });
        let Some(mark) = mark else { continue };
        let written = crate::Table::new(table, ids);
        let written = match &mark.position {
            None => written.field(mark.point_field(), places),
            Some([x, y]) => match (x.field_name(), y.field_name()) {
                (Some(x), Some(y)) => written
                    .field(x, places.iter().map(|p| p[0]).collect::<Vec<_>>())
                    .field(y, places.iter().map(|p| p[1]).collect::<Vec<_>>()),
                _ => continue,
            },
        };
        match patches.iter_mut().find(|patch| patch.data() == Some(&data)) {
            Some(patch) => *patch = std::mem::take(patch).set(written),
            None => patches.push(Patch::to(data).set(written)),
        }
    }
    patches
}

/// The error for a mark `shown` whose dataset is present but lacks the table it names. A dataset
/// from tiles gains tables as pieces arrive, so a table it lacks is not an error.
fn absent(shown: &Shown, snapshots: &[Snapshot], tiles: &crate::tiles::TileSets) -> Option<crate::Error> {
    let style = shown.mark.style();
    let data = snapshots.iter().find(|d| *d.name() == style.data)?;
    (shown.compiled.is_none() && !tiles.owns(&style.data)).then(|| shown.mark.absent_from(data)).flatten()
}
