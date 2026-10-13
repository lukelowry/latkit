//! Views in a browser: a [`Canvas`] draws a view into a `<canvas>` element.

use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{HtmlCanvasElement, ResizeObserver};

use crate::{Error, Gpu, Result, Target, View};

/// A view drawn into a `<canvas>`. The canvas sizes itself to its CSS box at the device's pixel ratio
/// and draws a frame only when the view needs one or the box changes size.
pub struct Canvas(Rc<RefCell<State>>);

struct State {
    gpu: Gpu,
    view: View,
    element: HtmlCanvasElement,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    /// The pending animation frame's id.
    scheduled: Option<i32>,
    frame: Option<Closure<dyn FnMut(f64)>>,
    resize: Option<Resize>,
}

/// Schedules a frame when the canvas's box changes size, until dropped.
struct Resize {
    observer: ResizeObserver,
    _resized: Closure<dyn FnMut(JsValue)>,
}

impl Drop for Resize {
    fn drop(&mut self) {
        self.observer.disconnect();
    }
}

impl Canvas {
    /// Draws `view` into `element`. The `Gpu` must come from [`Gpu::new`].
    pub fn new(gpu: &Gpu, element: HtmlCanvasElement, view: View) -> Result<Canvas> {
        let (Some(instance), Some(adapter)) = (gpu.instance(), gpu.adapter()) else {
            return Err(Error::Unsupported("a canvas draws with a Gpu made by Gpu::new".into()));
        };
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(element.clone()))
            .map_err(|e| Error::Unsupported(format!("no WebGPU canvas: {e}").into()))?;
        let capabilities = surface.get_capabilities(adapter);
        let format = capabilities
            .formats
            .iter()
            .copied()
            .find(|f| matches!(f, wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Rgba8Unorm))
            .or_else(|| capabilities.formats.first().copied())
            .ok_or_else(|| Error::Unsupported("the canvas offers no format".into()))?;
        let alpha_mode = if capabilities.alpha_modes.contains(&wgpu::CompositeAlphaMode::PreMultiplied) {
            wgpu::CompositeAlphaMode::PreMultiplied
        } else {
            wgpu::CompositeAlphaMode::Auto
        };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: element.width().max(1),
            height: element.height().max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode,
            view_formats: Vec::new(),
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(&gpu.0.device, &config);
        let state = Rc::new(RefCell::new(State {
            gpu: gpu.clone(),
            view,
            element,
            surface,
            config,
            scheduled: None,
            frame: None,
            resize: None,
        }));
        let weak = Rc::downgrade(&state);
        let frame = Closure::<dyn FnMut(f64)>::new(move |_: f64| {
            if let Some(state) = weak.upgrade() {
                draw(&state);
            }
        });
        let weak = Rc::downgrade(&state);
        let resized = Closure::<dyn FnMut(JsValue)>::new(move |_: JsValue| {
            if let Some(state) = weak.upgrade() {
                schedule(&state);
            }
        });
        let observer = ResizeObserver::new(resized.as_ref().unchecked_ref())
            .map_err(|_| Error::Unsupported("no ResizeObserver".into()))?;
        observer.observe(&state.borrow().element);
        {
            let mut s = state.borrow_mut();
            s.frame = Some(frame);
            s.resize = Some(Resize { observer, _resized: resized });
        }
        schedule(&state);
        Ok(Canvas(state))
    }

    /// Calls `f` with the view, then draws a frame when it needs one.
    pub fn with<R>(&self, f: impl FnOnce(&mut View) -> R) -> R {
        let result = f(&mut self.0.borrow_mut().view);
        schedule(&self.0);
        result
    }

    /// The canvas element.
    pub fn element(&self) -> HtmlCanvasElement {
        self.0.borrow().element.clone()
    }
}

impl Drop for State {
    fn drop(&mut self) {
        if let (Some(id), Some(window)) = (self.scheduled, web_sys::window()) {
            let _ = window.cancel_animation_frame(id);
        }
    }
}

fn schedule(state: &Rc<RefCell<State>>) {
    let mut s = state.borrow_mut();
    if s.scheduled.is_some() {
        return;
    }
    let (Some(window), Some(frame)) = (web_sys::window(), s.frame.as_ref()) else { return };
    s.scheduled = window.request_animation_frame(frame.as_ref().unchecked_ref()).ok();
}

fn draw(state: &Rc<RefCell<State>>) {
    let again = {
        let mut guard = state.borrow_mut();
        let s = &mut *guard;
        s.scheduled = None;
        let ratio = web_sys::window().map_or(1.0, |w| w.device_pixel_ratio());
        let width = (f64::from(s.element.client_width()) * ratio).round().max(1.0) as u32;
        let height = (f64::from(s.element.client_height()) * ratio).round().max(1.0) as u32;
        if (width, height) != (s.config.width, s.config.height) {
            s.element.set_width(width);
            s.element.set_height(height);
            s.config.width = width;
            s.config.height = height;
            s.surface.configure(&s.gpu.0.device, &s.config);
        }
        let texture = match s.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => {
                Some(texture)
            }
            _ => {
                s.surface.configure(&s.gpu.0.device, &s.config);
                None
            }
        };
        let drawn = texture.is_some();
        if let Some(texture) = texture {
            let view = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
            let target =
                Target { view: &view, format: s.config.format, size: [width, height], pixel_ratio: ratio as f32 };
            let mut encoder = s.gpu.0.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
            s.view.render(&mut encoder, &target);
            s.gpu.0.queue.submit([encoder.finish()]);
            s.gpu.0.queue.present(texture);
        }
        s.view.needs_render() || !drawn
    };
    if again {
        schedule(state);
    }
}
