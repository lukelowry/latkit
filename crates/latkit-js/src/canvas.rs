//! Canvases: a canvas shows views in panels.

use latkit::web::PageView;
use wasm_bindgen::prelude::*;

use crate::Error;

/// A view, for a canvas to show or a shot to draw: what `view.handle()` gives.
#[wasm_bindgen]
pub struct Handle(pub(crate) PageView);

/// The views `handles` name.
pub(crate) fn views_of(handles: Vec<Handle>) -> Vec<PageView> {
    handles.into_iter().map(|h| h.0).collect()
}

/// Views shown in the panels of a `<canvas>` or an `OffscreenCanvas`; freeing it stops drawing them.
#[wasm_bindgen]
pub struct Canvas(pub(crate) latkit::web::Canvas);

#[wasm_bindgen]
impl Canvas {
    /// Shows `views`, one per panel, in place of those it showed.
    pub fn show(&self, views: Vec<Handle>) -> Result<(), Error> {
        Ok(self.0.show(&views_of(views))?)
    }
}
