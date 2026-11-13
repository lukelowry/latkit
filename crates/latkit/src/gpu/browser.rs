//! A shared WebGL2 context. Views render into retained textures; presentation copies through the
//! context's canvas into each public canvas, keeping all data and caches on one GPU context.
use crate::{Error, Result};
use wasm_bindgen::{JsCast, JsValue};

#[derive(Clone, Debug)]
pub(crate) enum Canvas {
    Element(web_sys::HtmlCanvasElement),
    Offscreen(web_sys::OffscreenCanvas),
}

impl Canvas {
    pub(crate) fn from_value(value: JsValue) -> Result<Self> {
        if let Some(canvas) = value.dyn_ref::<web_sys::HtmlCanvasElement>() {
            return Ok(Self::Element(canvas.clone()));
        }
        value
            .dyn_into::<web_sys::OffscreenCanvas>()
            .map(Self::Offscreen)
            .map_err(|_| Error::Unsupported("expected a browser canvas".into()))
    }

    pub(crate) fn size(&self) -> [u32; 2] {
        match self {
            Self::Element(canvas) => [canvas.width(), canvas.height()],
            Self::Offscreen(canvas) => [canvas.width(), canvas.height()],
        }
    }

    /// Grows the canvas to hold `size`, a power of two at a time on each side that is too small.
    /// It never shrinks. In Chrome, resizing a WebGL canvas waits until the GPU process finishes
    /// every shader compile it has queued, so the shared canvas starts at the screen's size and
    /// grows only for a view larger than that.
    pub(crate) fn reserve(&self, size: [u32; 2]) {
        let have = self.size();
        if size[0] > have[0] || size[1] > have[1] {
            let grow = |have: u32, want: u32| if want > have { want.next_power_of_two() } else { have };
            self.resize([grow(have[0], size[0]), grow(have[1], size[1])]);
        }
    }

    pub(crate) fn resize(&self, size: [u32; 2]) {
        let before = self.size();
        match self {
            Self::Element(canvas) => {
                if size[0] != before[0] {
                    canvas.set_width(size[0]);
                }
                if size[1] != before[1] {
                    canvas.set_height(size[1]);
                }
            }
            Self::Offscreen(canvas) => {
                if size[0] != before[0] {
                    canvas.set_width(size[0]);
                }
                if size[1] != before[1] {
                    canvas.set_height(size[1]);
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Sink {
    Element(web_sys::CanvasRenderingContext2d),
    Offscreen(web_sys::OffscreenCanvasRenderingContext2d),
}

impl Sink {
    pub(crate) fn new(target: wgpu::SurfaceTarget<'static>) -> Result<Self> {
        Self::on(match target {
            wgpu::SurfaceTarget::Canvas(canvas) => Canvas::Element(canvas),
            wgpu::SurfaceTarget::OffscreenCanvas(canvas) => Canvas::Offscreen(canvas),
            _ => return Err(Error::Unsupported("expected a browser canvas".into())),
        })
    }

    pub(crate) fn on(canvas: Canvas) -> Result<Self> {
        let fail = || Error::Unsupported("the canvas cannot create a presentation context".into());
        // The shared GL canvas is opaque, like the native surface. Matching the sink avoids
        // alpha conversion during every copy; transparent exports use their retained texture.
        let options = js_sys::Object::new();
        js_sys::Reflect::set(&options, &"alpha".into(), &false.into()).map_err(|_| fail())?;
        match canvas {
            Canvas::Element(canvas) => {
                let context =
                    canvas.get_context_with_context_options("2d", &options).map_err(|_| fail())?.ok_or_else(fail)?;
                let context: web_sys::CanvasRenderingContext2d = context.dyn_into().map_err(|_| fail())?;
                context.set_global_composite_operation("copy").map_err(|_| fail())?;
                Ok(Self::Element(context))
            }
            Canvas::Offscreen(canvas) => {
                let context =
                    canvas.get_context_with_context_options("2d", &options).map_err(|_| fail())?.ok_or_else(fail)?;
                let context: web_sys::OffscreenCanvasRenderingContext2d = context.dyn_into().map_err(|_| fail())?;
                context.set_global_composite_operation("copy").map_err(|_| fail())?;
                Ok(Self::Offscreen(context))
            }
        }
    }

    pub(crate) fn resize(&self, size: [u32; 2]) {
        match self {
            Self::Element(context) => Canvas::Element(context.canvas().expect("canvas context has a canvas")),
            Self::Offscreen(context) => Canvas::Offscreen(context.canvas()),
        }
        .resize(size);
    }

    pub(crate) fn copy(&self, source: &Canvas, size: [u32; 2]) -> Result<()> {
        let [width, height] = size.map(f64::from);
        let operation = match self {
            Self::Element(context) => context.set_global_composite_operation("copy"),
            Self::Offscreen(context) => context.set_global_composite_operation("copy"),
        };
        operation.map_err(|e| Error::Unsupported(format!("canvas composition failed: {e:?}").into()))?;
        let result = match (self, source) {
            (Self::Element(to), Canvas::Element(from)) => to
                .draw_image_with_html_canvas_element_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                    from, 0.0, 0.0, width, height, 0.0, 0.0, width, height,
                ),
            (Self::Element(to), Canvas::Offscreen(from)) => to
                .draw_image_with_offscreen_canvas_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                    from, 0.0, 0.0, width, height, 0.0, 0.0, width, height,
                ),
            (Self::Offscreen(to), Canvas::Element(from)) => to
                .draw_image_with_html_canvas_element_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                    from, 0.0, 0.0, width, height, 0.0, 0.0, width, height,
                ),
            (Self::Offscreen(to), Canvas::Offscreen(from)) => to
                .draw_image_with_offscreen_canvas_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                    from, 0.0, 0.0, width, height, 0.0, 0.0, width, height,
                ),
        };
        result.map_err(|e| Error::Unsupported(format!("canvas presentation failed: {e:?}").into()))
    }
}

/// The shared canvas a GPU draws through. Its WebGL2 device reports the context's loss.
pub(crate) struct Browser {
    canvas: Canvas,
}

impl Browser {
    pub(crate) fn new() -> Result<(wgpu::Instance, Self)> {
        // OffscreenCanvas can exist without supporting WebGL2. Probe the context itself, then
        // use the same renderer with a detached HTML canvas when the page supports that instead.
        let offscreen = web_sys::OffscreenCanvas::new(1, 1)
            .map_err(|_| Error::Unsupported("no offscreen canvas".into()))
            .and_then(|canvas| Self::on(Canvas::Offscreen(canvas)));
        let error = match offscreen {
            Ok(browser) => return Ok(browser),
            Err(error) => error,
        };
        let document = web_sys::window().and_then(|w| w.document()).ok_or(error)?;
        let canvas = document
            .create_element("canvas")
            .map_err(|_| Error::Unsupported("no browser canvas".into()))?
            .dyn_into()
            .map_err(|_| Error::Unsupported("no browser canvas".into()))?;
        Self::on(Canvas::Element(canvas))
    }

    fn on(canvas: Canvas) -> Result<(wgpu::Instance, Self)> {
        let options = js_sys::Object::new();
        for (key, value) in [("alpha", false), ("antialias", false), ("depth", false), ("stencil", false)] {
            js_sys::Reflect::set(&options, &key.into(), &value.into())
                .map_err(|_| Error::Unsupported("WebGL2 context options failed".into()))?;
        }
        // This canvas is a shared copy source, never a presented surface. Every copy replaces
        // its source rectangle explicitly, so automatic post-presentation clears are wasted.
        js_sys::Reflect::set(&options, &"preserveDrawingBuffer".into(), &true.into())
            .map_err(|_| Error::Unsupported("WebGL2 context options failed".into()))?;
        js_sys::Reflect::set(&options, &"powerPreference".into(), &"high-performance".into())
            .map_err(|_| Error::Unsupported("WebGL2 context options failed".into()))?;
        let context = match &canvas {
            Canvas::Element(c) => c.get_context_with_context_options("webgl2", &options),
            Canvas::Offscreen(c) => c.get_context_with_context_options("webgl2", &options),
        }
        .map_err(|_| Error::Unsupported("WebGL2 is unavailable".into()))?
        .ok_or_else(|| Error::Unsupported("WebGL2 is unavailable".into()))?
        .dyn_into::<web_sys::WebGl2RenderingContext>()
        .map_err(|_| Error::Unsupported("WebGL2 is unavailable".into()))?;
        // Size the canvas now, while the GPU process has nothing queued (see Canvas::reserve).
        canvas.reserve(screen(&context));
        let instance = super::gl::instance(context)?;
        Ok((instance, Self { canvas }))
    }

    /// Makes room on the shared canvas for a view's texture of `size`, when the texture is made.
    pub(crate) fn reserve(&self, size: [u32; 2]) {
        self.canvas.reserve(size);
    }

    /// Blits the retained texture to the shared canvas, then copies its visible region into `sink`.
    pub(crate) fn present(&mut self, queue: &wgpu::Queue, source: &wgpu::Texture, sink: &Sink) -> Result<()> {
        super::gl::present(queue, source, &self.canvas, sink)
    }
}

/// The screen's size in device pixels, at most the largest drawing buffer `gl` makes. In a worker,
/// which has no screen, one pixel: views there grow the canvas when they first present.
fn screen(gl: &web_sys::WebGl2RenderingContext) -> [u32; 2] {
    let limit = gl
        .get_parameter(web_sys::WebGl2RenderingContext::MAX_RENDERBUFFER_SIZE)
        .ok()
        .and_then(|value| value.as_f64())
        .map_or(4096, |value| value as u32);
    let screen = web_sys::window().and_then(|window| {
        let (screen, ratio) = (window.screen().ok()?, window.device_pixel_ratio());
        let side = |css: i32| (f64::from(css) * ratio).ceil().max(1.0) as u32;
        Some([side(screen.width().ok()?), side(screen.height().ok()?)])
    });
    screen.unwrap_or([1, 1]).map(|side| side.min(limit))
}
