//! Canvases: a canvas shows views as its layout places them.

use latkit::web::{PageView, Panel};
use wasm_bindgen::prelude::*;

use crate::Error;

/// A view, for a canvas to show or a shot to draw: what `view.handle()` gives.
#[wasm_bindgen]
pub struct Handle(pub(crate) PageView);

/// The views `handles` name.
pub(crate) fn views_of(handles: Vec<Handle>) -> Vec<PageView> {
    handles.into_iter().map(|h| h.0).collect()
}

/// `views`, each placed `at` four fractions of its own: `[x, y, width, height]` after another.
pub(crate) fn layout(views: Vec<Handle>, at: &[f32]) -> Result<Vec<Panel>, Error> {
    if at.len() != views.len() * 4 {
        return Err(latkit::Error::invalid("a layout places each view at four fractions").at("layout").into());
    }
    let (ats, _) = at.as_chunks::<4>();
    Ok(views.into_iter().zip(ats).map(|(view, at)| Panel { view: view.0, at: *at }).collect())
}

/// Views shown in a `<canvas>` or an `OffscreenCanvas` as its layout places them; freeing it stops
/// drawing them.
#[wasm_bindgen]
pub struct Canvas(pub(crate) latkit::web::Canvas);

#[wasm_bindgen]
impl Canvas {
    /// Shows `views`, each placed `at` four fractions of its own, in place of those it showed.
    #[wasm_bindgen(js_name = setLayout)]
    pub fn set_layout(&self, views: Vec<Handle>, at: &[f32]) -> Result<(), Error> {
        Ok(self.0.set_layout(layout(views, at)?)?)
    }
}
