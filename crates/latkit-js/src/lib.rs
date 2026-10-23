//! The latkit npm package: data and views for the browser, over WebGPU.
//!
//! What crosses is bytes or JSON, in the forms `latkit` reads and writes. Patches cross as their byte
//! frames, which the package's TypeScript writes itself; scenes, cameras, fits, queries, and rows go
//! in as JSON, and events, hits, stats, and work come out as JSON, a view's events a batch at a time.
//! A query's columns come out as typed arrays, copied once.

#![cfg(target_arch = "wasm32")]
#![allow(unsafe_code, reason = "wasm-bindgen's generated glue")]
#![allow(missing_docs, reason = "documented in the npm package's TypeScript")]

mod canvas;
mod convert;
mod error;
mod shot;

use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

pub use canvas::{Canvas, Handle};
pub use error::Error;
pub use shot::{Image, Video, image, set_encoder};

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// What `text` holds, in the JSON form latkit reads; or why not, at the path from `what`.
fn json<T: serde::de::DeserializeOwned>(what: &str, text: &str) -> Result<T, Error> {
    latkit::from_json(text).map_err(|e| e.at(what).into())
}

/// `value` in the JSON form the npm package's types describe.
fn to_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("view state serializes")
}

/// A promise of what `future` answers, its error thrown as latkit's.
fn promise<T: Into<JsValue>>(future: impl Future<Output = latkit::Result<T>> + 'static) -> js_sys::Promise {
    wasm_bindgen_futures::future_to_promise(async move {
        future.await.map(Into::into).map_err(|e| JsValue::from(Error::from(e)))
    })
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

    /// A view of `scene` (JSON), telling `tell` its events from the start: each batch a JSON array of
    /// `{ type, detail }`. A canvas shows it; a shot draws it with or without one.
    pub fn view(&self, scene: &str, tell: js_sys::Function) -> Result<View, Error> {
        let view = latkit::web::PageView::new(latkit::View::new(&self.0, json("scene", scene)?)?);
        let telling = view.on(move |events| {
            let _ = tell.call1(&JsValue::NULL, &JsValue::from_str(&to_json(&events)));
        });
        Ok(View { view, _telling: telling })
    }

    /// A canvas showing views in `panels` (JSON) of `target`: a `<canvas>` element, or an
    /// `OffscreenCanvas` at `pixel_ratio` pixels a CSS pixel.
    pub fn canvas(&self, target: &JsValue, panels: &str, pixel_ratio: Option<f32>) -> Result<Canvas, Error> {
        let panels: latkit::Panels = json("panels", panels)?;
        let canvas = if let Some(element) = target.dyn_ref::<web_sys::HtmlCanvasElement>() {
            latkit::web::Canvas::new(&self.0, element, panels)?
        } else if let Some(offscreen) = target.dyn_ref::<web_sys::OffscreenCanvas>() {
            latkit::web::Canvas::offscreen(&self.0, offscreen, panels, pixel_ratio.unwrap_or(1.0))?
        } else {
            return Err(latkit::Error::invalid("a canvas draws into a <canvas> or an OffscreenCanvas").into());
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

    /// What the GPU did since it was made, counted exactly, as JSON.
    #[wasm_bindgen(getter)]
    pub fn work(&self) -> String {
        to_json(&self.0.work())
    }

    /// Bytes on the GPU every view of it draws from.
    #[wasm_bindgen(getter)]
    pub fn resident(&self) -> f64 {
        self.0.resident() as f64
    }

    /// Bytes waiting to upload, for every view of it.
    #[wasm_bindgen(getter)]
    pub fn uploading(&self) -> f64 {
        self.0.uploading() as f64
    }

    /// Draws one frame now at `now`, milliseconds as an animation frame's timestamp; from the first,
    /// no animation frames are asked for.
    pub fn step(&self, now: f64) {
        latkit::web::step(&self.0, now);
    }

    /// Resolves once the GPU finished what was submitted, every readback landed, and every pipeline
    /// asked for compiled.
    pub fn done(&self) -> js_sys::Promise {
        let gpu = self.0.clone();
        promise(async move {
            latkit::web::done(&gpu).await;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Resolves when work a view waits on lands after this call, or a view asks for a frame.
    pub fn landed(&self) -> js_sys::Promise {
        let landed = latkit::web::landed(&self.0);
        promise(async move {
            landed.await;
            Ok(JsValue::UNDEFINED)
        })
    }
}

#[wasm_bindgen]
impl Gpu {
    /// A video of `shot`'s (JSON) pictures at `fps` frames a second, encoded by WebCodecs at
    /// `bitrate` bits a second, or about 0.15 bits a pixel a frame.
    pub fn video(&self, shot: &str, fps: f64, bitrate: Option<f64>) -> Result<Video, Error> {
        shot::video(&self.0, shot, fps, bitrate)
    }
}

/// A listener; freeing it stops it.
#[wasm_bindgen]
pub struct Listener(#[allow(dead_code, reason = "kept until freed")] latkit::web::Listener);

/// A named collection of tables, changed in place by patches; a snapshot keeps a version.
#[wasm_bindgen]
pub struct Data(latkit::Data);

#[wasm_bindgen]
impl Data {
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str) -> Data {
        Data(latkit::Data::new(name))
    }

    /// The dataset latkit bytes hold, renamed `name` when given.
    #[allow(clippy::needless_pass_by_value, reason = "wasm-bindgen hands optional texts over owned")]
    pub fn read(bytes: &[u8], name: Option<String>) -> Result<Data, Error> {
        if !bytes.starts_with(b"LATK") {
            return Err(latkit::Error::invalid("not latkit bytes").at("bytes").into());
        }
        Ok(Data(latkit::Data::read(bytes, name.as_deref())?))
    }

    /// A promise of the dataset its JSON document builds, its slices fetched relative to `base`.
    pub fn load(json: String, base: String) -> js_sys::Promise {
        promise(async move { Ok(Data(latkit::Data::load(&json, &base, &latkit::host::Browser).await?)) })
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

    /// Applies the patch `bytes` hold: every change, or none when one is invalid.
    pub fn apply(&mut self, bytes: &[u8]) -> Result<(), Error> {
        Ok(self.0.apply(latkit::Patch::from_bytes(bytes)?)?)
    }

    /// This version, kept as `apply` changes this one: O(1), sharing every page.
    #[must_use]
    pub fn snapshot(&self) -> Data {
        Data(self.0.clone())
    }

    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.to_bytes()
    }

    /// The value of `field` for the row with `id` in `table`, at axis coordinate `at` when given, as
    /// JSON; `null` when missing.
    pub fn get(&self, table: &str, id: &JsValue, field: &str, at: Option<f64>) -> Result<String, Error> {
        let row = latkit::Row::new(self.0.name(), table, convert::id(id)?);
        let value = match at {
            Some(at) => self.0.get_at(&row, field, at),
            None => self.0.get(&row, field),
        };
        Ok(to_json(&value))
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

    /// What the dataset holds, as JSON.
    pub fn describe(&self) -> String {
        to_json(&self.0.describe())
    }

    /// The rows `query` (JSON) keeps, as `{ table, ids, fields, total }`: fields in the forms a patch
    /// writes, `total` the rows kept before paging.
    pub fn query(&self, query: &str) -> Result<JsValue, Error> {
        let (table, total) = self.0.query(&json("query", query)?)?;
        Ok(convert::table(&table, total))
    }

    /// Each row's least and greatest value of sampled `field` of `table` over `spans` spans of
    /// `range`: of every row, or of rows `ids` (JSON), as `{ at, least, greatest }` typed arrays.
    pub fn envelope(
        &self,
        table: &str,
        field: &str,
        range: &[f64],
        spans: u32,
        ids: Option<String>,
    ) -> Result<JsValue, Error> {
        let table = self.0.table(table).ok_or_else(|| latkit::Error::invalid("no such table").at(table))?;
        let [from, to] = range else { return Err(latkit::Error::invalid("a range is [from, to]").into()) };
        let ids: Option<latkit::Ids> = ids.map(|ids| json("ids", &ids)).transpose()?;
        let envelope = table.envelope(field, [*from, *to], spans as usize, ids.as_ref())?;
        Ok(convert::object(&[
            ("at", js_sys::Float64Array::from(&envelope.at[..]).into()),
            ("least", js_sys::Float32Array::from(&envelope.least[..]).into()),
            ("greatest", js_sys::Float32Array::from(&envelope.greatest[..]).into()),
        ]))
    }
}

/// A promise of the bytes of the patch its JSON makes, its slices fetched relative to `base`.
#[wasm_bindgen(js_name = loadPatch)]
pub fn load_patch(json: String, base: String) -> js_sys::Promise {
    promise(async move {
        let patch = latkit::Patch::load(&json, &base, &latkit::host::Browser).await?;
        Ok(js_sys::Uint8Array::from(&patch.to_bytes()[..]))
    })
}

/// A view of a scene, telling its events from the start.
#[wasm_bindgen]
pub struct View {
    view: latkit::web::PageView,
    _telling: latkit::web::Listener,
}

#[wasm_bindgen]
impl View {
    /// Draws `scene` (JSON) instead; an invalid scene changes nothing.
    pub fn show(&self, scene: &str) -> Result<(), Error> {
        let scene = json("scene", scene)?;
        Ok(self.view.with(|v| v.show(scene))?)
    }

    #[wasm_bindgen(js_name = setData)]
    pub fn set_data(&self, data: &Data) {
        self.view.with(|v| v.set_data(data.0.clone()));
    }

    /// Fetches the vector tiles at `url` as the camera asks for them, drawn as dataset `name`.
    #[wasm_bindgen(js_name = setTiles)]
    pub fn set_tiles(&self, name: &str, url: &str) {
        self.view.with(|v| v.set_tiles(latkit::Tiles::new(name, url)));
    }

    #[wasm_bindgen(js_name = removeData)]
    pub fn remove_data(&self, name: &str) {
        self.view.with(|v| v.remove_data(name));
    }

    /// The dataset named `name`: one given, or the tiles the view fetched.
    pub fn data(&self, name: &str) -> Option<Data> {
        self.view.read(|v| v.data(name).cloned()).map(Data)
    }

    #[wasm_bindgen(getter)]
    pub fn at(&self) -> f64 {
        self.view.read(latkit::View::at)
    }

    #[wasm_bindgen(setter)]
    pub fn set_at(&self, at: f64) {
        self.view.with(|v| v.set_at(at));
    }

    /// The camera as JSON.
    #[wasm_bindgen(getter)]
    pub fn camera(&self) -> String {
        self.view.read(|v| to_json(v.camera()))
    }

    /// Looks through the camera (JSON) at once.
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&self, camera: &str) -> Result<(), Error> {
        let camera = json("camera", camera)?;
        self.view.with(|v| v.set_camera(camera));
        Ok(())
    }

    /// Eases to the camera (JSON).
    pub fn fly(&self, camera: &str) -> Result<(), Error> {
        let camera = json("camera", camera)?;
        self.view.with(|v| v.fly(camera));
        Ok(())
    }

    /// Frames what `fit` (JSON) names.
    pub fn fit(&self, fit: &str) -> Result<(), Error> {
        let fit = json("fit", fit)?;
        self.view.with(|v| v.fit(fit));
        Ok(())
    }

    /// Lays every vertex row without a position out again by the scene's layout: a promise of the
    /// bytes of a patch to each dataset, writing the places into the data.
    pub fn arrange(&self) -> js_sys::Promise {
        let pending = self.view.with(latkit::View::arrange);
        promise(async move {
            let patches = pending.await?;
            Ok(patches.iter().map(|patch| js_sys::Uint8Array::from(&patch.to_bytes()[..])).collect::<js_sys::Array>())
        })
    }

    /// Where `position` (x, y, elevation) lands on screen, CSS pixels from the top left.
    pub fn point(&self, position: &[f64]) -> Option<Vec<f32>> {
        let position: [f64; 3] = position.try_into().ok()?;
        self.view.read(|v| v.point(position)).map(Vec::from)
    }

    /// The position on the ground under screen point `point`.
    pub fn ground(&self, point: &[f32]) -> Option<Vec<f64>> {
        let point: [f32; 2] = point.try_into().ok()?;
        self.view.read(|v| v.ground(point)).map(Vec::from)
    }

    #[wasm_bindgen(getter)]
    pub fn insets(&self) -> Vec<f32> {
        self.view.read(|v| v.insets().to_vec())
    }

    #[wasm_bindgen(setter)]
    pub fn set_insets(&self, insets: &[f32]) -> Result<(), Error> {
        let insets: [f32; 4] = insets.try_into().map_err(|_| latkit::Error::invalid("four insets").at("insets"))?;
        self.view.with(|v| v.set_insets(insets));
        Ok(())
    }

    #[wasm_bindgen(getter)]
    pub fn orbit(&self) -> f64 {
        self.view.read(latkit::View::orbit)
    }

    #[wasm_bindgen(setter)]
    pub fn set_orbit(&self, degrees_per_second: f64) {
        self.view.with(|v| v.set_orbit(degrees_per_second));
    }

    /// The rows selected, as JSON sets of rows.
    #[wasm_bindgen(getter)]
    pub fn selection(&self) -> String {
        self.view.read(|v| to_json(&v.selection()))
    }

    /// Selects the rows (JSON sets of rows), and no others.
    pub fn select(&self, rows: &str) -> Result<(), Error> {
        let rows: Vec<latkit::Rows> = json("rows", rows)?;
        self.view.with(|v| v.select(rows));
        Ok(())
    }

    /// What the user points at, as a JSON hit or `null`.
    #[wasm_bindgen(getter)]
    pub fn hovered(&self) -> String {
        self.view.read(|v| to_json(&v.hovered()))
    }

    /// Every mark that draws nothing because its data no longer fits it, as JSON failures.
    #[wasm_bindgen(getter)]
    pub fn failures(&self) -> String {
        self.view.read(|v| to_json(&v.failures().collect::<Vec<_>>()))
    }

    /// What the view does each frame, as JSON.
    #[wasm_bindgen(getter)]
    pub fn stats(&self) -> String {
        to_json(&self.view.read(latkit::View::stats))
    }

    /// Whether the view wants a frame: it changed, or work it waited on landed.
    #[wasm_bindgen(getter, js_name = wantsFrame)]
    pub fn wants_frame(&self) -> bool {
        self.view.wants_frame()
    }

    /// Every row within `radius` CSS pixels of `point`, nearest first, as JSON hits.
    pub fn pick(&self, point: &[f32], radius: f32) -> Result<js_sys::Promise, Error> {
        let point: [f32; 2] = point.try_into().map_err(|_| latkit::Error::invalid("a point is [x, y]").at("point"))?;
        let pending = self.view.with(|v| v.pick(point, radius));
        Ok(promise(async move { Ok(JsValue::from_str(&to_json(&pending.await?))) }))
    }

    /// Where the row (JSON) lies on screen, `[x, y]`, or `null`.
    pub fn locate(&self, row: &str) -> Result<js_sys::Promise, Error> {
        let row: latkit::Row = json("row", row)?;
        let pending = self.view.with(|v| v.locate(&row));
        Ok(promise(async move {
            let point = pending.await?;
            Ok(point.map_or(JsValue::NULL, |p| js_sys::Array::of2(&p[0].into(), &p[1].into()).into()))
        }))
    }

    /// The rows joined to the row (JSON), as JSON sets of rows: a vertex's neighbors across edges and
    /// nets, or an edge's or a net's vertices.
    pub fn neighbors(&self, row: &str) -> Result<String, Error> {
        let row: latkit::Row = json("row", row)?;
        Ok(self.view.read(|v| to_json(&v.neighbors(&row))))
    }

    /// The view, for a canvas to show or a shot to draw.
    pub fn handle(&self) -> Handle {
        Handle(self.view.clone())
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

/// The job reading GeoJSON `bytes`, gzip-compressed or not, as dataset `name`, for a worker to do: it
/// answers the bytes of the patch building the dataset, or nothing when the bytes are no GeoJSON.
#[wasm_bindgen(js_name = geojsonJob)]
pub fn geojson_job(name: &str, bytes: &[u8]) -> Vec<u8> {
    latkit::host::Job::geojson(name, bytes).into_bytes()
}

/// The compiled module, for workers to instantiate.
#[wasm_bindgen]
pub fn module() -> JsValue {
    wasm_bindgen::module()
}

/// A CSS gradient through `map` (JSON), a catalog name or colors of your own, toward `direction`: the
/// colors the GPU draws, a band each for a categorical map's categories.
#[wasm_bindgen(js_name = colormapCss)]
pub fn colormap_css(map: &str, direction: &str) -> Result<String, Error> {
    let map: latkit::Colormap = json("colormap", map)?;
    let css = |color: latkit::Color| {
        let [r, g, b, a] = color.to_rgba8();
        format!("rgba({r}, {g}, {b}, {:.3})", f32::from(a) / 255.0)
    };
    let percent = |at: f32| format!("{}%", (at * 1e4).round() / 100.0);
    let stops: Vec<String> = if map.kind() == latkit::ColormapKind::Categorical {
        let n = map.count();
        (0..n)
            .map(|i| {
                let span = [i, i + 1].map(|at| percent(at as f32 / n as f32));
                format!("{} {} {}", css(map.sample(i as f32)), span[0], span[1])
            })
            .collect()
    } else {
        (0..=32).map(|i| format!("{} {}", css(map.sample(i as f32 / 32.0)), percent(i as f32 / 32.0))).collect()
    };
    Ok(format!("linear-gradient({direction}, {})", stops.join(", ")))
}
