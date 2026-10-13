use std::cell::RefCell;

use wasm_bindgen::JsCast;
use web_sys::{OffscreenCanvas, OffscreenCanvasRenderingContext2d};

use super::{Host, Raster, TextRun};

/// The browser: text set with a 2D canvas in the page's fonts.
#[derive(Clone, Copy, Debug, Default)]
pub struct Browser;

thread_local! {
    static CANVAS: RefCell<Option<(OffscreenCanvas, OffscreenCanvasRenderingContext2d)>> = const { RefCell::new(None) };
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

impl Host for Browser {
    fn rasterize(&self, run: &TextRun) -> Option<Raster> {
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
            let font = format!("{}px {}", run.size_px, run.font);
            context.set_font(&font);
            let lines = lines(context, &run.text, run.max_width.map(f64::from))?;
            let metrics = context.measure_text(&run.text).ok()?;
            let ascent = metrics.font_bounding_box_ascent();
            let line_height = ascent + metrics.font_bounding_box_descent();
            let widest = lines.iter().map(|(_, w)| *w).fold(0.0, f64::max);
            let height = line_height * lines.len() as f64;
            let size = [(widest + 2.0 * PAD).ceil() as u32, (height + 2.0 * PAD).ceil() as u32];
            if canvas.width() < size[0] || canvas.height() < size[1] {
                canvas.set_width(canvas.width().max(size[0].next_power_of_two()));
                canvas.set_height(canvas.height().max(size[1].next_power_of_two()));
            }
            // Resizing resets the context.
            context.set_font(&font);
            context.set_text_baseline("alphabetic");
            context.set_fill_style_str("#fff");
            context.clear_rect(0.0, 0.0, f64::from(size[0]), f64::from(size[1]));
            for (i, (line, _)) in lines.iter().enumerate() {
                context.fill_text(line, PAD, PAD + ascent + line_height * i as f64).ok()?;
            }
            let rgba = context.get_image_data(0.0, 0.0, f64::from(size[0]), f64::from(size[1])).ok()?.data();
            let coverage = rgba.0.as_chunks::<4>().0.iter().map(|p| p[3]).collect();
            Some(Raster { size, coverage, baseline: (PAD + ascent) as f32 })
        })
    }
}
