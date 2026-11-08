use std::cell::RefCell;

use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{CanvasRenderingContext2d, HtmlCanvasElement, OffscreenCanvas, OffscreenCanvasRenderingContext2d};

use super::queue::Queue;
use super::{Encoder, Unit};
use super::{Host, Job, Raster, Request, TextRun};
use crate::Encoding;
use crate::{Error, Pending};

/// The browser host. Text is rasterized with a 2D canvas in the page's fonts, and bytes are fetched
/// with `fetch`. Jobs run on the page's workers once [`set_jobs`](Browser::set_jobs) provides them,
/// else immediately. Video is encoded with WebCodecs once [`set_encoder`](Browser::set_encoder)
/// provides an encoder. Custom markers' WGSL translates to GLSL with the translator
/// [`set_translator`](Browser::set_translator) provides, or in the page with the `wgsl` feature.
#[derive(Clone, Copy, Debug, Default)]
pub struct Browser;

thread_local! {
    static CANVAS: RefCell<Option<TextCanvas>> = const { RefCell::new(None) };
    static JOBS: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
    static QUEUE: RefCell<Queue> = RefCell::new(Queue::default());
    static ENCODERS: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
    static TRANSLATOR: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// Translates the WGSL of a custom marker's shader to GLSL with the page's translator, resolving to
/// its answer: a JSON object of each entry point's GLSL, or of the `error` that stopped it.
#[cfg(not(feature = "wgsl"))]
pub(crate) fn translate(wgsl: &str) -> Pending<String> {
    let Some(translate) = TRANSLATOR.with(|translator| translator.borrow().clone()) else {
        return Pending::ready(Err(Error::Unsupported(
            "a custom marker needs a WGSL translator in the browser: the npm package's, or latkit's `wgsl` feature"
                .into(),
        )));
    };
    let promise = match translate.call1(&JsValue::NULL, &wgsl.into()) {
        Ok(answer) => js_sys::Promise::resolve(&answer),
        Err(error) => return Pending::ready(Err(failure(&error, "the WGSL translator failed"))),
    };
    let (pending, resolver) = Pending::new();
    wasm_bindgen_futures::spawn_local(async move {
        let answer = wasm_bindgen_futures::JsFuture::from(promise).await;
        resolver.resolve(match answer {
            Ok(answer) => answer.as_string().ok_or_else(|| Error::Io("the WGSL translator answered no text".into())),
            Err(error) => Err(failure(&error, "the WGSL translator failed")),
        });
    });
    pending
}

/// How many jobs the page's workers run at once: one fewer than the number of cores, from 1 to 4.
/// The page keeps a worker for each, so it never queues.
fn workers() -> usize {
    let cores = web_sys::window()
        .map(|window| window.navigator().hardware_concurrency())
        .or_else(|| {
            js_sys::global()
                .dyn_into::<web_sys::WorkerGlobalScope>()
                .ok()
                .map(|scope| scope.navigator().hardware_concurrency())
        })
        .unwrap_or(2.0) as usize;
    cores.saturating_sub(1).clamp(1, 4)
}

/// The latkit error for a value the page's script threw or rejected with. An error whose `code` is
/// `unsupported` or `timeout` keeps that code. Anything else becomes an [`Error::Io`] saying `what`
/// failed.
fn failure(error: &JsValue, what: &str) -> Error {
    let field = |key: &str| js_sys::Reflect::get(error, &key.into()).ok().and_then(|v| v.as_string());
    let message = field("message").or_else(|| error.as_string()).unwrap_or_default();
    match field("code").as_deref() {
        Some("unsupported") => Error::Unsupported(message.into()),
        Some("timeout") => Error::Timeout,
        _ => Error::Io(format!("{what}: {message}").into()),
    }
}

/// Hands waiting jobs to the page's workers while any is free, skipping cancelled jobs.
fn pump(run: &js_sys::Function) {
    loop {
        let next = QUEUE.with(|queue| queue.borrow_mut().next(workers()));
        let Some((job, resolver)) = next else { return };
        let bytes = js_sys::Uint8Array::from(&job.into_bytes()[..]);
        let promise = run.call1(&JsValue::NULL, &bytes).map(js_sys::Promise::from);
        let run = run.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let answer = match promise {
                Ok(promise) => wasm_bindgen_futures::JsFuture::from(promise)
                    .await
                    .map(|bytes| js_sys::Uint8Array::new(&bytes).to_vec())
                    .map_err(|error| failure(&error, "a job failed")),
                Err(error) => Err(failure(&error, "a job failed")),
            };
            resolver.resolve(answer);
            QUEUE.with(|queue| queue.borrow_mut().done());
            pump(&run);
        });
    }
}

impl Browser {
    /// Runs views' jobs with `run`, which takes a job's bytes as a `Uint8Array` and returns a
    /// promise of its result's bytes. `run` should pass jobs to workers that each hold the page's
    /// compiled module. Jobs queue here, and `run` gets one only when a worker is free.
    pub fn set_jobs(run: js_sys::Function) {
        JOBS.with(|jobs| *jobs.borrow_mut() = Some(run));
    }

    /// Encodes videos with encoders made by `create(width, height, fps, bitrate)`. An encoder's
    /// `encode(nv12, time, key)` and `finish()` return promises of the units finished since the
    /// last call, in order, each `[time, key, bytes]`. Its `close()` releases its resources. The
    /// npm package provides one built on WebCodecs.
    pub fn set_encoder(create: js_sys::Function) {
        ENCODERS.with(|encoders| *encoders.borrow_mut() = Some(create));
    }

    /// Translates custom markers' shaders with `translate`, which takes WGSL and returns a promise
    /// of a JSON object of each entry point's GLSL ES 3.00, or of the `error` that stopped the
    /// translation. The npm package provides one, loaded the first time a page draws a custom
    /// marker. With the `wgsl` feature, latkit translates in the page and never calls it.
    pub fn set_translator(translate: js_sys::Function) {
        TRANSLATOR.with(|translator| *translator.borrow_mut() = Some(translate));
    }

    /// Hands over the shaders latkit's build translated for WebGL2: the bytes of `shaders.bin` in
    /// the build's output, which the npm package serves as `latkit/shaders`. A [`Gpu`](crate::Gpu)
    /// needs them, so the page loads them before creating one. Fails if the bytes are not a shader
    /// store. Later calls change nothing.
    pub fn set_shaders(bytes: Vec<u8>) -> crate::Result<()> {
        crate::gpu::store::set(bytes)
    }
}

/// An encoder made by the page. Its `encode` and `finish` return promises of units.
struct Script(JsValue);

impl Script {
    /// Calls method `name` with `args`, resolving to the units its promise returns.
    fn call(&self, name: &str, args: &js_sys::Array) -> Pending<Vec<Unit>> {
        let promise = js_sys::Reflect::get(&self.0, &name.into())
            .and_then(JsCast::dyn_into::<js_sys::Function>)
            .and_then(|f| f.apply(&self.0, args))
            .map(|answer| js_sys::Promise::resolve(&answer));
        let promise = match promise {
            Ok(promise) => promise,
            Err(error) => return Pending::ready(Err(failure(&error, "the encoder failed"))),
        };
        let (pending, resolver) = Pending::new();
        wasm_bindgen_futures::spawn_local(async move {
            let answer = wasm_bindgen_futures::JsFuture::from(promise).await;
            resolver.resolve(answer.map_err(|error| failure(&error, "the encoder failed")).and_then(units));
        });
        pending
    }
}

/// Reads the units an encoder returned, each `[time, key, bytes]`.
fn units(answer: JsValue) -> crate::Result<Vec<Unit>> {
    let units: js_sys::Array =
        answer.dyn_into().map_err(|_| Error::Io("the encoder did not return an array of units".into()))?;
    units
        .iter()
        .map(|unit| {
            let unit: js_sys::Array =
                unit.dyn_into().map_err(|_| Error::Io("an encoder unit is not an array [time, key, bytes]".into()))?;
            let time = unit.get(0).as_f64().ok_or_else(|| Error::Io("an encoder unit has no numeric time".into()))?;
            let bytes = js_sys::Uint8Array::new(&unit.get(2));
            Ok(Unit { time: time as u64, key: unit.get(1).is_truthy(), annex_b: bytes.to_vec() })
        })
        .collect()
}

impl Drop for Script {
    fn drop(&mut self) {
        if let Ok(close) = js_sys::Reflect::get(&self.0, &"close".into()).and_then(JsCast::dyn_into::<js_sys::Function>)
        {
            let _ = close.call0(&self.0);
        }
    }
}

impl Encoder for Script {
    fn encode(&mut self, nv12: Vec<u8>, time: u64, key: bool) -> Pending<Vec<Unit>> {
        let bytes = js_sys::Uint8Array::from(&nv12[..]);
        self.call("encode", &js_sys::Array::of3(&bytes, &(time as f64).into(), &key.into()))
    }

    fn finish(&mut self) -> Pending<Vec<Unit>> {
        self.call("finish", &js_sys::Array::new())
    }
}

/// Padding in pixels around each run, so antialiasing and overhangs are not clipped.
const PAD: f64 = 2.0;

/// How many times the page's or worker's fonts finished loading.
static FONTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

thread_local! {
    /// Whether a listener counts finished font loads.
    static LISTENING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// How many times fonts finished loading. The first call starts counting, and each load after it
/// requests a frame of every view, which sets its text again.
pub(super) fn fonts() -> u64 {
    if !LISTENING.replace(true) {
        let fonts = js_sys::Reflect::get(&js_sys::global(), &"fonts".into())
            .ok()
            .and_then(|fonts| fonts.dyn_into::<web_sys::EventTarget>().ok());
        if let Some(fonts) = fonts {
            let loaded = Closure::<dyn FnMut()>::new(|| {
                FONTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                crate::web::wake_all();
            });
            let _ = fonts.add_event_listener_with_callback("loadingdone", loaded.as_ref().unchecked_ref());
            loaded.forget();
        }
    }
    FONTS.load(std::sync::atomic::Ordering::Relaxed)
}

/// Breaks `text` into lines, each with its width: at each newline, then at spaces so no line is
/// wider than `max_width`. A word wider than `max_width` gets a line of its own.
fn lines(context: &TextCanvas, text: &str, max_width: Option<f64>) -> Option<Vec<(String, f64)>> {
    let width = |s: &str| context.measure_text(s).ok().map(|m| m.width());
    let mut lines: Vec<(String, f64)> = Vec::new();
    for paragraph in text.split('\n').map(|p| p.strip_suffix('\r').unwrap_or(p)) {
        let Some(max_width) = max_width else {
            lines.push((paragraph.to_owned(), width(paragraph)?));
            continue;
        };
        let first = lines.len();
        for word in paragraph.split(' ') {
            if lines.len() > first
                && let Some((line, w)) = lines.last_mut()
            {
                let joined = format!("{line} {word}");
                let joined_width = width(&joined)?;
                if joined_width <= max_width {
                    *line = joined;
                    *w = joined_width;
                    continue;
                }
            }
            lines.push((word.to_owned(), width(word)?));
        }
    }
    Some(lines)
}

/// Both browser canvas surfaces provide the same text operations. Keep layout and coverage
/// extraction shared, including on browsers with WebGL2 but no `OffscreenCanvas` or offscreen 2D.
enum TextCanvas {
    Offscreen(OffscreenCanvas, OffscreenCanvasRenderingContext2d),
    Element(HtmlCanvasElement, CanvasRenderingContext2d),
}

impl TextCanvas {
    fn new() -> Option<Self> {
        // Each run is read back after drawing, so ask for a canvas suited to readback.
        let options = js_sys::Object::new();
        js_sys::Reflect::set(&options, &"willReadFrequently".into(), &true.into()).ok()?;
        let offscreen = || {
            let canvas = OffscreenCanvas::new(256, 64).ok()?;
            let context = canvas.get_context_with_context_options("2d", &options).ok()??.dyn_into().ok()?;
            Some(Self::Offscreen(canvas, context))
        };
        offscreen().or_else(|| {
            let canvas: HtmlCanvasElement =
                web_sys::window()?.document()?.create_element("canvas").ok()?.dyn_into().ok()?;
            canvas.set_width(256);
            canvas.set_height(64);
            let context = canvas.get_context_with_context_options("2d", &options).ok()??.dyn_into().ok()?;
            Some(Self::Element(canvas, context))
        })
    }

    fn ensure_size(&self, size: [u32; 2]) {
        let grow = |width: u32, height: u32| {
            (width < size[0] || height < size[1])
                .then(|| [width.max(size[0].next_power_of_two()), height.max(size[1].next_power_of_two())])
        };
        match self {
            Self::Offscreen(canvas, _) => {
                if let Some([width, height]) = grow(canvas.width(), canvas.height()) {
                    canvas.set_width(width);
                    canvas.set_height(height);
                }
            }
            Self::Element(canvas, _) => {
                if let Some([width, height]) = grow(canvas.width(), canvas.height()) {
                    canvas.set_width(width);
                    canvas.set_height(height);
                }
            }
        }
    }

    fn set_font(&self, font: &str) {
        match self {
            Self::Offscreen(_, context) => context.set_font(font),
            Self::Element(_, context) => context.set_font(font),
        }
    }

    fn measure_text(&self, text: &str) -> Result<web_sys::TextMetrics, JsValue> {
        match self {
            Self::Offscreen(_, context) => context.measure_text(text),
            Self::Element(_, context) => context.measure_text(text),
        }
    }

    fn clear(&self, size: [u32; 2]) {
        let [width, height] = size.map(f64::from);
        match self {
            Self::Offscreen(_, context) => {
                context.set_text_baseline("alphabetic");
                context.set_fill_style_str("#fff");
                context.clear_rect(0.0, 0.0, width, height);
            }
            Self::Element(_, context) => {
                context.set_text_baseline("alphabetic");
                context.set_fill_style_str("#fff");
                context.clear_rect(0.0, 0.0, width, height);
            }
        }
    }

    fn fill_text(&self, text: &str, x: f64, y: f64) -> Result<(), JsValue> {
        match self {
            Self::Offscreen(_, context) => context.fill_text(text, x, y),
            Self::Element(_, context) => context.fill_text(text, x, y),
        }
    }

    fn image_data(&self, size: [u32; 2]) -> Result<web_sys::ImageData, JsValue> {
        let [width, height] = size.map(f64::from);
        match self {
            Self::Offscreen(_, context) => context.get_image_data(0.0, 0.0, width, height),
            Self::Element(_, context) => context.get_image_data(0.0, 0.0, width, height),
        }
    }
}

/// Calls `f` with the text canvas, created on first use.
fn with_context<R>(f: impl FnOnce(&TextCanvas) -> Option<R>) -> Option<R> {
    CANVAS.with(|cell| {
        let mut cell = cell.borrow_mut();
        if cell.is_none() {
            *cell = TextCanvas::new();
        }
        f(cell.as_ref()?)
    })
}

/// A run's layout: its lines with their widths, its ascent, and its line height.
struct Layout {
    lines: Vec<(String, f64)>,
    ascent: f64,
    line_height: f64,
}

impl Layout {
    /// Lays out `run` in `context`, setting the context's font to the run's.
    fn of(context: &TextCanvas, run: &TextRun) -> Option<Layout> {
        context.set_font(&format!("{}px {}", run.size_px, run.font));
        let lines = lines(context, &run.text, run.max_width.map(f64::from))?;
        let metrics = context.measure_text(&run.text).ok()?;
        let ascent = metrics.font_bounding_box_ascent();
        Some(Layout { lines, ascent, line_height: ascent + metrics.font_bounding_box_descent() })
    }

    /// Its width and height, including padding.
    fn size(&self) -> [f64; 2] {
        let widest = self.lines.iter().map(|(_, w)| *w).fold(0.0, f64::max);
        [widest + 2.0 * PAD, self.line_height * self.lines.len() as f64 + 2.0 * PAD]
    }
}

impl Host for Browser {
    fn spawn(&self, job: Job) -> Pending<Vec<u8>> {
        let Some(run) = JOBS.with(|jobs| jobs.borrow().clone()) else { return Pending::ready(Ok(job.run())) };
        let (pending, resolver) = Pending::new();
        QUEUE.with(|queue| queue.borrow_mut().push(job, resolver));
        pump(&run);
        pending
    }

    fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        let (pending, resolver) = Pending::new();
        let request = request.clone();
        wasm_bindgen_futures::spawn_local(async move {
            resolver.resolve(fetched(&request).await);
        });
        pending
    }

    fn rasterize(&self, run: &TextRun) -> crate::Result<Raster> {
        with_context(|context| {
            let layout = Layout::of(context, run)?;
            let size = layout.size().map(|v| v.ceil() as u32);
            context.ensure_size(size);
            // Resizing the canvas resets the context's state, so set it again.
            context.set_font(&format!("{}px {}", run.size_px, run.font));
            context.clear(size);
            for (i, (line, _)) in layout.lines.iter().enumerate() {
                context.fill_text(line, PAD, PAD + layout.ascent + layout.line_height * i as f64).ok()?;
            }
            let rgba = context.image_data(size).ok()?.data();
            let coverage = rgba.0.as_chunks::<4>().0.iter().map(|p| p[3]).collect();
            let [width, height] = layout.size().map(|side| side - 2.0 * PAD);
            let line_box = [PAD, PAD, PAD + width, PAD + height].map(|v| v as f32);
            Some(Raster { size, coverage, baseline: (PAD + layout.ascent) as f32, line_box })
        })
        .ok_or_else(|| Error::Unsupported("browser text rasterization failed".into()))
    }

    fn encoder(&self, encoding: &Encoding) -> crate::Result<Box<dyn Encoder>> {
        let unsupported =
            || Error::Unsupported("browser videos need a WebCodecs encoder, and the page provided none".into());
        let create = ENCODERS.with(|encoders| encoders.borrow().clone()).ok_or_else(unsupported)?;
        let [width, height] = encoding.size;
        let args = js_sys::Array::of4(
            &width.into(),
            &height.into(),
            &encoding.fps.into(),
            &f64::from(encoding.bitrate).into(),
        );
        let encoder =
            create.apply(&JsValue::NULL, &args).map_err(|error| failure(&error, "the encoder failed to start"))?;
        Ok(Box::new(Script(encoder)))
    }
}

/// Fetches the bytes of `request`. Returns no bytes on status 204 or 404. When a server ignores the
/// requested range and sends every byte, slices out the range.
async fn fetched(request: &Request) -> crate::Result<Vec<u8>> {
    let failed = |what: &str| Error::Io(format!("{} could not be read: {what}", request.url).into());
    let init = web_sys::RequestInit::new();
    let headers = web_sys::Headers::new().map_err(|e| failed(&format!("{e:?}")))?;
    if let Some(range) = &request.range {
        let value = format!("bytes={}-{}", range.start, range.end.saturating_sub(1));
        headers.set("Range", &value).map_err(|e| failed(&format!("{e:?}")))?;
    }
    init.set_headers(&headers);
    let fetch = web_sys::Request::new_with_str_and_init(&request.url, &init).map_err(|e| failed(&format!("{e:?}")))?;
    // Use the window's fetch, or the worker's.
    let global = js_sys::global();
    let promise = match (global.dyn_ref::<web_sys::Window>(), global.dyn_ref::<web_sys::WorkerGlobalScope>()) {
        (Some(window), _) => window.fetch_with_request(&fetch),
        (None, Some(worker)) => worker.fetch_with_request(&fetch),
        (None, None) => return Err(failed("no fetch in this context")),
    };
    let response = wasm_bindgen_futures::JsFuture::from(promise).await.map_err(|e| failed(&format!("{e:?}")))?;
    let response: web_sys::Response = response.dyn_into().map_err(|_| failed("not a response"))?;
    match response.status() {
        200 | 206 => {}
        204 | 404 => return Ok(Vec::new()),
        status => return Err(failed(&format!("HTTP status {status}"))),
    }
    let body = response.array_buffer().map_err(|e| failed(&format!("{e:?}")))?;
    let body = wasm_bindgen_futures::JsFuture::from(body).await.map_err(|e| failed(&format!("{e:?}")))?;
    let mut bytes = js_sys::Uint8Array::new(&body).to_vec();
    if response.status() == 200
        && let Some(range) = &request.range
    {
        let end = (range.end as usize).min(bytes.len());
        bytes = bytes.get(range.start as usize..end).map(<[u8]>::to_vec).unwrap_or_default();
    }
    Ok(bytes)
}
