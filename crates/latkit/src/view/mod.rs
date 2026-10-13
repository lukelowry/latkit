//! Views: a scene drawn from named data into any wgpu frame, answering input.

mod axes;
mod camera;
mod event;
mod fit;
mod focus;
mod frame;
mod gestures;
mod input;
mod marks;
mod passes;
mod probe;
mod program;
mod resources;
mod rig;
mod sync;
mod uniforms;

use std::task::Waker;
use std::time::Duration;

pub use camera::Camera;
pub use event::{Cursor, Drag, Event, Fit, Hit, Phase, Stats};
pub use input::{Button, Input, Key, Modifiers};
pub(crate) use resources::DEPTH;

use camera::{Area, Projected};
use fit::Fitting;
use focus::Focus;
use gestures::Gestures;
use marks::Shown;
use probe::Probing;
use program::Regions;
use resources::Resources;
use rig::Rig;
use web_time::Instant;

use crate::expr::compile::Deps;
use crate::{Data, Error, Gpu, Result, Row, Scene, Space};

/// Where a frame is drawn: a texture view, its format and size in physical pixels, and how many
/// physical pixels make a CSS pixel.
#[derive(Clone, Copy, Debug)]
pub struct Target<'a> {
    /// The texture view to draw into.
    pub view: &'a wgpu::TextureView,
    /// Its format; sRGB formats are handled.
    pub format: wgpu::TextureFormat,
    /// Its width and height in physical pixels.
    pub size: [u32; 2],
    /// Physical pixels per CSS pixel.
    pub pixel_ratio: f32,
}

/// A scene drawn from named data: the application owns data and scene; the view owns camera,
/// coordinate, selection, and what the frame needs. It has no loop: [`render`](View::render) records
/// a frame into an encoder the application submits, and [`input`](View::input) takes the platform's
/// pointer and keys.
///
/// ```no_run
/// # async fn example() -> latkit::Result<()> {
/// use latkit::{Data, Gpu, Patch, Plane, Scene, Table, Vertices, View};
/// let gpu = Gpu::new().await?;
/// let mut data = Data::new("graph");
/// data.apply(Table::new("Node", 3).field("x", vec![0.0, 1.0, 2.0]).field("y", vec![0.0, 1.0, 0.0]))?;
/// let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("graph", "Node").position("x", "y")))?;
/// view.set_data(data);
/// view.fit(latkit::Fit::All);
/// # Ok(()) }
/// ```
pub struct View {
    gpu: Gpu,
    scene: Scene,
    data: Vec<Data>,
    marks: Vec<Shown>,
    camera: Camera,
    rig: Rig,
    /// CSS pixels kept clear at the top, right, bottom, and left.
    insets: [f32; 4],
    fitting: Fitting,
    /// The value range a plot without one shows, fitted to its traces.
    plot_y: Option<[f64; 2]>,
    at: f64,
    start: Instant,
    events: Vec<Event>,
    waker: Option<Waker>,
    resources: Option<Resources>,
    /// Marks' regions of the program buffer.
    regions: Regions,
    /// Rows moved: the state, focus, and domain buffers are laid out again.
    layout_dirty: bool,
    /// Something visible changed since the last frame.
    changed: bool,
    /// The last upload error reported, so a lasting one is reported once.
    upload_error: Option<Error>,
    focus: Focus,
    probing: Probing,
    gestures: Gestures,
    /// The pointer over the view, CSS pixels.
    pointer: Option<[f32; 2]>,
    /// The size of the last frame, CSS pixels, and its pixel ratio.
    size: [f64; 2],
    pixel_ratio: f32,
    stats: Stats,
}

impl View {
    /// A view drawing `scene` with `gpu`. Its marks draw once [`set_data`](View::set_data) gives them
    /// their data.
    pub fn new(gpu: &Gpu, scene: Scene) -> Result<View> {
        scene.check()?;
        let camera = Camera::default_for(&scene.space);
        let mut view = View {
            gpu: gpu.clone(),
            scene: Scene::new(scene.space.clone()),
            data: Vec::new(),
            marks: Vec::new(),
            camera,
            rig: Rig::default(),
            insets: [0.0; 4],
            fitting: Fitting::default(),
            plot_y: None,
            at: f64::INFINITY,
            start: Instant::now(),
            events: Vec::new(),
            waker: None,
            resources: None,
            regions: Regions::default(),
            layout_dirty: true,
            changed: true,
            upload_error: None,
            focus: Focus::default(),
            probing: Probing::default(),
            gestures: Gestures::default(),
            pointer: None,
            size: [0.0; 2],
            pixel_ratio: 1.0,
            stats: Stats::default(),
        };
        view.show(scene)?;
        Ok(view)
    }

    /// The scene drawn.
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Draws `scene` instead. Marks that match one of the current scene by kind, data, table, and name
    /// keep their state; an invalid scene changes nothing.
    pub fn show(&mut self, scene: Scene) -> Result<()> {
        scene.check()?;
        let gpu = self.gpu.clone();
        let mut inner = gpu.0.lock();
        let theme_changed = scene.theme != self.scene.theme;
        // Compile every new or changed mark before changing anything.
        let mut fresh = Vec::with_capacity(scene.marks.len());
        for (i, mark) in scene.marks.iter().enumerate() {
            let kept = !theme_changed && self.marks.iter().any(|s| s.mark.draws_like(mark));
            if kept {
                fresh.push(None);
                continue;
            }
            let mut shown = Shown::new(mark.clone());
            shown.compile(&self.data, &scene.theme, &mut inner).map_err(|e| e.at(i).at("marks"))?;
            fresh.push(Some(shown));
        }
        let mut old: Vec<Option<Shown>> = std::mem::take(&mut self.marks).into_iter().map(Some).collect();
        self.marks = scene
            .marks
            .iter()
            .zip(fresh)
            .map(|(mark, fresh)| {
                fresh.unwrap_or_else(|| {
                    let mut kept = old
                        .iter_mut()
                        .find(|s| s.as_ref().is_some_and(|s| s.mark.draws_like(mark)))
                        .and_then(Option::take)
                        .expect("kept");
                    kept.mark = mark.clone();
                    kept
                })
            })
            .collect();
        for mut dropped in old.into_iter().flatten() {
            dropped.tables.release(&mut inner);
        }
        drop(inner);
        if !self.camera.fits(&scene.space) {
            self.camera = Camera::default_for(&scene.space);
            self.plot_y = None;
        }
        self.scene = scene;
        self.focus.dirty = true;
        self.invalidate();
        Ok(())
    }

    /// Gives the view the dataset `data`, replacing the one of the same name. Cheap: unchanged pages
    /// are shared and only changed fields are evaluated again.
    pub fn set_data(&mut self, data: Data) {
        let at = match self.data.binary_search_by(|d| d.name().cmp(data.name())) {
            Ok(i) => {
                self.data[i] = data;
                i
            }
            Err(i) => {
                self.data.insert(i, data);
                i
            }
        };
        let gpu = self.gpu.clone();
        let mut inner = gpu.0.lock();
        for i in 0..self.marks.len() {
            if self.marks[i].stale(&self.data[at])
                && let Err(e) = self.marks[i].compile(&self.data, &self.scene.theme, &mut inner)
            {
                self.events.push(Event::Error(e.at(i).at("marks")));
            }
        }
        drop(inner);
        // Rows may have moved under the focus; a change of row count relays out when synced.
        self.focus.dirty = true;
        self.fitting.plot_due = true;
        self.wake();
    }

    /// The dataset named `name`.
    pub fn data(&self, name: &str) -> Option<&Data> {
        self.data.iter().find(|d| d.name() == name)
    }

    /// Stops drawing the dataset named `name`.
    pub fn remove_data(&mut self, name: &str) {
        self.data.retain(|d| d.name() != name);
        let gpu = self.gpu.clone();
        let mut inner = gpu.0.lock();
        for shown in &mut self.marks {
            if shown.compiled.as_ref().is_some_and(|c| c.schemas.iter().any(|(n, _)| n == name)) {
                shown.tables.release(&mut inner);
                shown.compiled = None;
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

    /// Looks through `camera` at once.
    pub fn set_camera(&mut self, camera: Camera) {
        if camera.fits(&self.scene.space) {
            self.rig.hold();
            self.move_camera(camera);
        }
    }

    /// Eases to `camera`.
    pub fn fly(&mut self, camera: Camera) {
        if camera.fits(&self.scene.space) {
            let duration = self.scene.ease.max(Duration::from_millis(1)) * 2;
            self.rig.fly(self.camera, camera, duration);
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

    /// Frames what `fit` names on the next frame, keeping pitch and bearing.
    pub fn fit(&mut self, fit: Fit) {
        self.focus.fitting = match &fit {
            Fit::Rows(rows) => rows.clone(),
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

    /// Turns the camera `degrees_per_second` about its center; zero stops it.
    pub fn set_orbit(&mut self, degrees_per_second: f64) {
        self.rig.orbit = if degrees_per_second.is_finite() { degrees_per_second } else { 0.0 };
        self.wake();
    }

    /// The rows selected.
    pub fn selection(&self) -> &[Row] {
        &self.focus.selection
    }

    /// Selects `rows`, and no others.
    pub fn select(&mut self, rows: impl IntoIterator<Item = Row>) {
        let rows: Vec<Row> = rows.into_iter().collect();
        if rows != self.focus.selection {
            self.focus.selection = rows;
            self.focus.dirty = true;
            self.wake();
        }
    }

    /// The pointer the view asks for over what it shows.
    pub fn cursor(&self) -> Cursor {
        self.gestures.cursor(self.probing.hovered(), &self.scene)
    }

    /// What the view did.
    pub fn stats(&self) -> Stats {
        let inner = self.gpu.0.lock();
        Stats {
            rows: self.marks.iter().map(|m| u64::from(m.rows)).sum(),
            uploading: inner.arena.pending(),
            gpu_bytes: inner.arena.resident(),
            ..self.stats
        }
    }

    /// What happened since the last call.
    pub fn events(&mut self) -> impl Iterator<Item = Event> + '_ {
        self.events.drain(..)
    }

    /// Woken when the view needs a frame without being asked: uploads finish, motion continues.
    pub fn set_waker(&mut self, waker: Waker) {
        self.waker = Some(waker);
    }

    /// Whether a frame would differ from the last one, or the view waits on the GPU.
    pub fn needs_render(&self) -> bool {
        self.changed
            || self.fitting.busy()
            || self.rig.moving()
            || self.probing.busy()
            || self.marks.iter().any(|m| m.dirty != 0 || m.reduce || m.tables.waiting())
            || self.marks.iter().any(|m| m.compiled.as_ref().is_some_and(|c| c.program.reads().intersects(Deps::TIME)))
            || self.gpu.0.lock().arena.uploading()
    }

    fn wake(&mut self) {
        self.changed = true;
        if let Some(waker) = &self.waker {
            waker.wake_by_ref();
        }
    }

    fn invalidate(&mut self) {
        self.layout_dirty = true;
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
