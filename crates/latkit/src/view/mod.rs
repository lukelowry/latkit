//! Views: a scene drawn from named data into any wgpu frame, answering input.

mod axes;
mod camera;
mod clock;
mod event;
mod fit;
mod focus;
mod frame;
mod gestures;
mod graph;
mod input;
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
mod rows;
mod shadows;
mod sync;
mod timer;
mod transition;
mod uniforms;
mod variants;
mod wake;

use std::sync::Arc;
use std::task::Waker;
use std::time::Duration;

pub use camera::Camera;
pub(crate) use camera::Projected;
pub use event::{Cursor, End, Event, Fit, Hit, Phase, Sample, Stats, Trigger, Waiting};
pub use input::{Button, Device, Input, Key, Modifiers};
pub(crate) use resources::{DEPTH, SHADE};
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
use crate::{Data, Gpu, Name, Patch, Pending, Result, Row, Rows, Scene, Space};

/// A frame to draw: where, a texture view of a format and size in physical pixels at a ratio of
/// physical pixels to CSS pixels, and when.
#[derive(Clone, Copy, Debug)]
pub struct Frame<'a> {
    /// The texture view to draw into.
    pub target: &'a wgpu::TextureView,
    /// Its format; sRGB formats are handled.
    pub format: wgpu::TextureFormat,
    /// Its width and height in physical pixels.
    pub size: [u32; 2],
    /// Physical pixels per CSS pixel.
    pub pixel_ratio: f32,
    /// Seconds on the clock of whatever draws the frames: an animation frame's timestamp, a video
    /// frame's time, a test's step. The view's motion moves by the steps between them, a quarter of
    /// a second at most, and never back.
    pub time: f64,
}

/// A scene drawn from named data: the application owns data and scene; the view owns camera,
/// coordinate, selection, and what the frame needs. It has no loop: [`render`](View::render) records
/// a frame into an encoder the application submits, and [`input`](View::input) takes the platform's
/// pointer and keys.
///
/// ```no_run
/// # async fn example() -> latkit::Result<()> {
/// use latkit::{Data, Gpu, Ids, Plane, Scene, Table, Vertices, View};
/// let gpu = Gpu::new().await?;
/// let mut data = Data::new("graph");
/// data.apply(Table::new("Node", Ids::count(3)).field("x", vec![0.0, 1.0, 2.0]).field("y", vec![0.0, 1.0, 0.0]))?;
/// let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("graph", "Node").position("x", "y")))?;
/// view.set_data(data);
/// view.fit(latkit::Fit::All);
/// # Ok(()) }
/// ```
pub struct View {
    gpu: Gpu,
    scene: Scene,
    /// Bumps whenever the scene changes.
    scene_version: u64,
    /// The datasets given, and those the view fetches as the camera asks, by name.
    sources: Vec<Data>,
    /// What marks draw of each: the dataset as it is, or as drawn in part.
    data: Vec<Data>,
    /// What the view derives from the data and the scene: tables beside the tables it draws, row for
    /// row, which marks read like data.
    derived: Derivations,
    marks: Vec<Shown>,
    camera: Camera,
    rig: Rig,
    /// CSS pixels kept clear at the top, right, bottom, and left.
    insets: [f32; 4],
    fitting: Fitting,
    /// The value range a plot without one shows, fitted to its traces.
    plot_y: Option<[f64; 2]>,
    at: f64,
    clock: Clock,
    effect_time: f64,
    events: Events,
    /// What landing work wakes, and the waker it is: readbacks, jobs, and fetches hold it.
    signal: Arc<wake::Signal>,
    waker: Waker,
    resources: Option<Resources>,
    /// Marks' regions of the program buffer.
    regions: Regions,
    /// Marks came or went: row regions are laid out again.
    regions_dirty: bool,
    /// Something visible changed since the last frame.
    changed: bool,
    /// Whether the application was told the device was lost.
    told_lost: bool,
    /// The work under way the last frame stood in for.
    waiting: Waiting,
    /// The format and samples per pixel the scene's pipelines were made for.
    pipelines_made: Option<(wgpu::TextureFormat, u32)>,
    /// The target pictures last drew into, whose pipelines are made.
    picture_pipelines: Option<(wgpu::TextureFormat, u32)>,
    /// Who asked for the arranging under way.
    arranging: Vec<crate::Resolver<Vec<Patch>>>,
    /// Whether the platform asks for reduced motion, which `Motion::System` follows.
    reduced_motion: bool,
    /// What input needs, a stage made on each frame after the scene's first: the hover's, then the
    /// intents'.
    input_pipelines: std::collections::VecDeque<Vec<crate::gpu::pipelines::Variant>>,
    /// The shadow map and the face normals, made from what they read.
    shadow_map: Derived<()>,
    normals: Derived<()>,
    /// Measures what frames cost the GPU, where it can.
    timer: Option<timer::Timer>,
    focus: Focus,
    probing: Probing,
    queries: query::Queries,
    /// Words the marks' segment lists take at the front of the lists buffer.
    segment_words: u32,
    labels: labels::Labels,
    gestures: Gestures,
    /// The pointer over the view: where, with what keys, and with what; `None` once it left.
    pointer: Option<Trigger>,
    /// The size of the last frame, CSS pixels, and its pixel ratio.
    size: [f64; 2],
    pixel_ratio: f32,
    /// Pixel columns a trace spans at most: as many as the plan holds.
    trace_columns: u32,
    stats: Stats,
}

impl View {
    /// A view drawing `scene` with `gpu`. Its marks draw once [`set_data`](View::set_data) gives them
    /// their data.
    pub fn new(gpu: &Gpu, scene: Scene) -> Result<View> {
        scene.check()?;
        let camera = Camera::default_for(&scene.space);
        let signal = Arc::new(wake::Signal::default());
        let mut view = View {
            gpu: gpu.clone(),
            scene: Scene::new(scene.space.clone()),
            scene_version: 0,
            sources: Vec::new(),
            data: Vec::new(),
            derived: Derivations::default(),
            marks: Vec::new(),
            camera,
            rig: Rig::default(),
            insets: [0.0; 4],
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
            regions_dirty: true,
            changed: true,
            told_lost: false,
            waiting: Waiting::default(),
            pipelines_made: None,
            picture_pipelines: None,
            arranging: Vec::new(),
            reduced_motion: false,
            input_pipelines: std::collections::VecDeque::new(),
            shadow_map: Derived::default(),
            normals: Derived::default(),
            timer: timer::Timer::new(&gpu.0.device, &gpu.0.queue),
            focus: Focus::default(),
            probing: Probing::default(),
            queries: query::Queries::default(),
            segment_words: 0,
            labels: labels::Labels::default(),
            gestures: Gestures::default(),
            pointer: None,
            size: [0.0; 2],
            pixel_ratio: 1.0,
            trace_columns: u32::MAX,
            stats: Stats::default(),
        };
        view.show(scene)?;
        // Until it draws, a view waits on everything its first frame would.
        view.waiting = view.under_way();
        Ok(view)
    }

    /// The scene drawn.
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Draws `scene` instead. Marks that match one of the current scene by kind, data, table, and name
    /// keep their state, and ease to a changed description; an invalid scene changes nothing.
    pub fn show(&mut self, scene: Scene) -> Result<()> {
        scene.check()?;
        let gpu = self.gpu.clone();
        let mut inner = gpu.0.lock();
        // A mark compiles again when its theme or space changed.
        let context_changed = scene.theme != self.scene.theme
            || std::mem::discriminant(&scene.space) != std::mem::discriminant(&self.scene.space)
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
            shown.compile(&self.sources, context, &mut inner).map_err(|e| e.at(i).at("marks"))?;
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
                        .expect("kept");
                    kept.mark = mark.clone();
                    return kept;
                };
                // A changed mark takes over its predecessor's rows, and eases from them.
                let before = old.iter_mut().find(|s| s.as_ref().is_some_and(|s| s.key == shown.key));
                if let Some(mut before) = before.and_then(Option::take) {
                    before.tables.release(&mut inner);
                    shown.inherit(&before);
                    if easing && shown.compiled.as_ref().map(|c| c.drawing.stride) == Some(before.stride()) {
                        shown.begin(None);
                    }
                }
                shown
            })
            .collect();
        for mut dropped in old.into_iter().flatten() {
            dropped.tables.release(&mut inner);
        }
        for shown in self.marks.iter_mut().filter(|s| s.failure.is_none()) {
            shown.failure = absent(shown, &self.sources, &self.derived.tiles).map(|error| (error, false));
        }
        self.regions_dirty = true;
        drop(inner);
        if !self.camera.fits(&scene.space) {
            self.camera = Camera::default_for(&scene.space);
            self.plot_y = None;
        }
        if matches!(scene.space, Space::Diagram(_)) {
            self.rig.orbit = 0.0;
        }
        self.scene = scene;
        self.scene_version += 1;
        self.pipelines_made = None;
        self.picture_pipelines = None;
        self.focus.dirty = true;
        self.gestures.keys.stale();
        self.invalidate();
        Ok(())
    }

    /// Gives the view the dataset `data`, replacing the one of the same name. Cheap: unchanged pages
    /// are shared and only changed fields are evaluated again. A mark it no longer fits draws nothing,
    /// and the next frame reports why, unless a scene shown before then replaces the mark: new data
    /// and the scene reading it can be given in either order.
    pub fn set_data(&mut self, data: Data) {
        let gpu = self.gpu.clone();
        let mut inner = gpu.0.lock();
        self.take_data(data, &mut inner);
    }

    /// Takes `data` with the GPU's state locked: marks whose schema it changed compile again; one that
    /// fails keeps why until data fits it again, and the frame tells it. The frame draws the data, as
    /// it is or in part.
    fn take_data(&mut self, data: Data, inner: &mut crate::gpu::Inner) {
        let at = match self.sources.binary_search_by(|d| d.name().cmp(data.name())) {
            Ok(i) => {
                self.sources[i] = data;
                i
            }
            Err(i) => {
                self.sources.insert(i, data);
                i
            }
        };
        let context = Context { theme: &self.scene.theme, space: &self.scene.space, layout: &self.scene.layout };
        for shown in &mut self.marks {
            if shown.stale(&self.sources[at]) {
                let failed = shown.compile(&self.sources, context, inner).err();
                let failed = failed.or_else(|| absent(shown, &self.sources, &self.derived.tiles));
                shown.failure = failed.map(|error| (error, false));
            }
        }
        // Rows may have moved under the focus and the keys.
        self.focus.dirty = true;
        self.gestures.keys.stale();
        self.fitting.plot_due = true;
        self.wake();
    }

    /// The dataset named `name`, as given, or as the view fetches it.
    pub fn data(&self, name: &str) -> Option<&Data> {
        self.source(name)
    }

    /// The dataset named `name`, whole.
    fn source(&self, name: &str) -> Option<&Data> {
        self.sources.iter().find(|d| d.name() == name)
    }

    /// What marks draw of the dataset named `name`: it as it is, or as drawn in part.
    fn drawn(&self, name: &str) -> Option<&Data> {
        self.data.iter().find(|d| d.name() == name)
    }

    /// Fetches `tiles` as the camera asks for them, kept as the dataset they name, which the view
    /// owns: marks draw it like any other, [`data`](View::data) reads it, and
    /// [`remove_data`](View::remove_data) stops it. Tiles of the same name replace these.
    pub fn set_tiles(&mut self, tiles: crate::geo::Tiles) {
        self.derived.tiles.set(tiles);
        self.wake();
    }

    /// Stops drawing the dataset named `name`, given or fetched as tiles.
    pub fn remove_data(&mut self, name: &str) {
        self.derived.tiles.remove(name);
        self.sources.retain(|d| d.name() != name);
        self.data.retain(|d| d.name() != name);
        let gpu = self.gpu.clone();
        let mut inner = gpu.0.lock();
        for shown in &mut self.marks {
            if shown.mark.style().data == *name {
                shown.failure = None;
            }
            if shown.compiled.as_ref().is_some_and(|c| c.schemas.iter().any(|(n, _)| n == name)) {
                shown.tables.release(&mut inner);
                shown.compiled = None;
                shown.rows = 0;
                shown.exits = 0;
                shown.drawn = None;
            }
        }
        drop(inner);
        self.invalidate();
    }

    /// The axis coordinate shown: every sampled field reads its last frame at or before it.
    pub fn at(&self) -> f64 {
        self.at
    }

    /// Shows axis coordinate `at`; only options that read sampled fields evaluate again.
    pub fn set_at(&mut self, at: f64) {
        if at.to_bits() != self.at.to_bits() {
            self.at = at;
            self.wake();
        }
    }

    /// Where the view looks.
    pub fn camera(&self) -> &Camera {
        &self.camera
    }

    /// Looks through `camera` at once. Like every setter, it tells nothing: the application knows.
    pub fn set_camera(&mut self, camera: Camera) {
        if camera.fits(&self.scene.space) {
            self.rig.hold();
            self.place_camera(camera);
        }
    }

    /// Tells the view whether the platform asks for reduced motion, as a browser's
    /// `prefers-reduced-motion` does: `Motion::System` follows it. A canvas tells it itself.
    pub fn set_reduced_motion(&mut self, reduced: bool) {
        if reduced != self.reduced_motion {
            self.reduced_motion = reduced;
            self.wake();
        }
    }

    /// Whether the view moves on its own: eases, flights, coasting, orbits, label fades, comets, and
    /// what reads `elapsed()`.
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

    /// What changes ease over: the scene's ease, or nothing where the view does not move on its own.
    pub(super) fn ease(&self) -> Duration {
        if self.moves() { self.scene.ease } else { Duration::ZERO }
    }

    /// Eases to `camera` over twice the scene's ease, on the view's clock.
    pub fn fly(&mut self, camera: Camera) {
        if camera.fits(&self.scene.space) {
            let seconds = (self.ease().max(Duration::from_millis(1)) * 2).as_secs_f64();
            self.rig.fly(self.camera, camera, self.clock.now(), seconds);
            self.wake();
        }
    }

    /// Where `position` (x, y, and elevation) lands on screen, CSS pixels from the top left; `None`
    /// behind the camera. Overlays anchor to what the view draws with it.
    pub fn point(&self, position: [f64; 3]) -> Option<[f32; 2]> {
        let view = self.projected();
        view.screen(view.world(position)).map(|s| [s[0] as f32, s[1] as f32])
    }

    /// The position on the ground under `point`: on a plane at elevation 0, on the earth its surface,
    /// on a plot the values there; `None` where the pointer looks past it.
    pub fn ground(&self, point: [f32; 2]) -> Option<[f64; 3]> {
        let view = self.projected();
        view.surface(point.map(f64::from)).map(|w| view.position(w))
    }

    /// Lays every vertex row without a position out again by the scene's layout: a diagram's blocks,
    /// or the points of a plane or the earth. Places a layout gave otherwise hold, so rows added later
    /// are placed around the rest. Once the layout lands, the answer is a patch to each dataset
    /// writing each row laid out into its mark's position fields (or its point `geometry`); applied,
    /// the places are the data's own. A mark whose position is not fields is left out.
    pub fn arrange(&mut self) -> Pending<Vec<Patch>> {
        let (pending, resolver) = Pending::new();
        self.arranging.push(resolver);
        self.derived.arrange(matches!(self.scene.space, Space::Diagram(_)));
        self.wake();
        pending
    }

    /// Answers the arranging asked for, once its layout landed.
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

    /// CSS pixels kept clear at the top, right, bottom, and left: the camera centers and fits in what
    /// remains, as when panels cover part of the view.
    pub fn insets(&self) -> [f32; 4] {
        self.insets
    }

    /// Keeps `insets` clear.
    pub fn set_insets(&mut self, insets: [f32; 4]) {
        if insets != self.insets {
            self.insets = insets;
            self.wake();
        }
    }

    /// Degrees of bearing a map or plane turns each second about its center.
    pub fn orbit(&self) -> f64 {
        self.rig.orbit
    }

    /// Turns the camera `degrees_per_second` about its center; zero stops it. A diagram never turns.
    pub fn set_orbit(&mut self, degrees_per_second: f64) {
        let turns = degrees_per_second.is_finite() && !matches!(self.scene.space, Space::Diagram(_));
        self.rig.orbit = if turns { degrees_per_second } else { 0.0 };
        self.wake();
    }

    /// The rows selected, a set per table in the order each was first selected.
    pub fn selection(&self) -> Vec<Rows> {
        Rows::group(self.focus.selection.iter().cloned())
    }

    /// Selects `rows`, and no others, telling nothing. Rows the data drops, or no pickable mark shows,
    /// leave the selection with a [`Select`](Event::Select) event without a trigger.
    pub fn select(&mut self, rows: impl IntoIterator<Item = Rows>) {
        let rows = Rows::flatten(rows);
        if rows != self.focus.selection {
            self.focus.selection = rows;
            self.focus.dirty = true;
            self.wake();
        }
    }

    /// What the user points at: the row under the pointer, or the row the keys stepped to.
    pub fn hovered(&self) -> Option<&Hit> {
        self.focus.hovered.as_ref()
    }

    /// Every mark that draws nothing because its data no longer fits it, and why.
    pub fn failures(&self) -> impl Iterator<Item = crate::Error> + '_ {
        self.marks.iter().enumerate().filter_map(|(i, shown)| Some(shown.failure.as_ref()?.0.clone().at(i).at("marks")))
    }

    /// The pointer the view asks for over what it shows.
    pub fn cursor(&self) -> Cursor {
        self.gestures.cursor(self.probing.hovered(), &self.scene)
    }

    /// What the view did.
    pub fn stats(&self) -> Stats {
        let inner = self.gpu.0.lock();
        let rows = |m: &Shown| {
            let style = m.mark.style();
            self.source(&style.data).and_then(|d| d.table(&style.table)).map_or(0, |t| t.len() as u64)
        };
        let [tiles, tiles_loading] = self.derived.tiles.counts();
        Stats {
            rows: self.marks.iter().map(rows).sum(),
            drawn: self.marks.iter().map(|m| u64::from(m.rows)).sum(),
            tiles,
            tiles_loading,
            uploading: inner.arena.pending(),
            resident: inner.arena.resident(),
            budget: inner.budget.bytes.min(inner.arena.capacity()),
            waiting: self.waiting,
            ..self.stats
        }
    }

    /// Whether the last frame drew everything as the data, scene, and camera say, with nothing
    /// standing in for work under way: no changed page waited to upload, no tile drew its ancestor,
    /// no table its first sample, no row stood where it was until a layout landed, no wire drew its
    /// elbows, no area its earlier triangles, no label its estimate, and no fit was due. Whatever
    /// captures frames waits for it; [`Stats::waiting`] says what it waits on.
    pub fn complete(&self) -> bool {
        self.waiting.is_empty()
    }

    /// What happened since the last call, in order: see [`Event`]. An intent whose detail a pick has
    /// yet to bring waits for it, and the intents after it wait too.
    pub fn events(&mut self) -> impl Iterator<Item = Event> + use<> {
        self.events.drain()
    }

    /// Woken when the view needs a frame without being asked: work it waited on lands, data or the
    /// camera changes.
    pub fn set_waker(&mut self, waker: Waker) {
        self.signal.set_waker(waker);
    }

    /// What wakes the view: a shot drawing it waits on it.
    pub(crate) fn signal(&self) -> &Arc<wake::Signal> {
        &self.signal
    }

    /// Whether a [`Shot`](crate::Shot) or a [`Video`](crate::Video) draws the view: nothing else
    /// should draw it meanwhile, as a canvas or a window holds its last frame, since a view draws at
    /// one size at a time.
    pub fn lent(&self) -> bool {
        self.signal.lent()
    }

    /// The GPU the view draws with.
    pub(crate) fn gpu(&self) -> &Gpu {
        &self.gpu
    }

    /// The error a capture fails on: the first one still untold, which stays for the view's owner.
    pub(crate) fn capture_error(&mut self) -> Option<crate::Error> {
        self.tell_gpu_errors();
        self.events.error().cloned()
    }

    /// Whether a frame would differ from the last one: something changed, moves, or streams in, or
    /// work the view waited on landed. While it only waits, it needs none: what it waits on wakes it.
    pub fn needs_render(&self) -> bool {
        // What moves on its own, only while the view moves on its own: under reduced motion an orbit,
        // comets, and what reads `elapsed()` hold still.
        let moves = self.moves();
        self.changed
            || self.signal.landed()
            || self.rig.easing()
            || (self.rig.orbit != 0.0 && moves)
            || self.fitting.due()
            || self.probing.due()
            || self.queries.due()
            || self.derived.tiled.due()
            || self.labels.fading(self.clock.now())
            // A mark evaluates once its columns synced: until then, the pages they wait for wake it.
            || self.marks.iter().any(|m| (m.drawable() && (m.dirty != 0 || m.reduce)) || m.begin.is_some() || m.transition.is_some())
            || (moves && self.marks.iter().any(|m| m.compiled.as_ref().is_some_and(|c| c.program.reads().intersects(Deps::TIME))))
            || (moves && self.flowing())
            || self.gpu.0.lock().arena.uploading()
    }

    /// Whether the view wants a frame: one that would differ ([`needs_render`](View::needs_render)),
    /// or one that looks the same but goes on with what input needs, making its pipelines or noticing
    /// a touch held long enough for a menu. A loop drawing on demand draws while this holds, as a
    /// canvas does; a video holds the frames that only want to go on.
    pub fn wants_frame(&self) -> bool {
        self.needs_render() || !self.input_pipelines.is_empty() || self.holding()
    }

    /// Whether comets travel along a mark's rows: one that flows draws, and the theme shows them.
    fn flowing(&self) -> bool {
        self.scene.theme.flow.color.a > 0.0 && self.marks.iter().any(|m| m.drawable() && m.mark.flows())
    }

    /// Whether the next frame does work this one left: pages to upload past the frame's budget, rows
    /// to lay out, a fit, probe, or query due, the tiles the camera wants, or a transition to begin.
    /// Nothing else would wake the view for it: jobs, texts, fetches, and readbacks do as they land.
    fn due(&self) -> bool {
        self.gpu.0.lock().arena.uploading()
            || self.regions_dirty
            || self.fitting.due()
            || self.probing.due()
            || self.queries.due()
            || self.derived.tiled.due()
            || self.marks.iter().any(|m| m.begin.is_some())
    }

    fn wake(&mut self) {
        self.changed = true;
        self.signal.ask();
    }

    /// The work under way a frame drawn now stands in for: see [`complete`](View::complete). A mark
    /// waits for a dataset it names until it is given; one that failed, or that draws tiles the view
    /// fetches, which may never hold its table, stands in for nothing.
    fn under_way(&self) -> Waiting {
        let marks = || self.marks.iter().filter(|m| m.compiled.is_some());
        let given = |m: &Shown| {
            let data = &m.mark.style().data;
            m.compiled.is_some() || m.failure.is_some() || self.source(data).is_some() || self.derived.tiles.owns(data)
        };
        Waiting {
            data: !self.marks.iter().all(given) || marks().any(|m| !m.tables.synced() || m.tables.waiting()),
            derived: !self.derived.complete(),
            labels: !self.labels.complete(),
            fit: self.fitting.due() || self.fitting.reading(),
            marks: self.regions_dirty || marks().any(|m| m.segments.found.busy() || m.begin.is_some()),
        }
    }

    /// Whether something eases toward where it goes: a transition, a flight, coasting, or a label
    /// fade. An orbit, a comet, and anything else that moves for as long as it is shown never settles,
    /// and is not counted.
    pub(crate) fn easing(&self) -> bool {
        self.rig.easing()
            || self.labels.fading(self.clock.now())
            || self.marks.iter().any(|m| m.begin.is_some() || m.transition.is_some())
    }

    fn invalidate(&mut self) {
        self.regions_dirty = true;
        self.regions.relayout = true;
        self.fitting.plot_due = true;
        self.wake();
    }

    /// The part of the view the camera frames: inside the insets, and on a plot inside its axes.
    fn area(&self) -> Area {
        let [w, h] = self.size;
        let [top, right, bottom, left] = self.insets.map(f64::from);
        let mut area = [left, top, w - right, h - bottom];
        if let Space::Plot(plot) = &self.scene.space {
            let gutters = axes::gutters(plot, &self.scene.theme);
            area = [area[0] + gutters[3], area[1] + gutters[0], area[2] - gutters[1], area[3] - gutters[2]];
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

    /// What `camera` would show, a plot's missing value range filled as the frame fills it.
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
            shown.tables.release(&mut inner);
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

/// The patches writing rows laid out into the data, by dataset: each row's place into the position
/// fields of the vertex mark drawing its table, or its point geometry.
fn arranged(scene: &Scene, placed: Vec<(Row, [f64; 2])>) -> Vec<Patch> {
    /// A table's rows laid out: its dataset and name, their ids, and their places.
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

/// Why `shown`, whose dataset is given, draws nothing: the table it names is absent. A dataset the
/// view fetches as tiles fills its tables as they land, so a table it lacks is not missing.
fn absent(shown: &Shown, sources: &[Data], tiles: &crate::derive::tiles::TileSets) -> Option<crate::Error> {
    let style = shown.mark.style();
    let data = sources.iter().find(|d| *d.name() == style.data)?;
    (shown.compiled.is_none() && data.table(&style.table).is_none() && !tiles.owns(&style.data))
        .then(|| crate::Error::invalid(format!("dataset '{}' has no table '{}'", style.data, style.table)).at("of"))
}
