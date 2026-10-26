//! The GPU: it creates views and canvases, and reports its frames, budget, and work.

use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::canvas::{Canvas, Handle, layout};
use crate::pending::{Task, task};
use crate::view::View;
use crate::{Error, json, to_json};

/// The GPU device views draw with.
#[wasm_bindgen]
pub struct Gpu(latkit::Gpu);

#[wasm_bindgen]
impl Gpu {
    /// Requests a WebGPU device.
    pub async fn create() -> Result<Gpu, Error> {
        Ok(Gpu(latkit::Gpu::new().await?))
    }

    /// Creates a view of `scene` (JSON) that sends its events to `tell` from the start, each batch
    /// as a JSON array of `{ type, detail }`. A canvas shows it. A shot draws it with or without
    /// a canvas.
    pub fn view(&self, scene: &str, tell: js_sys::Function) -> Result<View, Error> {
        let view = latkit::web::PageView::new(latkit::View::new(&self.0, json("scene", scene)?)?);
        let telling = view.on(move |events| {
            let _ = tell.call1(&JsValue::NULL, &JsValue::from_str(&to_json(&events)));
        });
        Ok(View { view, _telling: telling })
    }

    /// Creates a canvas showing `views` in `target`, each at its four fractions of `at`. `target`
    /// is a `<canvas>` element, or an `OffscreenCanvas` at `pixel_ratio` pixels per CSS pixel
    /// (default 1).
    pub fn canvas(
        &self,
        target: &JsValue,
        views: Vec<Handle>,
        at: &[f32],
        pixel_ratio: Option<f32>,
    ) -> Result<Canvas, Error> {
        let layout = layout(views, at)?;
        let canvas = if let Some(element) = target.dyn_ref::<web_sys::HtmlCanvasElement>() {
            latkit::web::Canvas::new(&self.0, element, layout)?
        } else if let Some(offscreen) = target.dyn_ref::<web_sys::OffscreenCanvas>() {
            latkit::web::Canvas::offscreen(&self.0, offscreen, layout, pixel_ratio.unwrap_or(1.0))?
        } else {
            return Err(latkit::Error::invalid("the target must be a <canvas> or an OffscreenCanvas").into());
        };
        Ok(Canvas(canvas))
    }

    /// Calls `listener` with the frame's timestamp every animation frame, before the views draw.
    #[wasm_bindgen(js_name = onFrame)]
    pub fn on_frame(&self, listener: js_sys::Function) -> Listener {
        Listener(latkit::web::on_frame(&self.0, move |now| {
            let _ = listener.call1(&JsValue::NULL, &now.into());
        }))
    }

    /// Whether the device was lost.
    #[wasm_bindgen(getter)]
    pub fn lost(&self) -> bool {
        self.0.lost()
    }

    /// The GPU memory budget for data, as JSON `{ bytes, uploadPerFrame }`.
    #[wasm_bindgen(getter)]
    pub fn budget(&self) -> String {
        to_json(&self.0.budget())
    }

    /// Sets the GPU memory budget for data from JSON `{ bytes, uploadPerFrame }`.
    #[wasm_bindgen(js_name = setBudget)]
    pub fn set_budget(&self, budget: &str) -> Result<(), Error> {
        self.0.set_budget(json("budget", budget)?);
        Ok(())
    }

    /// Exact counts of the GPU's work since it was created, as JSON.
    #[wasm_bindgen(getter)]
    pub fn work(&self) -> String {
        to_json(&self.0.work())
    }

    /// Bytes resident on the GPU that its views draw from.
    #[wasm_bindgen(getter)]
    pub fn resident(&self) -> f64 {
        self.0.resident() as f64
    }

    /// Bytes waiting to upload, across all its views.
    #[wasm_bindgen(getter)]
    pub fn uploading(&self) -> f64 {
        self.0.uploading() as f64
    }

    /// Draws one frame immediately, with `now` as its timestamp in milliseconds. After the first
    /// call, no animation frames are requested.
    pub fn step(&self, now: f64) {
        latkit::web::step(&self.0, now);
    }

    /// Resolves once the GPU has finished its submitted work, every readback has arrived, and every
    /// requested pipeline has compiled.
    pub fn done(&self) -> Task {
        let gpu = self.0.clone();
        task(async move {
            latkit::web::done(&gpu).await;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Resolves when work a view depends on arrives after this call, or a view requests a frame.
    pub fn landed(&self) -> Task {
        let landed = latkit::web::landed(&self.0);
        task(async move {
            landed.await;
            Ok(JsValue::UNDEFINED)
        })
    }
}

/// A frame listener. Freeing it stops it.
#[wasm_bindgen]
pub struct Listener(#[allow(dead_code, reason = "kept until freed")] latkit::web::Listener);
