//! Views in a browser. A [`Canvas`] draws a view into a `<canvas>` element and feeds it the element's
//! pointer, wheel, and keys. Every canvas of one [`Gpu`] draws in one animation frame, into one
//! command buffer, after the frame listeners of [`on_frame`] run: linked views always show the same
//! moment, and an application's per-frame work lands in the frame it was done for.

use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::sync::Arc;

use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{AddEventListenerOptions, HtmlCanvasElement, KeyboardEvent, PointerEvent, ResizeObserver, WheelEvent};

use crate::gpu::FORMAT;
use crate::shot::Views;
use crate::{Button, Cursor, Error, Event, Frame, Gpu, Image, Input, Key, Modifiers, Result, Shot, Video, View};

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
type EventListener = Rc<RefCell<dyn FnMut(&Event)>>;

/// The animation frames of one `Gpu`: its listeners, then every canvas that needs a frame.
struct Frames {
    gpu: Gpu,
    canvases: Vec<Weak<RefCell<State>>>,
    listeners: Vec<(u64, FrameListener)>,
    next: u64,
    scheduled: Option<i32>,
    tick: Option<Closure<dyn FnMut(f64)>>,
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
            listeners: Vec::new(),
            next: 0,
            scheduled: None,
            tick: None,
        }));
        let weak = Rc::downgrade(&frames);
        frames.borrow_mut().tick = Some(Closure::new(move |now: f64| {
            if let Some(frames) = weak.upgrade() {
                tick(&frames, now);
            }
        }));
        all.push(frames.clone());
        frames
    })
}

fn schedule(frames: &Rc<RefCell<Frames>>) {
    let mut f = frames.borrow_mut();
    if f.scheduled.is_some() {
        return;
    }
    let (Some(window), Some(tick)) = (web_sys::window(), f.tick.as_ref()) else { return };
    f.scheduled = window.request_animation_frame(tick.as_ref().unchecked_ref()).ok();
}

fn tick(frames: &Rc<RefCell<Frames>>, now: f64) {
    frames.borrow_mut().scheduled = None;
    let listeners = frames.borrow().listeners.clone();
    for (id, listener) in &listeners {
        if frames.borrow().listeners.iter().any(|(i, _)| i == id) {
            (listener.borrow_mut())(now);
        }
    }
    let (gpu, canvases) = {
        let mut f = frames.borrow_mut();
        f.canvases.retain(|c| c.strong_count() > 0);
        (f.gpu.clone(), f.canvases.iter().filter_map(Weak::upgrade).collect::<Vec<_>>())
    };
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
    for canvas in &canvases {
        dispatch(canvas);
    }
    let again = !frames.borrow().listeners.is_empty() || canvases.iter().any(|c| c.borrow().wants_frame());
    if again {
        schedule(frames);
    } else if canvases.is_empty() {
        FRAMES.with(|all| all.borrow_mut().retain(|f| !Rc::ptr_eq(f, frames)));
    }
}

/// Releases the registry's GPU and cancels its frame as soon as its final owner disappears.
fn release_idle(frames: &Rc<RefCell<Frames>>) {
    let mut f = frames.borrow_mut();
    f.canvases.retain(|c| c.strong_count() > 0);
    if !f.canvases.is_empty() || !f.listeners.is_empty() {
        return;
    }
    if let (Some(window), Some(id)) = (web_sys::window(), f.scheduled.take()) {
        let _ = window.cancel_animation_frame(id);
    }
    drop(f);
    FRAMES.with(|all| all.borrow_mut().retain(|f| !Rc::ptr_eq(f, frames)));
}

/// Asks for an animation frame of the `Gpu` whose shared state lies at `gpu`: what a view's waker does
/// when work it waited on lands, always on the page's one thread.
struct Wakes {
    gpu: usize,
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

/// A view drawn into a `<canvas>`. The canvas sizes itself to its CSS box at the device's pixel ratio,
/// draws a frame only when the view needs one or the box changes size, and passes its pointer,
/// wheel, and keys to the view.
#[derive(Clone)]
pub struct Canvas(Rc<RefCell<State>>);

struct State {
    view: View,
    element: HtmlCanvasElement,
    surface: Surface,
    frames: Rc<RefCell<Frames>>,
    /// Whether a frame was asked for since the last one.
    due: bool,
    listeners: Vec<(u64, EventListener)>,
    next: u64,
    cursor: Cursor,
    handlers: Vec<Handler>,
    resize: Option<Resizing>,
}

/// A listener of one kind of the element's events.
type Handler = (&'static str, Closure<dyn FnMut(web_sys::Event)>);
/// What follows the element's size.
type Resizing = (ResizeObserver, Closure<dyn FnMut(JsValue)>);

impl Canvas {
    /// Draws `view` into `element`. The `Gpu` must come from [`Gpu::new`]; it sets text with the
    /// browser's fonts unless it was given a host.
    pub fn new(gpu: &Gpu, element: &HtmlCanvasElement, mut view: View) -> Result<Canvas> {
        // The view sleeps while it waits; what it waits on asks for the next frame as it lands.
        view.set_waker(std::task::Waker::from(Arc::new(Wakes { gpu: Arc::as_ptr(&gpu.0) as usize })));
        if gpu.0.lock().host.is_none() {
            gpu.set_host(crate::host::Browser);
        }
        let size = [element.width(), element.height()];
        let surface = Surface::new(gpu, element, size)?;
        let _ = element.style().set_property("touch-action", "none");
        let frames = frames_of(gpu);
        let state = Rc::new(RefCell::new(State {
            view,
            element: element.clone(),
            surface,
            frames: frames.clone(),
            due: true,
            listeners: Vec::new(),
            next: 0,
            cursor: Cursor::Default,
            handlers: Vec::new(),
            resize: None,
        }));
        frames.borrow_mut().canvases.push(Rc::downgrade(&state));
        let weak = Rc::downgrade(&state);
        let resized = Closure::<dyn FnMut(JsValue)>::new(move |_: JsValue| {
            if let Some(state) = weak.upgrade() {
                state.borrow_mut().due = true;
                schedule(&state.borrow().frames);
            }
        });
        let observer = ResizeObserver::new(resized.as_ref().unchecked_ref())
            .map_err(|_| Error::Unsupported("no ResizeObserver".into()))?;
        observer.observe(element);
        state.borrow_mut().resize = Some((observer, resized));
        listen(&state)?;
        schedule(&frames);
        Ok(Canvas(state))
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

    /// Calls `listener` with each of the view's events until the returned listener is dropped.
    pub fn on(&self, listener: impl FnMut(&Event) + 'static) -> Listener {
        let id = {
            let mut s = self.0.borrow_mut();
            s.next += 1;
            let id = s.next;
            s.listeners.push((id, Rc::new(RefCell::new(listener))));
            id
        };
        let weak = Rc::downgrade(&self.0);
        Listener(Some(Box::new(move || {
            if let Some(state) = weak.upgrade() {
                state.borrow_mut().listeners.retain(|(i, _)| *i != id);
            }
        })))
    }

    /// The canvas element.
    pub fn element(&self) -> HtmlCanvasElement {
        self.0.borrow().element.clone()
    }
}

impl State {
    /// Whether a frame is due; never while a shot draws the view, which the canvas holds its last
    /// frame for.
    fn wants_frame(&self) -> bool {
        !self.view.lent() && (self.due || self.view.needs_render())
    }

    /// Records a frame when one is needed, sizing the canvas to its box first.
    fn record(&mut self, encoder: &mut wgpu::CommandEncoder, time: f64) -> Option<wgpu::SurfaceTexture> {
        let ratio = web_sys::window().map_or(1.0, |w| w.device_pixel_ratio());
        let width = (f64::from(self.element.client_width()) * ratio).round().max(1.0) as u32;
        let height = (f64::from(self.element.client_height()) * ratio).round().max(1.0) as u32;
        let resized = [width, height] != self.surface.size();
        if self.view.lent() || !(resized || self.wants_frame()) {
            return None;
        }
        if resized {
            self.element.set_width(width);
            self.element.set_height(height);
        }
        let texture = self.surface.draw(encoder, &mut self.view, [width, height], ratio as f32, time);
        self.due = texture.is_none();
        texture
    }
}

/// A canvas's surface: in the one format views draw in wherever the browser offers it, so canvases and
/// shots share their pipelines; alpha premultiplied; configured again whenever its size changes.
struct Surface {
    gpu: Gpu,
    raw: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
}

impl Surface {
    /// The surface of `element`, `size` pixels, drawn with `gpu`, which must come from [`Gpu::new`].
    fn new(gpu: &Gpu, element: &HtmlCanvasElement, size: [u32; 2]) -> Result<Surface> {
        let (Some(instance), Some(adapter)) = (gpu.instance(), gpu.adapter()) else {
            return Err(Error::Unsupported("a canvas draws with a Gpu made by Gpu::new".into()));
        };
        let raw = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(element.clone()))
            .map_err(|e| Error::Unsupported(format!("no WebGPU canvas: {e}").into()))?;
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
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
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

    /// Records a frame of `view` at `size` pixels, `pixel_ratio` of them a CSS pixel, at `time`,
    /// configuring the surface again first when its size changed: the texture to present once the
    /// encoder is submitted, or `None` when the surface had none to give, which a later frame tries
    /// again.
    fn draw(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        view: &mut View,
        size: [u32; 2],
        pixel_ratio: f32,
        time: f64,
    ) -> Option<wgpu::SurfaceTexture> {
        let size = size.map(|v| v.max(1));
        if size != self.size() {
            [self.config.width, self.config.height] = size;
            self.raw.configure(self.gpu.device(), &self.config);
        }
        let (wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture)) =
            self.raw.get_current_texture()
        else {
            self.raw.configure(self.gpu.device(), &self.config);
            return None;
        };
        let target = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
        view.render(encoder, &Frame { target: &target, format: self.config.format, size, pixel_ratio, time });
        Some(texture)
    }
}

/// The views of canvases, lent to a shot a step at a time, so the page reads them between steps.
struct Canvases<'a>(&'a [Canvas]);

impl Canvases<'_> {
    /// The canvases, each once.
    fn of(canvases: &[Canvas]) -> Result<Canvases<'_>> {
        let twice = canvases.iter().enumerate().any(|(i, a)| canvases[i + 1..].iter().any(|b| Rc::ptr_eq(&a.0, &b.0)));
        if twice {
            return Err(Error::invalid("a shot draws each canvas's view in one panel"));
        }
        Ok(Canvases(canvases))
    }
}

impl Views for Canvases<'_> {
    fn lend<R>(&mut self, f: impl FnOnce(&mut [&mut View]) -> R) -> R {
        let mut states: Vec<std::cell::RefMut<'_, State>> = self.0.iter().map(|c| c.0.borrow_mut()).collect();
        let mut views: Vec<&mut View> = states.iter_mut().map(|s| &mut s.view).collect();
        f(&mut views)
    }
}

/// The picture `shot` takes of the views of `canvases`, one per panel, once they are complete and
/// still. The canvases hold their last frames meanwhile.
pub async fn image(shot: &Shot, canvases: &[Canvas]) -> Result<Image> {
    shot.image_of(&mut Canvases::of(canvases)?).await
}

/// Draws `video`'s next frame of the views of `canvases`, one per panel. The canvases hold their last
/// frames until the video is finished or dropped.
pub async fn frame<W: std::io::Write>(video: &mut Video<W>, canvases: &[Canvas]) -> Result<()> {
    video.frame_of(&mut Canvases::of(canvases)?).await
}

/// Hands the view's events to the canvas's listeners, and shows the cursor it asks for.
fn dispatch(state: &Rc<RefCell<State>>) {
    let (events, listeners) = {
        let mut s = state.borrow_mut();
        let events: Vec<Event> = s.view.events().collect();
        let cursor = s.view.cursor();
        if cursor != s.cursor {
            s.cursor = cursor;
            let css = match cursor {
                Cursor::Default => "",
                Cursor::Pointer => "pointer",
                Cursor::Grab => "grab",
                Cursor::Grabbing => "grabbing",
                Cursor::Crosshair => "crosshair",
            };
            let _ = s.element.style().set_property("cursor", css);
        }
        (events, s.listeners.clone())
    };
    for event in &events {
        for (id, listener) in &listeners {
            if state.borrow().listeners.iter().any(|(i, _)| i == id) {
                (listener.borrow_mut())(event);
            }
        }
    }
}

impl Drop for State {
    fn drop(&mut self) {
        for (kind, handler) in &self.handlers {
            let _ = self.element.remove_event_listener_with_callback(kind, handler.as_ref().unchecked_ref());
        }
        if let Some((observer, _)) = &self.resize {
            observer.disconnect();
        }
        release_idle(&self.frames);
    }
}

/// Feeds the element's pointer, wheel, and keys to the view.
fn listen(state: &Rc<RefCell<State>>) -> Result<()> {
    let element = state.borrow().element.clone();
    let add = |kind: &'static str, handle: fn(&HtmlCanvasElement, &web_sys::Event) -> Option<Input>| {
        let weak = Rc::downgrade(state);
        let target = element.clone();
        let handler = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            let Some(state) = weak.upgrade() else { return };
            let Some(input) = handle(&target, &event) else { return };
            let used = state.borrow_mut().view.input(&input, event.time_stamp() / 1000.0);
            // A wheel the view zooms with does not scroll the page; a key it uses does not either.
            if used && matches!(kind, "wheel" | "keydown") {
                event.prevent_default();
            }
            state.borrow_mut().due = true;
            let frames = state.borrow().frames.clone();
            schedule(&frames);
            dispatch(&state);
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
        touch: event.pointer_type() == "touch",
    })
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
