use std::cell::RefCell;

use wasm_bindgen::{JsCast, JsValue};
use web_sys::{OffscreenCanvas, OffscreenCanvasRenderingContext2d};

use super::{Host, Job, Raster, TextRun};
use crate::{Error, Pending};

/// The browser: text set with a 2D canvas in the page's fonts, and jobs done by the page's workers
/// once [`set_jobs`](Browser::set_jobs) names them, else at once.
#[derive(Clone, Copy, Debug, Default)]
pub struct Browser;

thread_local! {
    static CANVAS: RefCell<Option<(OffscreenCanvas, OffscreenCanvasRenderingContext2d)>> = const { RefCell::new(None) };
    static JOBS: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

impl Browser {
    /// Has views' jobs done by `run`, which takes a job's bytes as a `Uint8Array` and returns a
    /// promise of its answer's: a pool of workers, each holding the page's compiled module.
    pub fn set_jobs(run: js_sys::Function) {
        JOBS.with(|jobs| *jobs.borrow_mut() = Some(run));
    }
}

/// Pixels of room around each run, so antialiasing and overhangs are kept.
const PAD: f64 = 2.0;

/// `text` broken at spaces into lines no wider than `max_width`, each with its width.
fn lines(
    context: &OffscreenCanvasRenderingContext2d,
    text: &str,
    max_width: Option<f64>,
) -> Option<Vec<(String, f64)>> {
    let width = |s: &str| context.measure_text(s).ok().map(|m| m.width());
    let Some(max_width) = max_width else { return Some(vec![(text.to_owned(), width(text)?)]) };
    let mut lines: Vec<(String, f64)> = Vec::new();
    for word in text.split(' ') {
        if let Some((line, w)) = lines.last_mut() {
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
    Some(lines)
}

/// The page's 2D context for setting and measuring text, made on first use.
fn with_context<R>(f: impl FnOnce(&OffscreenCanvas, &OffscreenCanvasRenderingContext2d) -> Option<R>) -> Option<R> {
    CANVAS.with(|cell| {
        let mut cell = cell.borrow_mut();
        if cell.is_none() {
            let canvas = OffscreenCanvas::new(256, 64).ok()?;
            // Each run is read back once it is set.
            let options = js_sys::Object::new();
            js_sys::Reflect::set(&options, &"willReadFrequently".into(), &true.into()).ok()?;
            let context = canvas.get_context_with_context_options("2d", &options).ok()??;
            let context = context.dyn_into::<OffscreenCanvasRenderingContext2d>().ok()?;
            *cell = Some((canvas, context));
        }
        let (canvas, context) = cell.as_ref()?;
        f(canvas, context)
    })
}

/// A run laid out: its lines, each with its width, and its ascent and line height.
struct Layout {
    lines: Vec<(String, f64)>,
    ascent: f64,
    line_height: f64,
}

impl Layout {
    /// `run` laid out in `context`, set to its font.
    fn of(context: &OffscreenCanvasRenderingContext2d, run: &TextRun) -> Option<Layout> {
        context.set_font(&format!("{}px {}", run.size_px, run.font));
        let lines = lines(context, &run.text, run.max_width.map(f64::from))?;
        let metrics = context.measure_text(&run.text).ok()?;
        let ascent = metrics.font_bounding_box_ascent();
        Some(Layout { lines, ascent, line_height: ascent + metrics.font_bounding_box_descent() })
    }

    /// Its width and height, with room around it.
    fn size(&self) -> [f64; 2] {
        let widest = self.lines.iter().map(|(_, w)| *w).fold(0.0, f64::max);
        [widest + 2.0 * PAD, self.line_height * self.lines.len() as f64 + 2.0 * PAD]
    }
}

impl Host for Browser {
    fn measure(&self, run: &TextRun) -> Option<[f32; 2]> {
        with_context(|_, context| Some(Layout::of(context, run)?.size().map(|v| v as f32)))
    }

    fn spawn(&self, job: Job) -> Pending<Vec<u8>> {
        let Some(run) = JOBS.with(|jobs| jobs.borrow().clone()) else { return Pending::ready(Ok(job.run())) };
        let bytes = js_sys::Uint8Array::from(&job.into_bytes()[..]);
        let promise = match run.call1(&JsValue::NULL, &bytes).map(js_sys::Promise::from) {
            Ok(promise) => promise,
            Err(error) => return Pending::ready(Err(Error::Unsupported(format!("jobs: {error:?}").into()))),
        };
        let (pending, resolver) = Pending::new();
        wasm_bindgen_futures::spawn_local(async move {
            let answer = wasm_bindgen_futures::JsFuture::from(promise).await;
            resolver.resolve(
                answer
                    .map(|bytes| js_sys::Uint8Array::new(&bytes).to_vec())
                    .map_err(|error| Error::Unsupported(format!("a job failed: {error:?}").into())),
            );
        });
        pending
    }

    fn rasterize(&self, run: &TextRun) -> Option<Raster> {
        with_context(|canvas, context| {
            let layout = Layout::of(context, run)?;
            let size = layout.size().map(|v| v.ceil() as u32);
            if canvas.width() < size[0] || canvas.height() < size[1] {
                canvas.set_width(canvas.width().max(size[0].next_power_of_two()));
                canvas.set_height(canvas.height().max(size[1].next_power_of_two()));
            }
            // Resizing resets the context.
            context.set_font(&format!("{}px {}", run.size_px, run.font));
            context.set_text_baseline("alphabetic");
            context.set_fill_style_str("#fff");
            context.clear_rect(0.0, 0.0, f64::from(size[0]), f64::from(size[1]));
            for (i, (line, _)) in layout.lines.iter().enumerate() {
                context.fill_text(line, PAD, PAD + layout.ascent + layout.line_height * i as f64).ok()?;
            }
            let rgba = context.get_image_data(0.0, 0.0, f64::from(size[0]), f64::from(size[1])).ok()?.data();
            let coverage = rgba.0.as_chunks::<4>().0.iter().map(|p| p[3]).collect();
            Some(Raster { size, coverage, baseline: (PAD + layout.ascent) as f32 })
        })
    }
}
