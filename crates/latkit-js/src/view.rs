//! Views: a scene drawn from its sources, sending its events from the start. Its state is read and
//! set between frames, and its queries are answered by the frames that draw it.

use wasm_bindgen::prelude::*;

use crate::canvas::Handle;
use crate::convert::fixed;
use crate::data::{Snapshot, Source};
use crate::pending::{Task, task};
use crate::{Error, json, to_json};

/// A view of a scene, sending its events from the start.
#[wasm_bindgen]
pub struct View {
    pub(crate) view: latkit::web::PageView,
    pub(crate) _telling: latkit::web::Listener,
}

#[wasm_bindgen]
impl View {
    /// Replaces the scene with `scene` (JSON). An invalid scene changes nothing.
    #[wasm_bindgen(js_name = setScene)]
    pub fn set_scene(&self, scene: &str) -> Result<(), Error> {
        let scene = json("scene", scene)?;
        Ok(self.view.with(|v| v.set_scene(scene))?)
    }

    /// Replaces the view's sources with `sources`.
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

    /// Switches to `camera` (JSON, any of its fields) immediately. Only a pitch and bearing turn
    /// the camera, keeping a fit not yet applied.
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&self, camera: &str) -> Result<(), Error> {
        let turns = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(camera)
            .is_ok_and(|given| !given.is_empty() && given.keys().all(|key| key == "pitch" || key == "bearing"));
        let camera = self.camera_from(camera)?;
        self.view.with(|v| match camera {
            latkit::Camera::Map { pitch, bearing, .. } if turns => v.turn(pitch, bearing),
            camera => v.set_camera(camera),
        });
        Ok(())
    }

    /// Eases to `camera` (JSON, any of its fields) over `seconds`, or over twice the scene's ease
    /// without it.
    pub fn fly(&self, camera: &str, seconds: Option<f64>) -> Result<(), Error> {
        let camera = self.camera_from(camera)?;
        let seconds = seconds
            .map(|s| {
                std::time::Duration::try_from_secs_f64(s)
                    .map_err(|_| latkit::Error::invalid("expected nonnegative seconds").at("seconds"))
            })
            .transpose()?;
        self.view.with(|v| v.fly(camera, seconds));
        Ok(())
    }

    /// Frames what `fit` (JSON) names. Resolves to the camera it framed as JSON, or to `null` when
    /// a camera move or another fit replaced it.
    pub fn fit(&self, fit: &str) -> Result<Task, Error> {
        let fit = json("fit", fit)?;
        let framed = self.view.with(|v| {
            v.fit(fit);
            v.framed()
        });
        Ok(task(async move { Ok(JsValue::from_str(&to_json(&framed.await?))) }))
    }

    /// Resolves once a frame draws the view complete.
    pub fn done(&self) -> Task {
        let done = self.view.with(latkit::View::done);
        task(async move {
            done.await?;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Runs the scene's layout again on the vertex rows `rows` (JSON) names. Resolves to one patch
    /// per dataset, as bytes, that writes the computed positions into the data.
    pub fn arrange(&self, rows: &str) -> Result<Task, Error> {
        let rows = json("rows", rows)?;
        let pending = self.view.with(|v| v.arrange(rows));
        Ok(task(async move {
            let patches = pending.await?;
            Ok(patches.iter().map(|patch| js_sys::Uint8Array::from(&patch.to_bytes()[..])).collect::<js_sys::Array>())
        }))
    }

    /// The screen point of `position` (x, y, elevation), in CSS pixels from the top left.
    pub fn screen(&self, position: &[f64]) -> Result<Option<Vec<f32>>, Error> {
        let position = fixed::<_, 3>(position, "position")?;
        Ok(self.view.read(|v| v.screen(position)).map(Vec::from))
    }

    /// The position on the ground under screen point `point`.
    pub fn position(&self, point: &[f32]) -> Result<Option<Vec<f64>>, Error> {
        let point = fixed::<_, 2>(point, "point")?;
        Ok(self.view.read(|v| v.position(point)).map(Vec::from))
    }

    #[wasm_bindgen(getter)]
    pub fn insets(&self) -> Vec<f32> {
        self.view.read(|v| v.insets().to_vec())
    }

    #[wasm_bindgen(setter)]
    pub fn set_insets(&self, insets: &[f32]) -> Result<(), Error> {
        let insets = fixed::<_, 4>(insets, "insets")?;
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

    /// The selected rows, as JSON sets of rows.
    #[wasm_bindgen(getter)]
    pub fn selection(&self) -> String {
        self.view.read(|v| to_json(&v.selection()))
    }

    /// Selects exactly `rows` (JSON sets of rows).
    #[wasm_bindgen(js_name = setSelection)]
    pub fn set_selection(&self, rows: &str) -> Result<(), Error> {
        let rows: Vec<latkit::Rows> = json("rows", rows)?;
        self.view.with(|v| v.set_selection(rows));
        Ok(())
    }

    /// The row the user points at, as a JSON hit or `null`.
    #[wasm_bindgen(getter)]
    pub fn hovered(&self) -> String {
        self.view.read(|v| to_json(&v.hovered()))
    }

    /// The pending work the last frame drew placeholders for, as JSON.
    #[wasm_bindgen(getter)]
    pub fn waiting(&self) -> String {
        to_json(&self.view.read(latkit::View::waiting))
    }

    /// Whether the last frame was complete, with nothing in `waiting` still pending.
    #[wasm_bindgen(getter)]
    pub fn complete(&self) -> bool {
        self.view.read(latkit::View::complete)
    }

    /// Every option and mark that the data does not fit, as JSON failures.
    #[wasm_bindgen(getter)]
    pub fn failures(&self) -> String {
        self.view.read(|v| to_json(&v.failures().collect::<Vec<_>>()))
    }

    /// The view's per-frame statistics, as JSON.
    #[wasm_bindgen(getter)]
    pub fn stats(&self) -> String {
        to_json(&self.view.read(latkit::View::stats))
    }

    /// Whether the view needs a frame: it changed, or work it waited on arrived.
    #[wasm_bindgen(getter, js_name = wantsFrame)]
    pub fn wants_frame(&self) -> bool {
        self.view.wants_frame()
    }

    /// Every row within `radius` CSS pixels of `point`, nearest first, as JSON hits.
    pub fn pick(&self, point: &[f32], radius: f32) -> Result<Task, Error> {
        let point = fixed::<_, 2>(point, "point")?;
        let pending = self.view.with(|v| v.pick(point, radius));
        Ok(task(async move { Ok(JsValue::from_str(&to_json(&pending.await?))) }))
    }

    /// The screen point of `row` (JSON), or of its port `port`, as `[x, y]` in CSS pixels, or `null`
    /// if no mark draws it in view.
    #[wasm_bindgen(js_name = screenOf)]
    pub fn screen_of(&self, row: &str, port: Option<String>) -> Result<Task, Error> {
        let row: latkit::Row = json("row", row)?;
        let pending = self.view.with(move |v| v.screen_of(&row, port.as_deref()));
        Ok(task(async move {
            let point = pending.await?;
            Ok(point.map_or(JsValue::NULL, |p| js_sys::Array::of2(&p[0].into(), &p[1].into()).into()))
        }))
    }

    /// The rows connected to `row` (JSON), as JSON sets of rows: a vertex's neighbors across edges
    /// and nets, or an edge's or net's vertices.
    pub fn neighbors(&self, row: &str) -> Result<String, Error> {
        let row: latkit::Row = json("row", row)?;
        Ok(self.view.read(|v| to_json(&v.neighbors(&row))))
    }

    /// A handle to the view, for a canvas to show or a shot to draw.
    pub fn handle(&self) -> Handle {
        Handle(self.view.clone())
    }
}

impl View {
    /// The camera `camera` (JSON) describes, with the fields it leaves out taken from the view's
    /// camera.
    fn camera_from(&self, camera: &str) -> Result<latkit::Camera, Error> {
        let given: serde_json::Value = json("camera", camera)?;
        let mut merged = self.view.read(|v| serde_json::to_value(v.camera())).expect("a camera serializes");
        if let (Some(merged), Some(given)) = (merged.as_object_mut(), given.as_object()) {
            merged.extend(given.clone());
        }
        json("camera", &merged.to_string()).or_else(|_| json("camera", camera))
    }
}
