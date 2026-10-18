//! The latkit npm package: data, patches, and views for the browser, over WebGPU.
//!
//! A view's state crosses as JSON both ways, in the forms `latkit`'s serde support reads and writes:
//! scenes, cameras, fits, budgets, and rows in; events, hits, stats, and work out, a view's events a
//! batch at a time. Field values cross as typed arrays or arrays and are copied once. The npm wrapper
//! adds the expression builders and typed listeners.

#![cfg(target_arch = "wasm32")]
#![allow(unsafe_code, reason = "wasm-bindgen's generated glue")]
#![allow(missing_docs, reason = "documented in the npm package's TypeScript")]

mod convert;
mod error;
mod shot;

use wasm_bindgen::prelude::*;

use convert::{invalid, value};
pub use error::Error;
pub use shot::{Handle, Image, Video, image, set_encoder};

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// What `text` holds, in the JSON form latkit's serde support reads; or why not, at `what`.
fn json<T: serde::de::DeserializeOwned>(what: &str, text: &str) -> Result<T, Error> {
    serde_json::from_str(text).map_err(|e| invalid(what, &e).into())
}

/// `value` in the JSON form the npm package's types describe.
fn to_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("view state serializes")
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

    /// A view drawing `scene` (JSON) into `canvas`, telling `tell` its events from the start: each
    /// batch a JSON array of `{ type, detail }`.
    pub fn view(
        &self,
        canvas: &web_sys::HtmlCanvasElement,
        scene: &str,
        tell: js_sys::Function,
    ) -> Result<View, Error> {
        let view = latkit::View::new(&self.0, json("scene", scene)?)?;
        let canvas = latkit::web::Canvas::new(&self.0, canvas, view)?;
        let telling = canvas.on(move |events| {
            let _ = tell.call1(&JsValue::NULL, &JsValue::from_str(&to_json(&events)));
        });
        Ok(View { canvas, _telling: telling })
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

    /// How much GPU memory data takes, as JSON `{ bytes, uploadPerFrame }`.
    #[wasm_bindgen(getter)]
    pub fn budget(&self) -> String {
        to_json(&self.0.budget())
    }

    /// Sets how much GPU memory data takes, from JSON `{ bytes, uploadPerFrame }`.
    #[wasm_bindgen(js_name = setBudget)]
    pub fn set_budget(&self, budget: &str) -> Result<(), Error> {
        self.0.set_budget(json("budget", budget)?);
        Ok(())
    }

    /// What the GPU did since it was made, counted exactly, as JSON `{ uploaded, written, evaluated,
    /// readbacks, jobs, texts, pipelines }`.
    #[wasm_bindgen(getter)]
    pub fn work(&self) -> String {
        to_json(&self.0.work())
    }

    /// A video of `shot`'s pictures at `fps` frames a second, encoded by WebCodecs at `bitrate` bits
    /// a second, or about 0.15 bits a pixel a frame.
    pub fn video(&self, shot: &JsValue, fps: f64, bitrate: Option<f64>) -> Result<Video, Error> {
        shot::video(&self.0, shot, fps, bitrate)
    }
}

/// A listener; freeing it stops it.
#[wasm_bindgen]
pub struct Listener(#[allow(dead_code, reason = "kept until freed")] latkit::web::Listener);

/// A named, immutable collection of tables; `apply` makes its next version.
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

    /// The first and last axis coordinates the sampled fields span.
    #[wasm_bindgen(getter)]
    pub fn span(&self) -> Option<Vec<f64>> {
        self.0.span().map(Vec::from)
    }

    /// The next version: this one with every change of `patch`, or none; the patch is spent.
    pub fn apply(&self, patch: Patch) -> Result<Data, Error> {
        let mut next = self.0.clone();
        next.apply(patch.0)?;
        Ok(Data(next))
    }

    /// The next version, with a patch received as bytes.
    #[wasm_bindgen(js_name = applyBytes)]
    pub fn apply_bytes(&self, bytes: &[u8]) -> Result<Data, Error> {
        let mut next = self.0.clone();
        next.apply(latkit::Patch::from_bytes(bytes)?)?;
        Ok(Data(next))
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

    /// Every row's id of `table`, in row order.
    pub fn ids(&self, table: &str) -> js_sys::Array {
        self.0.table(table).map(|t| t.ids().map(|id| convert::id_value(&id)).collect()).unwrap_or_default()
    }

    /// The names of `table`'s fields.
    pub fn fields(&self, table: &str) -> Vec<String> {
        self.0.table(table).map(|t| t.fields().map(|(name, _)| name.to_string()).collect()).unwrap_or_default()
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

    /// Forgets every sampled field's frames before axis coordinate `before`.
    pub fn forget(&mut self, before: f64) {
        self.take(|p| p.forget(before));
    }

    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.to_bytes()
    }

    fn take(&mut self, f: impl FnOnce(latkit::Patch) -> latkit::Patch) {
        self.0 = f(std::mem::take(&mut self.0));
    }
}

/// A scene drawn into a canvas, telling its events from the start.
#[wasm_bindgen]
pub struct View {
    canvas: latkit::web::Canvas,
    _telling: latkit::web::Listener,
}

#[wasm_bindgen]
impl View {
    /// Draws `scene` (JSON) instead; an invalid scene changes nothing.
    pub fn show(&self, scene: &str) -> Result<(), Error> {
        let scene = json("scene", scene)?;
        Ok(self.canvas.with(|v| v.show(scene))?)
    }

    #[wasm_bindgen(js_name = setData)]
    pub fn set_data(&self, data: &Data) {
        self.canvas.with(|v| v.set_data(data.0.clone()));
    }

    #[wasm_bindgen(js_name = removeData)]
    pub fn remove_data(&self, name: &str) {
        self.canvas.with(|v| v.remove_data(name));
    }

    /// The dataset named `name`: one given, or the tiles the view fetched.
    pub fn data(&self, name: &str) -> Option<Data> {
        self.canvas.read(|v| v.data(name).cloned()).map(Data)
    }

    /// Fetches the vector tiles at `url` as the camera asks for them, drawn as dataset `name`.
    #[wasm_bindgen(js_name = setTiles)]
    pub fn set_tiles(&self, name: &str, url: &str) {
        self.canvas.with(|v| v.set_tiles(latkit::geo::Tiles::vector(name, url)));
    }

    #[wasm_bindgen(js_name = removeTiles)]
    pub fn remove_tiles(&self, name: &str) {
        self.canvas.with(|v| v.remove_tiles(name));
    }

    #[wasm_bindgen(getter)]
    pub fn at(&self) -> f64 {
        self.canvas.read(latkit::View::at)
    }

    #[wasm_bindgen(setter)]
    pub fn set_at(&self, at: f64) {
        self.canvas.with(|v| v.set_at(at));
    }

    /// The camera as JSON.
    #[wasm_bindgen(getter)]
    pub fn camera(&self) -> String {
        self.canvas.read(|v| to_json(v.camera()))
    }

    /// Looks through the camera (JSON) at once.
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&self, camera: &str) -> Result<(), Error> {
        let camera = json("camera", camera)?;
        self.canvas.with(|v| v.set_camera(camera));
        Ok(())
    }

    /// Eases to the camera (JSON).
    pub fn fly(&self, camera: &str) -> Result<(), Error> {
        let camera = json("camera", camera)?;
        self.canvas.with(|v| v.fly(camera));
        Ok(())
    }

    /// Frames what `fit` (JSON) names.
    pub fn fit(&self, fit: &str) -> Result<(), Error> {
        let fit = json("fit", fit)?;
        self.canvas.with(|v| v.fit(fit));
        Ok(())
    }

    /// Lays every vertex without a position out again by the diagram's layout.
    pub fn arrange(&self) {
        self.canvas.with(latkit::View::arrange);
    }

    /// Where `position` (x, y, elevation) lands on screen, CSS pixels from the top left.
    pub fn point(&self, position: &[f64]) -> Option<Vec<f32>> {
        let position: [f64; 3] = position.try_into().ok()?;
        self.canvas.read(|v| v.point(position)).map(Vec::from)
    }

    /// The position on the ground under screen point `point`.
    pub fn ground(&self, point: &[f32]) -> Option<Vec<f64>> {
        let point: [f32; 2] = point.try_into().ok()?;
        self.canvas.read(|v| v.ground(point)).map(Vec::from)
    }

    #[wasm_bindgen(getter)]
    pub fn insets(&self) -> Vec<f32> {
        self.canvas.read(|v| v.insets().to_vec())
    }

    #[wasm_bindgen(setter)]
    pub fn set_insets(&self, insets: &[f32]) -> Result<(), Error> {
        let insets: [f32; 4] = insets.try_into().map_err(|_| latkit::Error::invalid("four insets").at("insets"))?;
        self.canvas.with(|v| v.set_insets(insets));
        Ok(())
    }

    #[wasm_bindgen(getter)]
    pub fn orbit(&self) -> f64 {
        self.canvas.read(latkit::View::orbit)
    }

    #[wasm_bindgen(setter)]
    pub fn set_orbit(&self, degrees_per_second: f64) {
        self.canvas.with(|v| v.set_orbit(degrees_per_second));
    }

    /// The rows selected, as JSON.
    #[wasm_bindgen(getter)]
    pub fn selection(&self) -> String {
        self.canvas.read(|v| to_json(&v.selection()))
    }

    /// Selects the rows (JSON), and no others.
    pub fn select(&self, rows: &str) -> Result<(), Error> {
        let rows: Vec<latkit::Row> = json("rows", rows)?;
        self.canvas.with(|v| v.select(rows));
        Ok(())
    }

    /// What the user points at, as a JSON hit or `null`.
    #[wasm_bindgen(getter)]
    pub fn hovered(&self) -> String {
        self.canvas.read(|v| to_json(&v.hovered()))
    }

    /// Every mark that draws nothing because its data no longer fits it, as JSON errors.
    #[wasm_bindgen(getter)]
    pub fn failures(&self) -> String {
        self.canvas.read(|v| to_json(&v.failures().collect::<Vec<_>>()))
    }

    /// What the view does each frame, as JSON.
    #[wasm_bindgen(getter)]
    pub fn stats(&self) -> String {
        to_json(&self.canvas.read(latkit::View::stats))
    }

    /// Every row within `radius` CSS pixels of `point`, nearest first, as JSON hits.
    pub fn pick(&self, point: &[f32], radius: f32) -> Result<js_sys::Promise, Error> {
        let point: [f32; 2] = point.try_into().map_err(|_| latkit::Error::invalid("a point is [x, y]").at("point"))?;
        let pending = self.canvas.with(|v| v.pick(point, radius));
        Ok(wasm_bindgen_futures::future_to_promise(async move {
            let hits = pending.await.map_err(|e| JsValue::from(Error::from(e)))?;
            Ok(JsValue::from_str(&to_json(&hits)))
        }))
    }

    /// Where the row (JSON) lies on screen, `[x, y]`, or `null`.
    pub fn locate(&self, row: &str) -> Result<js_sys::Promise, Error> {
        let row: latkit::Row = json("row", row)?;
        let pending = self.canvas.with(|v| v.locate(&row));
        Ok(wasm_bindgen_futures::future_to_promise(async move {
            let point = pending.await.map_err(|e| JsValue::from(Error::from(e)))?;
            Ok(point.map_or(JsValue::NULL, |p| js_sys::Array::of2(&p[0].into(), &p[1].into()).into()))
        }))
    }

    /// The rows joined to the row (JSON), as JSON: a vertex's neighbors across edges and nets, or an
    /// edge's or a net's vertices.
    pub fn neighbors(&self, row: &str) -> Result<String, Error> {
        let row: latkit::Row = json("row", row)?;
        Ok(self.canvas.read(|v| to_json(&v.neighbors(&row))))
    }

    /// The view's canvas, for a shot to draw.
    pub fn handle(&self) -> Handle {
        Handle(self.canvas.clone())
    }
}

/// Has views' jobs done by `run`: `(bytes: Uint8Array) => Promise<Uint8Array>`, the page's workers.
#[wasm_bindgen(js_name = setJobs)]
pub fn set_jobs(run: js_sys::Function) {
    latkit::host::Browser::set_jobs(run);
}

/// Does a job a view handed the page, in a worker: its answer's bytes.
#[wasm_bindgen]
pub fn job(bytes: &[u8]) -> Vec<u8> {
    latkit::host::Job::from_bytes(bytes.to_vec()).run()
}

/// The job reading GeoJSON `bytes` as dataset `name`, for a worker to do: it answers the patch that
/// builds the dataset, or nothing when the bytes are no GeoJSON.
#[wasm_bindgen(js_name = geojsonJob)]
pub fn geojson_job(name: &str, bytes: &[u8]) -> Vec<u8> {
    latkit::host::Job::geojson(name, bytes).into_bytes()
}

/// The compiled module, for workers to instantiate.
#[wasm_bindgen]
pub fn module() -> JsValue {
    wasm_bindgen::module()
}

/// A catalog colormap's 256 RGBA texels, for legends.
#[wasm_bindgen]
pub fn colormap(name: &str) -> Option<Vec<u8>> {
    latkit::Colormap::named(name).map(|map| (0..256).flat_map(|i| map.sample(i as f32 / 255.0).to_rgba8()).collect())
}
