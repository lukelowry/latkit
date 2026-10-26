//! Canvases, which show views in the panels of their layout.

use latkit::web::{PageView, Panel};
use wasm_bindgen::prelude::*;

use crate::Error;

/// A view handle from `view.handle()`, for a canvas to show or a shot to draw.
#[wasm_bindgen]
pub struct Handle(pub(crate) PageView);

/// The views behind `handles`.
pub(crate) fn views_of(handles: Vec<Handle>) -> Vec<PageView> {
    handles.into_iter().map(|h| h.0).collect()
}

/// Pairs each of `views` with its panel. `at` holds four fractions per view, `[x, y, width,
/// height]`, in order. Fails unless `at` has four values per view.
pub(crate) fn layout(views: Vec<Handle>, at: &[f32]) -> Result<Vec<Panel>, Error> {
    if at.len() != views.len() * 4 {
        return Err(latkit::Error::invalid("expected four fractions per view").at("layout").into());
    }
    let (ats, _) = at.as_chunks::<4>();
    Ok(views.into_iter().zip(ats).map(|(view, at)| Panel { view: view.0, at: *at }).collect())
}

/// Views shown in a `<canvas>` or an `OffscreenCanvas`, in the panels of its layout. Freeing it
/// stops drawing them.
#[wasm_bindgen]
pub struct Canvas(pub(crate) latkit::web::Canvas);

#[wasm_bindgen]
impl Canvas {
    /// Replaces the shown views with `views`, each at its four fractions of `at`.
    #[wasm_bindgen(js_name = setLayout)]
    pub fn set_layout(&self, views: Vec<Handle>, at: &[f32]) -> Result<(), Error> {
        Ok(self.0.set_layout(layout(views, at)?)?)
    }
}
