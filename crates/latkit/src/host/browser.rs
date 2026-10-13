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

impl Host for Browser {
    fn rasterize(&self, run: &TextRun) -> Option<Raster> {
        CANVAS.with(|cell| {
            let mut cell = cell.borrow_mut();
            if cell.is_none() {
                let canvas = OffscreenCanvas::new(256, 64).ok()?;
                let context = canvas.get_context("2d").ok()??.dyn_into::<OffscreenCanvasRenderingContext2d>().ok()?;
                *cell = Some((canvas, context));
            }
            let (canvas, context) = cell.as_ref()?;
            let font = format!("{}px {}", run.size_px, run.font);
            context.set_font(&font);
            let metrics = context.measure_text(&run.text).ok()?;
            let ascent = metrics.font_bounding_box_ascent();
            let height = ascent + metrics.font_bounding_box_descent();
            let size = [(metrics.width() + 2.0 * PAD).ceil() as u32, (height + 2.0 * PAD).ceil() as u32];
            if canvas.width() < size[0] || canvas.height() < size[1] {
                canvas.set_width(canvas.width().max(size[0].next_power_of_two()));
                canvas.set_height(canvas.height().max(size[1].next_power_of_two()));
            }
            // Resizing resets the context.
            context.set_font(&font);
            context.set_text_baseline("alphabetic");
            context.set_fill_style_str("#fff");
            context.clear_rect(0.0, 0.0, f64::from(size[0]), f64::from(size[1]));
            context.fill_text(&run.text, PAD, PAD + ascent).ok()?;
            let rgba = context.get_image_data(0.0, 0.0, f64::from(size[0]), f64::from(size[1])).ok()?.data();
            let coverage = rgba.0.chunks_exact(4).map(|p| p[3]).collect();
            Some(Raster { size, coverage, baseline: (PAD + ascent) as f32 })
        })
    }
}
