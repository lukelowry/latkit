//! Playheads, which move the axis coordinate the views that follow them show.

use wasm_bindgen::prelude::*;

use crate::convert::fixed;
use crate::{Error, Listener};

/// A playhead views follow.
#[wasm_bindgen]
pub struct Playhead(pub(crate) latkit::web::Playhead);

#[wasm_bindgen]
impl Playhead {
    /// A paused playhead at `at`.
    #[wasm_bindgen(constructor)]
    pub fn new(at: f64) -> Playhead {
        Playhead(latkit::web::Playhead::new(at))
    }

    #[wasm_bindgen(getter)]
    pub fn at(&self) -> f64 {
        self.0.at()
    }

    /// Moves it, and every view that follows it, to `at`.
    pub fn seek(&self, at: f64) {
        self.0.seek(at);
    }

    #[wasm_bindgen(getter)]
    pub fn rate(&self) -> f64 {
        self.0.rate()
    }

    #[wasm_bindgen(getter)]
    pub fn playing(&self) -> bool {
        self.0.playing()
    }

    /// Plays at `rate` axis units per second.
    pub fn play(&self, rate: f64) {
        self.0.play(rate);
    }

    pub fn pause(&self) {
        self.0.pause();
    }

    /// The coordinates it stays between, or `undefined`.
    #[wasm_bindgen(getter)]
    pub fn span(&self) -> Option<Vec<f64>> {
        self.0.span().map(Vec::from)
    }

    /// Keeps it between two coordinates, or anywhere with `undefined`.
    #[wasm_bindgen(setter)]
    pub fn set_span(&self, span: Option<Vec<f64>>) -> Result<(), Error> {
        let span = span.map(|span| fixed::<_, 2>(&span, "span")).transpose()?;
        self.0.set_span(span);
        Ok(())
    }

    /// Whether it plays along the end of its span as the span grows.
    #[wasm_bindgen(getter)]
    pub fn live(&self) -> bool {
        self.0.live()
    }

    #[wasm_bindgen(setter)]
    pub fn set_live(&self, live: bool) {
        self.0.set_live(live);
    }

    #[wasm_bindgen(getter)]
    pub fn looping(&self) -> bool {
        self.0.looping()
    }

    #[wasm_bindgen(setter)]
    pub fn set_looping(&self, looping: bool) {
        self.0.set_looping(looping);
    }

    /// Calls `listener` with the coordinate whenever it moves. Freeing the listener stops it.
    pub fn on(&self, listener: js_sys::Function) -> Listener {
        Listener(self.0.on(move |at| {
            let _ = listener.call1(&JsValue::NULL, &at.into());
        }))
    }
}
