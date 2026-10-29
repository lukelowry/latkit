//! Views in a browser.
//!
//! A [`PageView`] is a view owned by the page. The page reads and changes it, listens to its
//! events, and lends it to shots, whether or not a canvas shows it. A [`Canvas`] shows views in
//! the panels of its layout, in a `<canvas>` element or in an `OffscreenCanvas` in a worker. It
//! feeds each view the pointer, wheel, and key input for its panel.
//!
//! Every canvas of one [`Gpu`] draws in the same animation frame and command buffer, after the
//! [`on_frame`] listeners run. So linked views always show the same moment, and an application's
//! per-frame work appears in the frame it was done for.

use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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
    /// Keeps the listener running for as long as its source lives, instead of stopping it on drop.
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

/// The animation frames of one `Gpu`. Each frame runs the listeners, then draws every canvas that
/// needs a frame, then dispatches each view's events.
struct Frames {
    gpu: Gpu,
    canvases: Vec<Weak<RefCell<Painted>>>,
    views: Vec<Weak<RefCell<Held>>>,
    listeners: Vec<(u64, FrameListener)>,
    next: u64,
    scheduled: Option<i32>,
    /// Whether a harness steps the frames itself with [`step`], so no animation frame is requested.
    stepped: bool,
    /// Wakers of [`landed`] futures, woken whenever a frame is requested, and the number of such
    /// wakes.
    landing: Vec<std::task::Waker>,
    wakes: u64,
    tick: Option<Closure<dyn FnMut(f64)>>,
    /// The page's `prefers-reduced-motion` query, passed to each view, and the closure that
    /// requests a frame when it changes. `None` in a worker.
    reduced: Option<(web_sys::MediaQueryList, Closure<dyn FnMut()>)>,
}

thread_local! {
    static FRAMES: RefCell<Vec<Rc<RefCell<Frames>>>> = const { RefCell::new(Vec::new()) };
}

/// Set once a panic stops latkit. A panic aborts wherever it happens, so the state it left borrowed
/// or half changed can't be used again. Frames, input, and wakes then do nothing.
static STOPPED: AtomicBool = AtomicBool::new(false);

/// Stops latkit after a panic: no frame, input, or wake reaches a view again. A panic hook calls it
/// before the panic aborts.
pub fn stop() {
    STOPPED.store(true, Ordering::Relaxed);
}

/// Whether a panic stopped latkit.
pub fn stopped() -> bool {
    STOPPED.load(Ordering::Relaxed)
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

/// The page's or worker's global scope, which provides animation frames.
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

/// Requests an animation frame, unless one is already requested, a harness steps the frames, or a
/// panic stopped latkit. Also wakes every [`landed`] future.
fn schedule(frames: &Rc<RefCell<Frames>>) {
    if stopped() {
        return;
    }
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
    if stopped() {
        return;
    }
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
    // A lost device draws nothing. Each view reports the loss, so the page can replace the device.
    if gpu.lost() {
        for view in &views {
            view.0.borrow_mut().view.tell_lost();
            view.dispatch();
        }
        return;
    }
    let reduced = frames.borrow().reduced.as_ref().is_some_and(|(query, _)| query.matches());
    for view in &views {
        view.0.borrow_mut().view.set_reduced_motion(reduced);
    }
    let mut encoder = gpu.device().create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("latkit") });
    let shown: Vec<wgpu::SurfaceTexture> =
        canvases.iter().filter_map(|c| c.borrow_mut().record(&mut encoder, now / 1000.0)).collect();
    // A frame in which no canvas drew submits nothing. Listeners alone still keep frames coming.
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

/// Removes the `Gpu`'s frames from the registry and cancels its requested frame once no canvas,
/// view, or listener remains.
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

/// A view's waker. When work the view waited on arrives, it requests an animation frame of the
/// `Gpu` whose shared state is at address `gpu`, and wakes its [`landed`] futures. It always runs
/// on the page's single thread.
struct Wakes {
    gpu: usize,
}

/// A waker that, when work arrives, requests a frame of `gpu` and wakes its [`landed`] futures.
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

/// Calls `listener` every animation frame, before `gpu`'s canvases draw, with the frame's timestamp
/// in milliseconds as `requestAnimationFrame` gives it. Stops when the returned [`Listener`] is
/// dropped.
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

/// Draws one frame of `gpu` immediately, with `now` as its timestamp in milliseconds. Runs the
/// frame listeners, draws every canvas that needs a frame, then dispatches the views' events.
///
/// After the first call, `gpu` requests no animation frames. The harness steps every frame itself,
/// so a run draws the same frames regardless of device speed, and arriving work only wakes
/// [`landed`].
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

/// Waits until work a view of `gpu` depends on arrives after this call, such as a readback,
/// compile, job, text, or fetch, or until a view requests a frame. Arrivals between this call and
/// the first poll count, so a harness may change a view right after calling it.
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

/// Waits until `gpu` has finished its submitted work, mapped every readback, and compiled every
/// requested pipeline. A frame stepped afterwards draws all the results.
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

/// A view owned by the page, which reads and changes it, listens to its events, shows it in a
/// canvas, and lends it to shots. Changing it requests a frame.
#[derive(Clone)]
pub struct PageView(Rc<RefCell<Held>>);

struct Held {
    view: View,
    frames: Rc<RefCell<Frames>>,
    /// Whether the view changed since it last drew.
    due: bool,
    listeners: Vec<(u64, EventListener)>,
    next: u64,
}

impl PageView {
    /// Wraps `view` for the page. Its `Gpu` must come from [`Gpu::new`]. Unless the `Gpu` already
    /// has a host, text is set with the browser's fonts.
    pub fn new(mut view: View) -> PageView {
        let gpu = view.gpu().clone();
        // The view sleeps while it waits. The work it waits on requests the next frame on arrival.
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

    /// Calls `f` with the view, then requests a frame to draw any change.
    pub fn with<R>(&self, f: impl FnOnce(&mut View) -> R) -> R {
        let result = f(&mut self.0.borrow_mut().view);
        self.0.borrow_mut().due = true;
        let frames = self.0.borrow().frames.clone();
        schedule(&frames);
        result
    }

    /// Calls `f` with the view to read it, without requesting a frame.
    pub fn read<R>(&self, f: impl FnOnce(&View) -> R) -> R {
        f(&self.0.borrow().view)
    }

    /// The GPU the view draws with.
    pub fn gpu(&self) -> Gpu {
        self.0.borrow().view.gpu().clone()
    }

    /// Calls `listener` with the view's events, in order, one batch per call, until the returned
    /// [`Listener`] is dropped. A listener receives only the events sent while it listens. Read
    /// lasting state from the view itself.
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

    /// Sends the view's pending events to its listeners as one batch.
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

    /// Whether it needs a frame and is not lent to a shot: it changed, or its view wants one. While
    /// its pipelines compile, a change waits until they finish.
    pub fn wants_frame(&self) -> bool {
        let held = self.0.borrow();
        !held.view.lent() && (held.view.wants_frame() || (held.due && !held.view.compiling()))
    }

    /// Whether it can draw into `format` at `pixel_ratio`: see [`View::ready`].
    fn ready(&self, format: wgpu::TextureFormat, pixel_ratio: f32) -> bool {
        self.0.borrow_mut().view.ready(format, pixel_ratio)
    }

    /// Whether it is lent to a shot.
    fn lent(&self) -> bool {
        self.0.borrow().view.lent()
    }
}

/// A view's panel in a canvas. Later panels draw over earlier ones.
#[derive(Clone)]
pub struct Panel {
    /// The view shown.
    pub view: PageView,
    /// Where it draws: `[x, y, width, height]` as fractions of the canvas, from its top left.
    pub at: [f32; 4],
}

/// Views shown in a `<canvas>` element or an `OffscreenCanvas`, in the panels of its layout.
///
/// An element canvas sizes itself to its CSS box at the device pixel ratio, and passes each view
/// the pointer, wheel, and key input for its panel. An offscreen canvas keeps the size it is given
/// and takes no input. A frame redraws only the views that need it, or all of them when the canvas
/// changes size or layout.
#[derive(Clone)]
pub struct Canvas(Rc<RefCell<Painted>>);

/// The canvas a [`Canvas`] draws into: an element, or an offscreen canvas and its pixel ratio.
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
    /// Each panel's texture and its size, used when the canvas shows several views.
    textures: Vec<Option<(wgpu::Texture, [u32; 2])>>,
    /// Each panel in CSS pixels as last drawn, used to route input.
    rects: Vec<[f32; 4]>,
    /// Whether every view draws in the next frame, because the canvas changed size or layout.
    due: bool,
    /// The panel that captured each pressed pointer, the panel under the pointer, and the panel
    /// that receives keys.
    captured: Vec<(u32, usize)>,
    hovered: Option<usize>,
    focus: usize,
    /// When a pointer was last released, in milliseconds on the events' clock.
    released: f64,
    cursor: Cursor,
    handlers: Vec<Handler>,
    resize: Option<Resizing>,
}

/// A listener for one kind of element event.
type Handler = (&'static str, Closure<dyn FnMut(web_sys::Event)>);
/// The observer that tracks the element's size, and its callback.
type Resizing = (ResizeObserver, Closure<dyn FnMut(JsValue)>);

impl Canvas {
    /// A canvas showing the views of `layout` in `element`. The `Gpu` must come from [`Gpu::new`].
    pub fn new(gpu: &Gpu, element: &HtmlCanvasElement, layout: Vec<Panel>) -> Result<Canvas> {
        let size = [element.width(), element.height()];
        let surface = Surface::new(gpu, wgpu::SurfaceTarget::Canvas(element.clone()), size)?;
        let _ = element.style().set_property("touch-action", "none");
        // Make the element focusable so keys reach the views directly.
        if !element.has_attribute("tabindex") {
            element.set_tab_index(0);
        }
        let canvas = Canvas::with_target(gpu, Target::Element(element.clone()), surface);
        canvas.set_layout(layout)?;
        let weak = Rc::downgrade(&canvas.0);
        let resized = Closure::<dyn FnMut(JsValue)>::new(move |_: JsValue| {
            let Some(state) = weak.upgrade().filter(|_| !stopped()) else { return };
            state.borrow_mut().due = true;
            schedule(&state.borrow().frames);
        });
        let observer = ResizeObserver::new(resized.as_ref().unchecked_ref())
            .map_err(|_| Error::Unsupported("no ResizeObserver".into()))?;
        observer.observe(element);
        canvas.0.borrow_mut().resize = Some((observer, resized));
        listen(&canvas.0, element)?;
        Ok(canvas)
    }

    /// A canvas showing the views of `layout` in `canvas`, at `pixel_ratio` pixels per CSS pixel.
    /// Use it in a worker, or wherever the page does not feed it input. It keeps the size it is
    /// given.
    pub fn offscreen(gpu: &Gpu, canvas: &OffscreenCanvas, layout: Vec<Panel>, pixel_ratio: f32) -> Result<Canvas> {
        if !(pixel_ratio.is_finite() && pixel_ratio > 0.0) {
            return Err(Error::invalid("a canvas's pixel ratio must be positive").at("pixelRatio"));
        }
        let size = [canvas.width(), canvas.height()];
        let surface = Surface::new(gpu, wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()), size)?;
        let target = Target::Offscreen { canvas: canvas.clone(), pixel_ratio };
        let made = Canvas::with_target(gpu, target, surface);
        made.set_layout(layout)?;
        Ok(made)
    }

    fn with_target(gpu: &Gpu, target: Target, surface: Surface) -> Canvas {
        let frames = frames_of(gpu);
        let state = Rc::new(RefCell::new(Painted {
            target,
            surface,
            frames: frames.clone(),
            panels: Panels::default(),
            views: Vec::new(),
            textures: Vec::new(),
            rects: Vec::new(),
            due: true,
            captured: Vec::new(),
            hovered: None,
            focus: 0,
            released: f64::NEG_INFINITY,
            cursor: Cursor::Default,
            handlers: Vec::new(),
            resize: None,
        }));
        frames.borrow_mut().canvases.push(Rc::downgrade(&state));
        schedule(&frames);
        Canvas(state)
    }

    /// Replaces the shown views with those of `layout`. A view shows in one panel of one canvas
    /// at a time. Fails if a view repeats or shows in another canvas, or a panel covers no pixels.
    pub fn set_layout(&self, layout: Vec<Panel>) -> Result<()> {
        let views: Vec<&PageView> = layout.iter().map(|panel| &panel.view).collect();
        let twice = views.iter().enumerate().any(|(i, a)| views[i + 1..].iter().any(|b| Rc::ptr_eq(&a.0, &b.0)));
        let frames = self.0.borrow().frames.clone();
        let elsewhere = frames.borrow().canvases.iter().filter_map(Weak::upgrade).any(|other| {
            !Rc::ptr_eq(&other, &self.0)
                && other.borrow().views.iter().any(|shown| views.iter().any(|v| Rc::ptr_eq(&v.0, &shown.0)))
        });
        if twice || elsewhere {
            return Err(Error::invalid("a view can show in only one panel of one canvas").at("layout"));
        }
        let panels = Panels::from(layout.iter().map(|panel| panel.at).collect::<Vec<_>>());
        panels.rects([1 << 16, 1 << 16], [1, 1]).map_err(|e| e.at("layout"))?;
        let mut state = self.0.borrow_mut();
        state.panels = panels;
        state.views = layout.into_iter().map(|panel| panel.view).collect();
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

    /// The canvas's size in CSS pixels: its pixels over its pixels per CSS pixel. Zero while it
    /// has no box.
    pub fn css_size(&self) -> [f32; 2] {
        self.0.borrow().measure().map_or([0.0; 2], |(size, ratio)| size.map(|side| side as f32 / ratio))
    }
}

impl Painted {
    /// The canvas's size in pixels, and its pixels per CSS pixel. `None` while it has no box, as
    /// when it or a parent is `display: none`.
    fn measure(&self) -> Option<([u32; 2], f32)> {
        let (size, ratio) = match &self.target {
            Target::Element(element) => {
                let ratio = web_sys::window().map_or(1.0, |w| w.device_pixel_ratio());
                let side = |css: i32| (f64::from(css) * ratio).round().max(0.0) as u32;
                ([side(element.client_width()), side(element.client_height())], ratio as f32)
            }
            Target::Offscreen { canvas, pixel_ratio } => ([canvas.width(), canvas.height()], *pixel_ratio),
        };
        (size[0] > 0 && size[1] > 0).then_some((size, ratio))
    }

    /// Whether a frame is due: the canvas changed, or a view it shows wants to draw. Never while
    /// the canvas has no box, since its views have nothing to draw into until the resize observer
    /// sees one, and never while every view it shows is lent to a shot, since it keeps their last
    /// frames.
    fn wants_frame(&self) -> bool {
        self.measure().is_some()
            && self.views.iter().any(|v| !v.lent())
            && (self.due || self.views.iter().any(PageView::wants_frame))
    }

    /// Records a frame if one is needed, first sizing the canvas to its CSS box. Each view that
    /// needs to draw renders into its panel, or straight into the canvas when one view fills it. A
    /// view lent to a shot, or whose pipelines still compile, keeps its panel's previous contents.
    /// While no view can draw, or the canvas has no box, the canvas keeps its current frame. Its
    /// views then derive, sync, and fit nothing.
    fn record(&mut self, encoder: &mut wgpu::CommandEncoder, time: f64) -> Option<wgpu::SurfaceTexture> {
        let (size, ratio) = self.measure()?;
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
                let (panel, _) = self.textures[i].as_ref().expect("the panel texture exists");
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

    /// Sets the element's cursor to the one the view under the pointer requests.
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

    /// The panels `input` goes to, each with the input in that panel's CSS pixels. A pressed
    /// pointer goes to the panel it pressed until release. Otherwise it goes to the panel under
    /// it, which receives a leave when the pointer moves off. Keys go to the panel pressed last.
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

    /// Each panel in CSS pixels at the canvas's current size, used before the first frame records
    /// them.
    fn css_rects(&self) -> Vec<[f32; 4]> {
        let Some((size, ratio)) = self.measure() else { return Vec::new() };
        self.panels.rects(size, [1, 1]).map(|rects| rects.iter().map(|r| css(*r, ratio)).collect()).unwrap_or_default()
    }
}

/// `rect` in CSS pixels: x, y, width, height.
fn css(rect: Rect, ratio: f32) -> [f32; 4] {
    let [x, y] = rect.origin.map(|v| v as f32 / ratio);
    let [w, h] = rect.size.map(|v| v as f32 / ratio);
    [x, y, w, h]
}

/// `input` with its point made relative to `origin`, its panel's top left.
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

/// A panel's texture. A view draws into it, and the canvas copies it into place.
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

/// A canvas's surface. It uses the views' standard format when the browser offers it, so canvases
/// and shots share pipelines. Alpha is premultiplied where supported, panels are copied in, and the
/// surface is reconfigured whenever its size changes.
struct Surface {
    gpu: Gpu,
    raw: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
}

impl Surface {
    /// Creates the surface of `target` at `size` pixels. `gpu` must come from [`Gpu::new`].
    fn new(gpu: &Gpu, target: wgpu::SurfaceTarget<'static>, size: [u32; 2]) -> Result<Surface> {
        let (Some(instance), Some(adapter)) = (gpu.instance(), gpu.adapter()) else {
            return Err(Error::Unsupported("a canvas needs a Gpu created by Gpu::new".into()));
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
                .ok_or_else(|| Error::Unsupported("the canvas supports no texture format".into()))?
        };
        let alpha_mode = if capabilities.alpha_modes.contains(&wgpu::CompositeAlphaMode::PreMultiplied) {
            wgpu::CompositeAlphaMode::PreMultiplied
        } else {
            wgpu::CompositeAlphaMode::Auto
        };
        // Panels are drawn separately and copied in. A WebGPU canvas accepts copies, regardless of
        // what wgpu reports.
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

    /// Width and height in pixels, as last configured.
    fn size(&self) -> [u32; 2] {
        [self.config.width, self.config.height]
    }

    /// The texture for a frame of `size` pixels, reconfiguring the surface first if its size
    /// changed. `None` if the surface has no texture available. A later frame tries again.
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

/// Page views lent to a shot one step at a time, so the page can read them between steps and
/// receives each step's events.
struct Lending<'a>(&'a [PageView]);

impl Lending<'_> {
    /// Lends `views`. Fails if a view appears twice.
    fn of(views: &[PageView]) -> Result<Lending<'_>> {
        let twice = views.iter().enumerate().any(|(i, a)| views[i + 1..].iter().any(|b| Rc::ptr_eq(&a.0, &b.0)));
        if twice {
            return Err(Error::invalid("a view can appear in only one panel of a shot"));
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

/// Takes `shot`'s picture of `views`, one per panel, when they are complete, as its
/// [`Capture`](crate::Capture) says. Canvases showing them keep their last frames meanwhile.
pub async fn image(shot: &Shot, views: &[PageView]) -> Result<Image> {
    shot.image_of(&mut Lending::of(views)?).await
}

/// Draws `video`'s next frame of `views`, one per panel. Canvases showing them keep their last
/// frames until the video is finished or dropped.
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

/// Feeds the element's pointer, wheel, and key events to the views of the panels they target.
fn listen(state: &Rc<RefCell<Painted>>, element: &HtmlCanvasElement) -> Result<()> {
    let add = |kind: &'static str, handle: fn(&HtmlCanvasElement, &web_sys::Event) -> Option<Input>| {
        let weak = Rc::downgrade(state);
        let target = element.clone();
        let handler = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            let Some(state) = weak.upgrade().filter(|_| !stopped()) else { return };
            if matches!(kind, "pointerup" | "pointercancel") {
                state.borrow_mut().released = event.time_stamp();
            }
            // The page asks for a menu with `contextmenu`, which also follows a secondary click, a
            // Control-click on Apple platforms, and a held touch. Their gestures already open menus,
            // so only a `contextmenu` no pointer caused reaches the views: Shift+F10, the menu key,
            // or a screen reader's command.
            if kind == "contextmenu" {
                event.prevent_default();
                let state = state.borrow();
                if !state.captured.is_empty() || event.time_stamp() - state.released < POINTER_MENU {
                    return;
                }
            }
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
            // A wheel or key event a view used must not also scroll the page.
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
            .map_err(|_| Error::Unsupported("cannot listen for input on the canvas".into()))?;
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
        let event = event.dyn_ref::<web_sys::MouseEvent>()?;
        Some(Input::Key { key: Key::Menu, down: true, modifiers: modifiers!(event) })
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

/// The modifier keys a key or mouse event reports as held.
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

/// Milliseconds after a pointer's release in which a `contextmenu` is taken as caused by it.
const POINTER_MENU: f64 = 100.0;

/// Whether the page runs on an Apple platform, where Control with the primary mouse button is the
/// secondary button.
fn apple() -> bool {
    thread_local! {
        static APPLE: bool = web_sys::window()
            .and_then(|window| window.navigator().platform().ok())
            .is_some_and(|platform| platform.starts_with("Mac") || platform.starts_with("iP"));
    }
    APPLE.with(|apple| *apple)
}

/// Reads a pointer press, focusing the element and capturing the pointer. On Apple platforms a
/// Control press of the primary mouse button is a secondary press without Control, so it opens a
/// menu or turns the camera as a right press does.
fn pressed(element: &HtmlCanvasElement, event: &web_sys::Event) -> Option<Input> {
    let event = event.dyn_ref::<PointerEvent>()?;
    let mut modifiers = modifiers!(event);
    let button = match event.button() {
        0 if modifiers.control && device(event) == Device::Mouse && apple() => {
            modifiers.control = false;
            Button::Secondary
        }
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
        modifiers,
        device: device(event),
    })
}

/// The kind of device behind a pointer event.
fn device(event: &PointerEvent) -> Device {
    match event.pointer_type().as_str() {
        "touch" => Device::Touch,
        "pen" => Device::Pen,
        _ => Device::Mouse,
    }
}

/// Reads a key press or release.
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
        _ => Key::Other,
    };
    Some(Input::Key { key, down: event.type_() == "keydown", modifiers: modifiers!(event) })
}
