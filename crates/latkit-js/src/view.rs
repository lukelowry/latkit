//! Views: a scene drawn from the sources it is given, telling its events from the start; its state
//! read and set between frames, its questions answered by the frames that draw it.

use wasm_bindgen::prelude::*;

use crate::canvas::Handle;
use crate::data::{Snapshot, Source};
use crate::pending::{Task, task};
use crate::{Error, json, to_json};

/// A view of a scene, telling its events from the start.
#[wasm_bindgen]
pub struct View {
    pub(crate) view: latkit::web::PageView,
    pub(crate) _telling: latkit::web::Listener,
}

#[wasm_bindgen]
impl View {
    /// Draws `scene` (JSON) instead; an invalid scene changes nothing.
    #[wasm_bindgen(js_name = setScene)]
    pub fn set_scene(&self, scene: &str) -> Result<(), Error> {
        let scene = json("scene", scene)?;
        Ok(self.view.with(|v| v.set_scene(scene))?)
    }

    /// Draws the datasets `sources` give, in place of those given before.
    #[wasm_bindgen(js_name = setSources)]
    pub fn set_sources(&self, sources: Vec<Source>) -> Result<(), Error> {
        Ok(self.view.with(|v| v.set_sources(sources.into_iter().map(|s| s.0)))?)
    }

    /// The version of dataset `name` the view draws.
    pub fn snapshot(&self, name: &str) -> Option<Snapshot> {
        self.view.read(|v| v.snapshot(name).cloned()).map(Snapshot)
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

    /// Lays every vertex row without a position out again by the scene's layout: the bytes of a patch
    /// to each dataset, writing the places into the data.
    pub fn arrange(&self) -> Task {
        let pending = self.view.with(latkit::View::arrange);
        task(async move {
            let patches = pending.await?;
            Ok(patches.iter().map(|patch| js_sys::Uint8Array::from(&patch.to_bytes()[..])).collect::<js_sys::Array>())
        })
    }

    /// Where `position` (x, y, elevation) lands on screen, CSS pixels from the top left.
    pub fn screen(&self, position: &[f64]) -> Option<Vec<f32>> {
        let position: [f64; 3] = position.try_into().ok()?;
        self.view.read(|v| v.screen(position)).map(Vec::from)
    }

    /// The position on the ground under screen point `point`.
    pub fn position(&self, point: &[f32]) -> Option<Vec<f64>> {
        let point: [f32; 2] = point.try_into().ok()?;
        self.view.read(|v| v.position(point)).map(Vec::from)
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
    #[wasm_bindgen(js_name = setSelection)]
    pub fn set_selection(&self, rows: &str) -> Result<(), Error> {
        let rows: Vec<latkit::Rows> = json("rows", rows)?;
        self.view.with(|v| v.set_selection(rows));
        Ok(())
    }

    /// What the user points at, as a JSON hit or `null`.
    #[wasm_bindgen(getter)]
    pub fn hovered(&self) -> String {
        self.view.read(|v| to_json(&v.hovered()))
    }

    /// The work under way the last frame stood in for, as JSON.
    #[wasm_bindgen(getter)]
    pub fn waiting(&self) -> String {
        to_json(&self.view.read(latkit::View::waiting))
    }

    /// Whether the last frame drew everything as the data, scene, and camera say.
    #[wasm_bindgen(getter)]
    pub fn complete(&self) -> bool {
        self.view.read(latkit::View::complete)
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
    pub fn pick(&self, point: &[f32], radius: f32) -> Result<Task, Error> {
        let point: [f32; 2] = point.try_into().map_err(|_| latkit::Error::invalid("a point is [x, y]").at("point"))?;
        let pending = self.view.with(|v| v.pick(point, radius));
        Ok(task(async move { Ok(JsValue::from_str(&to_json(&pending.await?))) }))
    }

    /// Where the row (JSON) lies on screen, `[x, y]`, or `null`.
    #[wasm_bindgen(js_name = screenOf)]
    pub fn screen_of(&self, row: &str) -> Result<Task, Error> {
        let row: latkit::Row = json("row", row)?;
        let pending = self.view.with(|v| v.screen_of(&row));
        Ok(task(async move {
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
