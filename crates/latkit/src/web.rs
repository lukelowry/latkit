//! Views in a browser. A [`PageView`] is a view the page holds: the page reads and changes it, hears
//! what it tells, and lends it to shots, with or without a canvas showing it. A [`Canvas`] shows views
//! in the panels of a `<canvas>` element, or of an `OffscreenCanvas` in a worker, and feeds each view
//! the pointer, wheel, and keys that land on its panel. Every canvas of one [`Gpu`] draws in one
//! animation frame, into one command buffer, after the frame listeners of [`on_frame`] run: linked
//! views always show the same moment, and an application's per-frame work lands in the frame it was
//! done for.

use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::sync::Arc;

use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{
    AddEventListenerOptions, HtmlCanvasElement, KeyboardEvent, OffscreenCanvas, PointerEvent, ResizeObserver,
    WheelEvent,
};

use crate::gpu::FORMAT;
use crate::panels::Rect;
use crate::shot::Views;
use crate::{Button, Cursor, Device, Error, Event, Frame, Gpu, Input, Key, Modifiers, Panels, Result, View};
use crate::{Image, Shot, Video};

/// Stops a listener when dropped.
#[must_use = "the listener stops when this is dropped"]
pub struct Listener(Option<Box<dyn FnOnce()>>);

impl Listener {
    /// Keeps listening for as long as what it listens to lives.
    pub fn forget(mut self) {
        self.0 = None;
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        if let Some(stop) = self.0.take() {
            stop();
        }
    }
}

type FrameListener = Rc<RefCell<dyn FnMut(f64)>>;
type EventListener = Rc<RefCell<dyn FnMut(&[Event])>>;

/// The animation frames of one `Gpu`: its listeners, then every canvas that needs a frame, then what
/// each of its views told.
struct Frames {
    gpu: Gpu,
    canvases: Vec<Weak<RefCell<Painted>>>,
    views: Vec<Weak<RefCell<Held>>>,
    listeners: Vec<(u64, FrameListener)>,
    next: u64,
    scheduled: Option<i32>,
    /// Whether a harness steps the frames itself ([`step`]): no animation frame is asked for.
    stepped: bool,
    /// What waits for work a view waits on to land ([`landed`]), woken as it asks for a frame, and
    /// how many times that was.
    landing: Vec<std::task::Waker>,
    wakes: u64,
    tick: Option<Closure<dyn FnMut(f64)>>,
    /// The page's `prefers-reduced-motion`, which each view is told, and what draws again when it
    /// changes; none in a worker.
    reduced: Option<(web_sys::MediaQueryList, Closure<dyn FnMut()>)>,
}

thread_local! {
    static FRAMES: RefCell<Vec<Rc<RefCell<Frames>>>> = const { RefCell::new(Vec::new()) };
}

fn frames_of(gpu: &Gpu) -> Rc<RefCell<Frames>> {
    FRAMES.with(|all| {
        let mut all = all.borrow_mut();
        if let Some(frames) = all.iter().find(|f| Arc::ptr_eq(&f.borrow().gpu.0, &gpu.0)) {
            return frames.clone();
        }
        let frames = Rc::new(RefCell::new(Frames {
            gpu: gpu.clone(),
            canvases: Vec::new(),
            views: Vec::new(),
            listeners: Vec::new(),
            next: 0,
            scheduled: None,
            stepped: false,
            landing: Vec::new(),
            wakes: 0,
            tick: None,
            reduced: None,
        }));
        let weak = Rc::downgrade(&frames);
        frames.borrow_mut().tick = Some(Closure::new(move |now: f64| {
            if let Some(frames) = weak.upgrade() {
                tick(&frames, now);
            }
        }));
        if let Some(Scope::Window(window)) = scope()
            && let Ok(Some(query)) = window.match_media("(prefers-reduced-motion: reduce)")
        {
            let weak = Rc::downgrade(&frames);
            let changed: Closure<dyn FnMut()> = Closure::new(move || {
                if let Some(frames) = weak.upgrade() {
                    schedule(&frames);
                }
            });
            query.set_onchange(Some(changed.as_ref().unchecked_ref()));
            frames.borrow_mut().reduced = Some((query, changed));
        }
        all.push(frames.clone());
        frames
    })
}

/// The page's or the worker's global scope, which hands out animation frames.
enum Scope {
    Window(web_sys::Window),
    Worker(web_sys::DedicatedWorkerGlobalScope),
}

fn scope() -> Option<Scope> {
    let global = js_sys::global();
    if let Some(window) = global.dyn_ref::<web_sys::Window>() {
        return Some(Scope::Window(window.clone()));
    }
    global.dyn_ref::<web_sys::DedicatedWorkerGlobalScope>().map(|worker| Scope::Worker(worker.clone()))
}

/// Asks for an animation frame, unless one is asked for or a harness steps the frames, and wakes what
/// waits for work to land.
fn schedule(frames: &Rc<RefCell<Frames>>) {
    let landing = {
        let mut f = frames.borrow_mut();
        if !f.stepped
            && f.scheduled.is_none()
            && let (Some(scope), Some(tick)) = (scope(), f.tick.as_ref())
        {
            let tick = tick.as_ref().unchecked_ref();
            f.scheduled = match scope {
                Scope::Window(window) => window.request_animation_frame(tick).ok(),
                Scope::Worker(worker) => worker.request_animation_frame(tick).ok(),
            };
        }
        f.wakes += 1;
        std::mem::take(&mut f.landing)
    };
    landing.into_iter().for_each(std::task::Waker::wake);
}

fn tick(frames: &Rc<RefCell<Frames>>, now: f64) {
    frames.borrow_mut().scheduled = None;
    let listeners = frames.borrow().listeners.clone();
    for (id, listener) in &listeners {
        if frames.borrow().listeners.iter().any(|(i, _)| i == id) {
            (listener.borrow_mut())(now);
        }
    }
    let (gpu, canvases, views) = {
        let mut f = frames.borrow_mut();
        f.canvases.retain(|c| c.strong_count() > 0);
        f.views.retain(|v| v.strong_count() > 0);
        let canvases = f.canvases.iter().filter_map(Weak::upgrade).collect::<Vec<_>>();
        let views = f.views.iter().filter_map(|v| v.upgrade().map(PageView)).collect::<Vec<_>>();
        (f.gpu.clone(), canvases, views)
    };
    let reduced = frames.borrow().reduced.as_ref().is_some_and(|(query, _)| query.matches());
    for view in &views {
        view.0.borrow_mut().view.set_reduced_motion(reduced);
    }
    let mut encoder = gpu.device().create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("latkit") });
    let shown: Vec<wgpu::SurfaceTexture> =
        canvases.iter().filter_map(|c| c.borrow_mut().record(&mut encoder, now / 1000.0)).collect();
    // A frame no canvas drew submits nothing: listeners alone keep frames coming.
    if !shown.is_empty() {
        gpu.queue().submit([encoder.finish()]);
    }
    for texture in shown {
        gpu.queue().present(texture);
    }
    for view in &views {
        view.dispatch();
    }
    for canvas in &canvases {
        canvas.borrow_mut().show_cursor();
    }
    let again = !frames.borrow().listeners.is_empty() || canvases.iter().any(|c| c.borrow().wants_frame());
    if again {
        schedule(frames);
    } else if canvases.is_empty() && views.is_empty() {
        FRAMES.with(|all| all.borrow_mut().retain(|f| !Rc::ptr_eq(f, frames)));
    }
}

/// Releases the registry's GPU and cancels its frame as soon as its final owner disappears.
fn release_idle(frames: &Rc<RefCell<Frames>>) {
    let mut f = frames.borrow_mut();
    f.canvases.retain(|c| c.strong_count() > 0);
    f.views.retain(|v| v.strong_count() > 0);
    if !f.canvases.is_empty() || !f.views.is_empty() || !f.listeners.is_empty() {
        return;
    }
    if let Some(id) = f.scheduled.take() {
        match scope() {
            Some(Scope::Window(window)) => drop(window.cancel_animation_frame(id)),
            Some(Scope::Worker(worker)) => drop(worker.cancel_animation_frame(id)),
            None => {}
        }
    }
    drop(f);
    FRAMES.with(|all| all.borrow_mut().retain(|f| !Rc::ptr_eq(f, frames)));
}

/// Asks for an animation frame of the `Gpu` whose shared state lies at `gpu`, waking what waits for
/// its work to land: what a view's waker does when work it waited on lands, always on the page's one
/// thread.
struct Wakes {
    gpu: usize,
}

/// What wakes `gpu`'s frames, and what waits for its work to land ([`landed`]), as work lands.
pub(crate) fn waker(gpu: &Gpu) -> std::task::Waker {
    std::task::Waker::from(Arc::new(Wakes { gpu: Arc::as_ptr(&gpu.0) as usize }))
}

impl std::task::Wake for Wakes {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        let frames = FRAMES
            .with(|all| all.borrow().iter().find(|f| Arc::as_ptr(&f.borrow().gpu.0) as usize == self.gpu).cloned());
        if let Some(frames) = frames {
            schedule(&frames);
        }
    }
}

/// Calls `listener` with the frame's timestamp, milliseconds as `requestAnimationFrame` gives it,
/// every animation frame before `gpu`'s canvases draw, until the returned listener is dropped.
pub fn on_frame(gpu: &Gpu, listener: impl FnMut(f64) + 'static) -> Listener {
    let frames = frames_of(gpu);
    let id = {
        let mut f = frames.borrow_mut();
        f.next += 1;
        let id = f.next;
        f.listeners.push((id, Rc::new(RefCell::new(listener))));
        id
    };
    schedule(&frames);
    let weak = Rc::downgrade(&frames);
    Listener(Some(Box::new(move || {
        if let Some(frames) = weak.upgrade() {
            frames.borrow_mut().listeners.retain(|(i, _)| *i != id);
            release_idle(&frames);
        }
    })))
}

/// Draws one frame of `gpu` now, at `now`, milliseconds as an animation frame's timestamp: its
/// listeners, then every canvas that needs a frame, then what its views told. From the first step
/// `gpu` asks for no animation frames: a harness steps every frame itself, so a run draws the same
/// frames however fast the device is, and work landing wakes [`landed`] alone.
pub fn step(gpu: &Gpu, now: f64) {
    let frames = frames_of(gpu);
    let scheduled = {
        let mut f = frames.borrow_mut();
        f.stepped = true;
        f.scheduled.take()
    };
    if let Some(id) = scheduled {
        match scope() {
            Some(Scope::Window(window)) => drop(window.cancel_animation_frame(id)),
            Some(Scope::Worker(worker)) => drop(worker.cancel_animation_frame(id)),
            None => {}
        }
    }
    tick(&frames, now);
}

/// Waits until work a view of `gpu` waits on lands after this call: a readback, a compile, a job, a
/// text, a fetch; or until a view asks for a frame. What lands between the call and the first wait
/// counts, as a view a harness changes right after asking does.
pub fn landed(gpu: &Gpu) -> impl Future<Output = ()> + 'static {
    let frames = frames_of(gpu);
    let seen = frames.borrow().wakes;
    std::future::poll_fn(move |context| {
        let mut f = frames.borrow_mut();
        if f.wakes != seen {
            return std::task::Poll::Ready(());
        }
        f.landing.push(context.waker().clone());
        std::task::Poll::Pending
    })
}

/// Waits until `gpu` finished the work submitted to it, every readback of it mapped, and every
/// pipeline asked of it compiled: a frame stepped then draws all that landed.
pub async fn done(gpu: &Gpu) {
    let (submitted, finished) = crate::Pending::new();
    gpu.queue().on_submitted_work_done(move || finished.resolve(Ok(())));
    let _ = submitted.await;
    loop {
        let under_way = {
            let inner = gpu.0.lock();
            inner.readbacks.mapping() + inner.pipelines.compiling()
        };
        if under_way == 0 {
            return;
        }
        landed(gpu).await;
    }
}

/// A view the page holds: it reads and changes the view, hears what it tells, shows it in a canvas,
/// and lends it to shots. Changing it asks its canvas for a frame.
#[derive(Clone)]
pub struct PageView(Rc<RefCell<Held>>);

struct Held {
    view: View,
    frames: Rc<RefCell<Frames>>,
    /// Whether it was changed since it last drew.
    due: bool,
    listeners: Vec<(u64, EventListener)>,
    next: u64,
}

impl PageView {
    /// Holds `view` for the page. Its `Gpu` must come from [`Gpu::new`]; it sets text with the
    /// browser's fonts unless it was given a host.
    pub fn new(mut view: View) -> PageView {
        let gpu = view.gpu().clone();
        // The view sleeps while it waits; what it waits on asks for the next frame as it lands.
        view.set_waker(waker(&gpu));
        if gpu.0.lock().host.is_none() {
            gpu.set_host(crate::host::Browser);
        }
        let frames = frames_of(&gpu);
        let held =
            Rc::new(RefCell::new(Held { view, frames: frames.clone(), due: true, listeners: Vec::new(), next: 0 }));
        frames.borrow_mut().views.push(Rc::downgrade(&held));
        PageView(held)
    }

    /// Calls `f` with the view, then draws a frame when it needs one.
    pub fn with<R>(&self, f: impl FnOnce(&mut View) -> R) -> R {
        let result = f(&mut self.0.borrow_mut().view);
        self.0.borrow_mut().due = true;
        let frames = self.0.borrow().frames.clone();
        schedule(&frames);
        result
    }

    /// Calls `f` with the view, to read it without asking for a frame.
    pub fn read<R>(&self, f: impl FnOnce(&View) -> R) -> R {
        f(&self.0.borrow().view)
    }

    /// Calls `listener` with what the view tells, a batch at a time and in order, until the returned
    /// listener is dropped. A listener hears what is told while it listens; what lasts is state the
    /// view reads out.
    pub fn on(&self, listener: impl FnMut(&[Event]) + 'static) -> Listener {
        let id = {
            let mut held = self.0.borrow_mut();
            held.next += 1;
            let id = held.next;
            held.listeners.push((id, Rc::new(RefCell::new(listener))));
            id
        };
        let weak = Rc::downgrade(&self.0);
        Listener(Some(Box::new(move || {
            if let Some(held) = weak.upgrade() {
                held.borrow_mut().listeners.retain(|(i, _)| *i != id);
            }
        })))
    }

    /// Hands what the view told to its listeners, one batch.
    fn dispatch(&self) {
        let (events, listeners) = {
            let mut held = self.0.borrow_mut();
            let events: Vec<Event> = held.view.events().collect();
            if events.is_empty() {
                return;
            }
            (events, held.listeners.clone())
        };
        for (id, listener) in &listeners {
            if self.0.borrow().listeners.iter().any(|(i, _)| i == id) {
                (listener.borrow_mut())(&events);
            }
        }
    }

    /// Whether it wants a frame and no shot holds it: it changed, or its view wants one. While what
    /// it draws with compiles, only a compile landing does.
    pub fn wants_frame(&self) -> bool {
        let held = self.0.borrow();
        !held.view.lent() && (held.view.wants_frame() || (held.due && !held.view.compiling()))
    }

    /// Whether it can draw into `format` at `pixel_ratio`: see [`View::ready`].
    fn ready(&self, format: wgpu::TextureFormat, pixel_ratio: f32) -> bool {
        self.0.borrow_mut().view.ready(format, pixel_ratio)
    }

    /// Whether a shot holds it.
    fn lent(&self) -> bool {
        self.0.borrow().view.lent()
    }
}

/// Views shown in a `<canvas>` element or an `OffscreenCanvas`, one per panel. An element sizes
/// itself to its CSS box at the device's pixel ratio and passes each view the pointer, wheel, and
/// keys that land on its panel; an offscreen canvas keeps the size it is given and takes no input. A
/// frame draws only the views that need one, or all of them when the canvas changes size.
#[derive(Clone)]
pub struct Canvas(Rc<RefCell<Painted>>);

/// What a canvas draws into.
enum Target {
    Element(HtmlCanvasElement),
    Offscreen { canvas: OffscreenCanvas, pixel_ratio: f32 },
}

struct Painted {
    target: Target,
    surface: Surface,
    frames: Rc<RefCell<Frames>>,
    panels: Panels,
    views: Vec<PageView>,
    /// Each panel's texture while the canvas composes several views, and its size.
    textures: Vec<Option<(wgpu::Texture, [u32; 2])>>,
    /// Each panel in CSS pixels, as last drawn: what input lands on.
    rects: Vec<[f32; 4]>,
    /// Whether every view draws in the next frame: the canvas changed size or what it shows.
    due: bool,
    /// The panel each pointer down went to, the panel under the pointer, and the panel keys go to.
    captured: Vec<(u32, usize)>,
    hovered: Option<usize>,
    focus: usize,
    cursor: Cursor,
    handlers: Vec<Handler>,
    resize: Option<Resizing>,
}

/// A listener of one kind of the element's events.
type Handler = (&'static str, Closure<dyn FnMut(web_sys::Event)>);
/// What follows the element's size.
type Resizing = (ResizeObserver, Closure<dyn FnMut(JsValue)>);

impl Canvas {
    /// A canvas showing views in `panels` of `element`. The `Gpu` must come from [`Gpu::new`].
    pub fn new(gpu: &Gpu, element: &HtmlCanvasElement, panels: impl Into<Panels>) -> Result<Canvas> {
        let size = [element.width(), element.height()];
        let surface = Surface::new(gpu, wgpu::SurfaceTarget::Canvas(element.clone()), size)?;
        let _ = element.style().set_property("touch-action", "none");
        // Keys reach the views without the page's help.
        if !element.has_attribute("tabindex") {
            element.set_tab_index(0);
        }
        let canvas = Canvas::with_target(gpu, Target::Element(element.clone()), surface, panels.into());
        let weak = Rc::downgrade(&canvas.0);
        let resized = Closure::<dyn FnMut(JsValue)>::new(move |_: JsValue| {
            if let Some(state) = weak.upgrade() {
                state.borrow_mut().due = true;
                schedule(&state.borrow().frames);
            }
        });
        let observer = ResizeObserver::new(resized.as_ref().unchecked_ref())
            .map_err(|_| Error::Unsupported("no ResizeObserver".into()))?;
        observer.observe(element);
        canvas.0.borrow_mut().resize = Some((observer, resized));
        listen(&canvas.0, element)?;
        Ok(canvas)
    }

    /// A canvas showing views in `panels` of `canvas`, `pixel_ratio` of its pixels a CSS pixel: in a
    /// worker, or wherever no page feeds it input. It keeps the size the canvas is given.
    pub fn offscreen(
        gpu: &Gpu,
        canvas: &OffscreenCanvas,
        panels: impl Into<Panels>,
        pixel_ratio: f32,
    ) -> Result<Canvas> {
        if !(pixel_ratio.is_finite() && pixel_ratio > 0.0) {
            return Err(Error::invalid("a canvas's pixel ratio is positive").at("pixelRatio"));
        }
        let size = [canvas.width(), canvas.height()];
        let surface = Surface::new(gpu, wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()), size)?;
        let target = Target::Offscreen { canvas: canvas.clone(), pixel_ratio };
        Ok(Canvas::with_target(gpu, target, surface, panels.into()))
    }

    fn with_target(gpu: &Gpu, target: Target, surface: Surface, panels: Panels) -> Canvas {
        let frames = frames_of(gpu);
        let state = Rc::new(RefCell::new(Painted {
            target,
            surface,
            frames: frames.clone(),
            panels,
            views: Vec::new(),
            textures: Vec::new(),
            rects: Vec::new(),
            due: true,
            captured: Vec::new(),
            hovered: None,
            focus: 0,
            cursor: Cursor::Default,
            handlers: Vec::new(),
            resize: None,
        }));
        frames.borrow_mut().canvases.push(Rc::downgrade(&state));
        schedule(&frames);
        Canvas(state)
    }

    /// Shows `views`, one per panel, in place of those it showed. A view shows in one canvas at a time.
    pub fn show(&self, views: &[PageView]) -> Result<()> {
        let expected = self.0.borrow().panels.len();
        if views.len() != expected {
            return Err(Error::invalid(format!("a canvas of {expected} panels shows {} views", views.len())));
        }
        let twice = views.iter().enumerate().any(|(i, a)| views[i + 1..].iter().any(|b| Rc::ptr_eq(&a.0, &b.0)));
        let frames = self.0.borrow().frames.clone();
        let elsewhere = frames.borrow().canvases.iter().filter_map(Weak::upgrade).any(|other| {
            !Rc::ptr_eq(&other, &self.0)
                && other.borrow().views.iter().any(|shown| views.iter().any(|v| Rc::ptr_eq(&v.0, &shown.0)))
        });
        if twice || elsewhere {
            return Err(Error::invalid("a view shows in one panel of one canvas"));
        }
        let mut state = self.0.borrow_mut();
        state.views = views.to_vec();
        state.textures.clear();
        state.captured.clear();
        state.hovered = None;
        state.focus = 0;
        state.due = true;
        drop(state);
        schedule(&frames);
        Ok(())
    }

    /// The canvas element, unless the canvas is offscreen.
    pub fn element(&self) -> Option<HtmlCanvasElement> {
        match &self.0.borrow().target {
            Target::Element(element) => Some(element.clone()),
            Target::Offscreen { .. } => None,
        }
    }
}

impl Painted {
    /// The canvas's size in pixels and pixels a CSS pixel.
    fn measure(&self) -> ([u32; 2], f32) {
        match &self.target {
            Target::Element(element) => {
                let ratio = web_sys::window().map_or(1.0, |w| w.device_pixel_ratio());
                let side = |css: i32| (f64::from(css) * ratio).round().max(1.0) as u32;
                ([side(element.client_width()), side(element.client_height())], ratio as f32)
            }
            Target::Offscreen { canvas, pixel_ratio } => {
                ([canvas.width().max(1), canvas.height().max(1)], *pixel_ratio)
            }
        }
    }

    /// Whether a frame is due: the canvas changed, or a view it shows wants to draw; never while shots
    /// hold every view it shows, whose last frames it keeps.
    fn wants_frame(&self) -> bool {
        self.views.iter().any(|v| !v.lent()) && (self.due || self.views.iter().any(PageView::wants_frame))
    }

    /// Records a frame when one is needed, sizing the canvas to its box first: each view that needs
    /// to draws into its panel, straight into the canvas when one view fills it. A view a shot holds,
    /// or whose scene's pipelines still compile, draws nothing new and keeps its panel; while no view
    /// it shows can draw, the canvas keeps the frame it shows.
    fn record(&mut self, encoder: &mut wgpu::CommandEncoder, time: f64) -> Option<wgpu::SurfaceTexture> {
        let (size, ratio) = self.measure();
        let resized = size != self.surface.size();
        if self.views.is_empty() || !(resized || self.wants_frame()) {
            return None;
        }
        let format = self.surface.config.format;
        let ready: Vec<bool> = self.views.iter().map(|v| !v.lent() && v.ready(format, ratio)).collect();
        if !ready.contains(&true) {
            return None;
        }
        let rects = self.panels.rects(size, [1, 1]).ok()?;
        let direct = rects.len() == 1 && rects[0].size == size;
        if resized {
            self.due = true;
            if let Target::Element(element) = &self.target {
                element.set_width(size[0]);
                element.set_height(size[1]);
            }
        }
        self.rects = rects.iter().map(|r| css(*r, ratio)).collect();
        let texture = self.surface.texture(size)?;
        let target = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
        if direct {
            let mut held = self.views[0].0.borrow_mut();
            held.view.render(encoder, &Frame { target: &target, format, size, pixel_ratio: ratio, time });
            held.due = false;
        } else {
            self.textures.resize_with(rects.len(), || None);
            for (i, rect) in rects.iter().enumerate() {
                let fresh = self.textures[i].as_ref().is_none_or(|(_, made)| *made != rect.size);
                if fresh {
                    self.textures[i] = Some((panel_texture(self.surface.gpu.device(), format, rect.size), rect.size));
                }
                let (panel, _) = self.textures[i].as_ref().expect("made");
                let mut held = self.views[i].0.borrow_mut();
                if ready[i] && (fresh || self.due || held.due || held.view.needs_render()) {
                    let target = panel.create_view(&wgpu::TextureViewDescriptor::default());
                    let frame = Frame { target: &target, format, size: rect.size, pixel_ratio: ratio, time };
                    held.view.render(encoder, &frame);
                    held.due = false;
                }
                encoder.copy_texture_to_texture(
                    panel.as_image_copy(),
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture.texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d { x: rect.origin[0], y: rect.origin[1], z: 0 },
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::Extent3d { width: rect.size[0], height: rect.size[1], depth_or_array_layers: 1 },
                );
            }
        }
        self.due = false;
        Some(texture)
    }

    /// Sets the element's cursor to the one the view under the pointer asks for.
    fn show_cursor(&mut self) {
        let Target::Element(element) = &self.target else { return };
        let cursor = self.hovered.and_then(|i| self.views.get(i)).map_or(Cursor::Default, |v| v.read(View::cursor));
        if cursor != self.cursor {
            self.cursor = cursor;
            let css = match cursor {
                Cursor::Default => "",
                Cursor::Pointer => "pointer",
                Cursor::Grab => "grab",
                Cursor::Grabbing => "grabbing",
                Cursor::Crosshair => "crosshair",
            };
            let _ = element.style().set_property("cursor", css);
        }
    }

    /// The panels `input` goes to, each with the input in its own CSS pixels: a pointer goes to the
    /// panel it pressed until it lets go, else to the panel under it, which hears when it leaves; keys
    /// go to the panel pressed last.
    fn route(&mut self, input: Input) -> Vec<(usize, Input)> {
        let rects = if self.rects.is_empty() { self.css_rects() } else { self.rects.clone() };
        let under = |point: [f32; 2]| {
            rects
                .iter()
                .rposition(|r| point[0] >= r[0] && point[0] < r[0] + r[2] && point[1] >= r[1] && point[1] < r[1] + r[3])
        };
        let local = |i: usize, input: Input| within(input, [rects[i][0], rects[i][1]]);
        let captured =
            |pointer: u32, captured: &[(u32, usize)]| captured.iter().find(|(p, _)| *p == pointer).map(|c| c.1);
        let mut routed = Vec::new();
        match input {
            Input::Down { pointer, point, .. } => {
                if let Some(i) = under(point) {
                    self.captured.retain(|(p, _)| *p != pointer);
                    self.captured.push((pointer, i));
                    self.focus = i;
                    routed.push((i, local(i, input)));
                }
            }
            Input::Move { pointer, point, .. } => {
                let held = captured(pointer, &self.captured);
                let i = held.or_else(|| under(point));
                if held.is_none() && self.hovered != i {
                    routed.extend(self.hovered.map(|old| (old, Input::Leave)));
                    self.hovered = i;
                }
                routed.extend(i.map(|i| (i, local(i, input))));
            }
            Input::Up { pointer, point, .. } => {
                let i = captured(pointer, &self.captured).or_else(|| under(point));
                self.captured.retain(|(p, _)| *p != pointer);
                routed.extend(i.map(|i| (i, local(i, input))));
            }
            Input::Cancel { pointer } => {
                routed.extend(captured(pointer, &self.captured).map(|i| (i, input)));
                self.captured.retain(|(p, _)| *p != pointer);
            }
            Input::Wheel { point, .. } => routed.extend(under(point).map(|i| (i, local(i, input)))),
            Input::Key { .. } => routed.push((self.focus.min(self.views.len().saturating_sub(1)), input)),
            Input::Leave => routed.extend(self.hovered.take().map(|i| (i, Input::Leave))),
        }
        routed.retain(|(i, _)| *i < self.views.len());
        routed
    }

    /// Each panel in CSS pixels, from the canvas's size now: before its first frame records them.
    fn css_rects(&self) -> Vec<[f32; 4]> {
        let (size, ratio) = self.measure();
        self.panels.rects(size, [1, 1]).map(|rects| rects.iter().map(|r| css(*r, ratio)).collect()).unwrap_or_default()
    }
}

/// `rect` in CSS pixels: x, y, width, height.
fn css(rect: Rect, ratio: f32) -> [f32; 4] {
    let [x, y] = rect.origin.map(|v| v as f32 / ratio);
    let [w, h] = rect.size.map(|v| v as f32 / ratio);
    [x, y, w, h]
}

/// `input` with its point taken from `origin`, so it reads from its panel's top left.
fn within(input: Input, origin: [f32; 2]) -> Input {
    let at = |point: [f32; 2]| [point[0] - origin[0], point[1] - origin[1]];
    match input {
        Input::Down { pointer, point, button, modifiers, device } => {
            Input::Down { pointer, point: at(point), button, modifiers, device }
        }
        Input::Move { pointer, point, modifiers, device } => {
            Input::Move { pointer, point: at(point), modifiers, device }
        }
        Input::Up { pointer, point, modifiers } => Input::Up { pointer, point: at(point), modifiers },
        Input::Wheel { point, delta, modifiers } => Input::Wheel { point: at(point), delta, modifiers },
        other => other,
    }
}

/// A panel's texture: views draw into it, and the canvas copies it into place.
fn panel_texture(device: &wgpu::Device, format: wgpu::TextureFormat, size: [u32; 2]) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("latkit panel"),
        size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

/// A canvas's surface: in the one format views draw in wherever the browser offers it, so canvases and
/// shots share their pipelines; alpha premultiplied; panels copied into it; configured again whenever
/// its size changes.
struct Surface {
    gpu: Gpu,
    raw: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
}

impl Surface {
    /// The surface of `target`, `size` pixels, drawn with `gpu`, which must come from [`Gpu::new`].
    fn new(gpu: &Gpu, target: wgpu::SurfaceTarget<'static>, size: [u32; 2]) -> Result<Surface> {
        let (Some(instance), Some(adapter)) = (gpu.instance(), gpu.adapter()) else {
            return Err(Error::Unsupported("a canvas draws with a Gpu made by Gpu::new".into()));
        };
        let raw =
            instance.create_surface(target).map_err(|e| Error::Unsupported(format!("no WebGPU canvas: {e}").into()))?;
        let capabilities = raw.get_capabilities(adapter);
        let format = if capabilities.formats.contains(&FORMAT) {
            FORMAT
        } else {
            capabilities
                .formats
                .first()
                .copied()
                .ok_or_else(|| Error::Unsupported("the canvas offers no format".into()))?
        };
        let alpha_mode = if capabilities.alpha_modes.contains(&wgpu::CompositeAlphaMode::PreMultiplied) {
            wgpu::CompositeAlphaMode::PreMultiplied
        } else {
            wgpu::CompositeAlphaMode::Auto
        };
        // Panels are drawn apart and copied in: a WebGPU canvas takes copies, whatever wgpu reports.
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_DST,
            format,
            width: size[0].max(1),
            height: size[1].max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode,
            view_formats: Vec::new(),
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        raw.configure(gpu.device(), &config);
        Ok(Surface { gpu: gpu.clone(), raw, config })
    }

    /// Its width and height in pixels, as last configured.
    fn size(&self) -> [u32; 2] {
        [self.config.width, self.config.height]
    }

    /// The texture to draw a frame of `size` pixels into, configuring the surface again first when
    /// its size changed; `None` when the surface had none to give, which a later frame tries again.
    fn texture(&mut self, size: [u32; 2]) -> Option<wgpu::SurfaceTexture> {
        let size = size.map(|v| v.max(1));
        if size != self.size() {
            [self.config.width, self.config.height] = size;
            self.raw.configure(self.gpu.device(), &self.config);
        }
        match self.raw.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => {
                Some(texture)
            }
            _ => {
                self.raw.configure(self.gpu.device(), &self.config);
                None
            }
        }
    }
}

/// Views the page holds, lent to a shot a step at a time, so the page reads them between steps and
/// hears what each step told.
struct Lending<'a>(&'a [PageView]);

impl Lending<'_> {
    /// The views, each once.
    fn of(views: &[PageView]) -> Result<Lending<'_>> {
        let twice = views.iter().enumerate().any(|(i, a)| views[i + 1..].iter().any(|b| Rc::ptr_eq(&a.0, &b.0)));
        if twice {
            return Err(Error::invalid("a shot draws each view in one panel"));
        }
        Ok(Lending(views))
    }
}

impl Views for Lending<'_> {
    fn lend<R>(&mut self, f: impl FnOnce(&mut [&mut View]) -> R) -> R {
        let result = {
            let mut held: Vec<std::cell::RefMut<'_, Held>> = self.0.iter().map(|v| v.0.borrow_mut()).collect();
            let mut views: Vec<&mut View> = held.iter_mut().map(|h| &mut h.view).collect();
            f(&mut views)
        };
        for view in self.0 {
            view.dispatch();
        }
        result
    }
}

/// The picture `shot` takes of `views`, one per panel, once they are complete and still. Canvases
/// showing them hold their last frames meanwhile.
pub async fn image(shot: &Shot, views: &[PageView]) -> Result<Image> {
    shot.image_of(&mut Lending::of(views)?).await
}

/// Draws `video`'s next frame of `views`, one per panel. Canvases showing them hold their last frames
/// until the video is finished or dropped.
pub async fn frame<S: crate::Sink>(video: &mut Video<S>, views: &[PageView]) -> Result<()> {
    video.frame_of(&mut Lending::of(views)?).await
}

impl Drop for Painted {
    fn drop(&mut self) {
        if let Target::Element(element) = &self.target {
            for (kind, handler) in &self.handlers {
                let _ = element.remove_event_listener_with_callback(kind, handler.as_ref().unchecked_ref());
            }
        }
        if let Some((observer, _)) = &self.resize {
            observer.disconnect();
        }
        release_idle(&self.frames);
    }
}

/// Feeds the element's pointer, wheel, and keys to the views of the panels they land on.
fn listen(state: &Rc<RefCell<Painted>>, element: &HtmlCanvasElement) -> Result<()> {
    let add = |kind: &'static str, handle: fn(&HtmlCanvasElement, &web_sys::Event) -> Option<Input>| {
        let weak = Rc::downgrade(state);
        let target = element.clone();
        let handler = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            let Some(state) = weak.upgrade() else { return };
            let Some(input) = handle(&target, &event) else { return };
            let routed = state.borrow_mut().route(input);
            let time = event.time_stamp() / 1000.0;
            let mut used = false;
            for (panel, input) in routed {
                let view = state.borrow().views.get(panel).cloned();
                if let Some(view) = view {
                    used |= view.with(|v| v.input(&input, time));
                    view.dispatch();
                }
            }
            // A wheel a view zooms with does not scroll the page; a key it uses does not either.
            if used && matches!(kind, "wheel" | "keydown") {
                event.prevent_default();
            }
            state.borrow_mut().show_cursor();
        });
        let options = AddEventListenerOptions::new();
        options.set_passive(false);
        element
            .add_event_listener_with_callback_and_add_event_listener_options(
                kind,
                handler.as_ref().unchecked_ref(),
                &options,
            )
            .map_err(|_| Error::Unsupported("the canvas takes no input".into()))?;
        state.borrow_mut().handlers.push((kind, handler));
        Ok::<(), Error>(())
    };
    add("pointerdown", pressed)?;
    add("pointermove", |element, event| {
        let event = event.dyn_ref::<PointerEvent>()?;
        Some(Input::Move {
            pointer: event.pointer_id() as u32,
            point: point(element, event),
            modifiers: modifiers!(event),
            device: device(event),
        })
    })?;
    add("pointerup", |element, event| {
        let event = event.dyn_ref::<PointerEvent>()?;
        let _ = element.release_pointer_capture(event.pointer_id());
        Some(Input::Up {
            pointer: event.pointer_id() as u32,
            point: point(element, event),
            modifiers: modifiers!(event),
        })
    })?;
    add("pointercancel", |_, event| {
        let event = event.dyn_ref::<PointerEvent>()?;
        Some(Input::Cancel { pointer: event.pointer_id() as u32 })
    })?;
    add("pointerleave", |_, _| Some(Input::Leave))?;
    add("wheel", |element, event| {
        let event = event.dyn_ref::<WheelEvent>()?;
        let scale = match event.delta_mode() {
            1 => 16.0,
            2 => 400.0,
            _ => 1.0,
        };
        Some(Input::Wheel {
            point: point(element, event),
            delta: [(event.delta_x() * scale) as f32, (event.delta_y() * scale) as f32],
            modifiers: modifiers!(event),
        })
    })?;
    add("contextmenu", |_, event| {
        event.prevent_default();
        None
    })?;
    for kind in ["keydown", "keyup"] {
        add(kind, |_, event| keyed(event))?;
    }
    Ok(())
}

/// A mouse event's point in CSS pixels from the element's top left.
fn point(element: &HtmlCanvasElement, event: &web_sys::MouseEvent) -> [f32; 2] {
    let rect = element.get_bounding_client_rect();
    [
        (f64::from(event.client_x()) - rect.left() - f64::from(element.client_left())) as f32,
        (f64::from(event.client_y()) - rect.top() - f64::from(element.client_top())) as f32,
    ]
}

/// The keys a key or mouse event says are held.
macro_rules! modifiers {
    ($event:expr) => {
        Modifiers {
            shift: $event.shift_key(),
            control: $event.ctrl_key(),
            alt: $event.alt_key(),
            meta: $event.meta_key(),
        }
    };
}
use modifiers;

/// A pointer press, focusing the element and capturing the pointer.
fn pressed(element: &HtmlCanvasElement, event: &web_sys::Event) -> Option<Input> {
    let event = event.dyn_ref::<PointerEvent>()?;
    let button = match event.button() {
        0 => Button::Primary,
        1 => Button::Middle,
        2 => Button::Secondary,
        _ => return None,
    };
    let _ = element.focus();
    let _ = element.set_pointer_capture(event.pointer_id());
    Some(Input::Down {
        pointer: event.pointer_id() as u32,
        point: point(element, event),
        button,
        modifiers: modifiers!(event),
        device: device(event),
    })
}

/// What a pointer event's pointer is.
fn device(event: &PointerEvent) -> Device {
    match event.pointer_type().as_str() {
        "touch" => Device::Touch,
        "pen" => Device::Pen,
        _ => Device::Mouse,
    }
}

/// A key going down or up.
fn keyed(event: &web_sys::Event) -> Option<Input> {
    let event = event.dyn_ref::<KeyboardEvent>()?;
    let key = match event.key().as_str() {
        "Escape" => Key::Escape,
        "Enter" => Key::Enter,
        "Delete" => Key::Delete,
        "Backspace" => Key::Backspace,
        "Home" => Key::Home,
        "Tab" => Key::Tab,
        " " => Key::Space,
        "+" | "=" => Key::Plus,
        "-" | "_" => Key::Minus,
        "ArrowLeft" => Key::Left,
        "ArrowRight" => Key::Right,
        "ArrowUp" => Key::Up,
        "ArrowDown" => Key::Down,
        "ContextMenu" => Key::Menu,
        _ => Key::Other,
    };
    Some(Input::Key { key, down: event.type_() == "keydown", modifiers: modifiers!(event) })
}
