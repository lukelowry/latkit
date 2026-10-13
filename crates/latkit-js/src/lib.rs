//! The latkit npm package: data, patches, and views for the browser, over WebGPU.
//!
//! Scenes and cameras cross as JSON in the forms `latkit`'s serde support reads; field values cross
//! as typed arrays or arrays and are copied once. The npm wrapper adds the expression builders.

#![cfg(target_arch = "wasm32")]
#![allow(unsafe_code, reason = "wasm-bindgen's generated glue")]
#![allow(missing_docs, reason = "documented in the npm package's TypeScript")]

mod convert;
mod error;

use wasm_bindgen::prelude::*;

use convert::{invalid, value};
pub use error::Error;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// The GPU device views draw with.
#[wasm_bindgen]
pub struct Gpu(latkit::Gpu);

#[wasm_bindgen]
impl Gpu {
    /// Requests a WebGPU device.
    pub async fn create() -> Result<Gpu, Error> {
        Ok(Gpu(latkit::Gpu::new().await?))
    }

    /// A view drawing `scene` (JSON) into `canvas`.
    pub fn view(&self, canvas: web_sys::HtmlCanvasElement, scene: &str) -> Result<View, Error> {
        let scene: latkit::Scene = serde_json::from_str(scene).map_err(|e| invalid("scene", &e))?;
        let view = latkit::View::new(&self.0, scene)?;
        Ok(View(latkit::web::Canvas::new(&self.0, canvas, view)?))
    }
}

/// A named, immutable collection of tables; `apply` replaces it with the next version.
#[wasm_bindgen]
pub struct Data(latkit::Data);

#[wasm_bindgen]
impl Data {
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str) -> Data {
        Data(latkit::Data::new(name))
    }

    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<Data, Error> {
        Ok(Data(latkit::Data::from_bytes(bytes)?))
    }

    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.0.name().to_string()
    }

    /// Applies every change of `patch`, or none.
    pub fn apply(&mut self, patch: &Patch) -> Result<(), Error> {
        Ok(self.0.apply(patch.0.clone())?)
    }

    /// Applies a patch received as bytes.
    #[wasm_bindgen(js_name = applyBytes)]
    pub fn apply_bytes(&mut self, bytes: &[u8]) -> Result<(), Error> {
        Ok(self.0.apply(latkit::Patch::from_bytes(bytes)?)?)
    }

    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.to_bytes()
    }

    /// The value of `field` for the row with `id` in `table`, at axis coordinate `at` when given.
    pub fn get(&self, table: &str, id: &JsValue, field: &str, at: Option<f64>) -> Result<JsValue, Error> {
        let id = convert::id(id)?;
        let row = latkit::Row::new(self.0.name(), table, id);
        Ok(match at {
            Some(at) => self.0.get_at(&row, field, at),
            None => self.0.get(&row, field),
        }
        .map_or(JsValue::NULL, |v| value(&v)))
    }

    /// The names of the tables.
    pub fn tables(&self) -> Vec<String> {
        self.0.tables().map(|t| t.name().to_string()).collect()
    }
}

/// Changes to a dataset, applied in order and all at once.
#[wasm_bindgen]
#[derive(Default)]
pub struct Patch(latkit::Patch);

#[wasm_bindgen]
impl Patch {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Patch {
        Patch::default()
    }

    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<Patch, Error> {
        Ok(Patch(latkit::Patch::from_bytes(bytes)?))
    }

    pub fn axis(&mut self, name: &str, unit: &str) {
        self.take(|p| p.axis(name, unit));
    }

    /// Writes `fields` for rows `ids` of `table`, adding rows and the table as needed.
    pub fn set(&mut self, table: &str, ids: &JsValue, fields: &js_sys::Object) -> Result<(), Error> {
        let table = convert::fields(latkit::Table::new(table, convert::ids(ids)?), fields)?;
        self.take(|p| p.set(table));
        Ok(())
    }

    /// Replaces `table` with these rows and fields.
    pub fn put(&mut self, table: &str, ids: &JsValue, fields: &js_sys::Object) -> Result<(), Error> {
        let table = convert::fields(latkit::Table::new(table, convert::ids(ids)?), fields)?;
        self.take(|p| p.put(table));
        Ok(())
    }

    pub fn remove(&mut self, table: &str, ids: &JsValue) -> Result<(), Error> {
        let ids = convert::ids(ids)?;
        self.take(|p| p.remove(table, ids));
        Ok(())
    }

    /// Records one frame at axis coordinate `at`: a value per row of `table` for each field.
    pub fn append(&mut self, at: f64, table: &str, fields: &js_sys::Object) -> Result<(), Error> {
        let fields = convert::values_of(fields)?;
        self.take(|p| p.append(at, table, fields));
        Ok(())
    }

    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.to_bytes()
    }

    fn take(&mut self, f: impl FnOnce(latkit::Patch) -> latkit::Patch) {
        self.0 = f(std::mem::take(&mut self.0));
    }
}

/// A scene drawn into a canvas.
#[wasm_bindgen]
pub struct View(latkit::web::Canvas);

#[wasm_bindgen]
impl View {
    /// Draws `scene` (JSON) instead; an invalid scene changes nothing.
    pub fn show(&self, scene: &str) -> Result<(), Error> {
        let scene: latkit::Scene = serde_json::from_str(scene).map_err(|e| invalid("scene", &e))?;
        Ok(self.0.with(|v| v.show(scene))?)
    }

    #[wasm_bindgen(js_name = setData)]
    pub fn set_data(&self, data: &Data) {
        self.0.with(|v| v.set_data(data.0.clone()));
    }

    #[wasm_bindgen(js_name = removeData)]
    pub fn remove_data(&self, name: &str) {
        self.0.with(|v| v.remove_data(name));
    }

    #[wasm_bindgen(getter)]
    pub fn at(&self) -> f64 {
        self.0.with(|v| v.at())
    }

    #[wasm_bindgen(setter)]
    pub fn set_at(&self, at: f64) {
        self.0.with(|v| v.set_at(at));
    }

    /// The camera as JSON.
    #[wasm_bindgen(getter)]
    pub fn camera(&self) -> String {
        self.0.with(|v| serde_json::to_string(v.camera()).expect("a camera serializes"))
    }

    /// Looks through the camera (JSON) at once.
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&self, camera: &str) -> Result<(), Error> {
        let camera: latkit::Camera = serde_json::from_str(camera).map_err(|e| invalid("camera", &e))?;
        self.0.with(|v| v.set_camera(camera));
        Ok(())
    }

    /// Eases to the camera (JSON).
    pub fn fly(&self, camera: &str) -> Result<(), Error> {
        let camera: latkit::Camera = serde_json::from_str(camera).map_err(|e| invalid("camera", &e))?;
        self.0.with(|v| v.fly(camera));
        Ok(())
    }

    /// Frames everything drawn.
    pub fn fit(&self) {
        self.0.with(latkit::View::fit);
    }
}
