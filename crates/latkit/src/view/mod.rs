//! Views: a scene drawn from named data into any wgpu frame.

mod camera;
mod fit;
mod frame;
mod marks;
mod passes;
mod program;
mod resources;
mod sync;
mod uniforms;

use std::task::Waker;
use std::time::Duration;

pub use camera::Camera;
use fit::Fitting;
use marks::Shown;
use program::Regions;
use resources::Resources;
use web_time::Instant;

use crate::expr::compile::Deps;
use crate::{Data, Error, Gpu, Result, Scene, Space};

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

/// What happened in a view, for the application to act on.
#[derive(Clone, PartialEq, Debug)]
#[non_exhaustive]
pub enum Event {
    /// A mark does not fit its data and draws nothing until a scene or data fixes it.
    Error(Error),
    /// The camera moved.
    Camera,
}

/// A scene drawn from named data: the application owns data and scene; the view owns camera,
/// coordinate, and what the frame needs. It has no loop: [`render`](View::render) records a frame
/// into an encoder the application submits.
///
/// ```no_run
/// # async fn example() -> latkit::Result<()> {
/// use latkit::{Data, Gpu, Patch, Plane, Scene, Table, Vertices, View};
/// let gpu = Gpu::new().await?;
/// let mut data = Data::new("graph");
/// data.apply(Table::new("Node", 3).field("x", vec![0.0, 1.0, 2.0]).field("y", vec![0.0, 1.0, 0.0]))?;
/// let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("graph", "Node").position("x", "y")))?;
/// view.set_data(data);
/// view.fit();
/// # Ok(()) }
/// ```
pub struct View {
    gpu: Gpu,
    scene: Scene,
    data: Vec<Data>,
    marks: Vec<Shown>,
    camera: Camera,
    flight: Option<Flight>,
    fitting: Fitting,
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
}

struct Flight {
    from: Camera,
    to: Camera,
    start: Instant,
    duration: Duration,
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
            flight: None,
            fitting: Fitting::Idle,
            at: f64::INFINITY,
            start: Instant::now(),
            events: Vec::new(),
            waker: None,
            resources: None,
            regions: Regions::default(),
            layout_dirty: true,
            changed: true,
            upload_error: None,
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
            let kept = !theme_changed && self.marks.iter().any(|s| s.mark == *mark);
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
                    old.iter_mut()
                        .find(|s| s.as_ref().is_some_and(|s| s.mark == *mark))
                        .and_then(Option::take)
                        .expect("kept")
                })
            })
            .collect();
        for mut dropped in old.into_iter().flatten() {
            dropped.tables.release(&mut inner);
        }
        drop(inner);
        if !self.camera.fits(&scene.space) {
            self.camera = Camera::default_for(&scene.space);
        }
        self.scene = scene;
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
        self.invalidate();
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
            self.flight = None;
            self.camera = camera;
            self.events.push(Event::Camera);
            self.wake();
        }
    }

    /// Eases to `camera`.
    pub fn fly(&mut self, camera: Camera) {
        if camera.fits(&self.scene.space) {
            let duration = self.scene.ease.max(Duration::from_millis(1)) * 2;
            self.flight = Some(Flight { from: self.camera, to: camera, start: Instant::now(), duration });
            self.wake();
        }
    }

    /// Frames everything drawn, on the next frame.
    pub fn fit(&mut self) {
        self.fitting = Fitting::Requested;
        self.wake();
    }

    /// What happened since the last call.
    pub fn events(&mut self) -> impl Iterator<Item = Event> + '_ {
        self.events.drain(..)
    }

    /// Woken when the view needs a frame without being asked: uploads finish, motion continues.
    pub fn set_waker(&mut self, waker: Waker) {
        self.waker = Some(waker);
    }

    /// Whether a frame would differ from the last one.
    pub fn needs_render(&self) -> bool {
        self.changed
            || self.fitting.busy()
            || self.flight.is_some()
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
        self.wake();
    }

    /// The camera now, advancing a flight.
    fn advance(&mut self) {
        let Some(flight) = &self.flight else { return };
        let t = (flight.start.elapsed().as_secs_f64() / flight.duration.as_secs_f64()).min(1.0);
        let eased = t * t * (3.0 - 2.0 * t);
        let earth = matches!(self.scene.space, Space::Earth(_));
        self.camera = flight.from.ease(&flight.to, eased, earth);
        self.events.push(Event::Camera);
        if t >= 1.0 {
            self.flight = None;
        }
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
