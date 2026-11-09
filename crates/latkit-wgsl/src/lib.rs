//! The npm package's WGSL translator. latkit's browser build carries no WGSL compiler, so a custom
//! marker's shader translates to GLSL ES 3.00 here, in a module the page loads the first time it
//! draws a custom marker. It translates with the same code as latkit's build.

#![cfg(target_arch = "wasm32")]
#![allow(unsafe_code, reason = "wasm-bindgen's generated glue")]

#[path = "../../latkit/src/gpu/prune.rs"]
mod prune;

#[path = "../../latkit/src/gpu/glsl.rs"]
mod glsl;

use std::collections::BTreeMap;

use wasm_bindgen::prelude::*;

/// Each entry point of the WGSL module `wgsl` in GLSL ES 3.00, as a JSON object by name, or a JSON
/// object of the `error` that stopped the translation.
#[wasm_bindgen]
pub fn translate(wgsl: &str) -> String {
    let translated =
        naga::front::wgsl::parse_str(wgsl).map_err(|error| error.emit_to_string(wgsl)).and_then(|module| {
            module
                .entry_points
                .iter()
                .map(|point| Ok((point.name.clone(), glsl::translate(&module, &point.name)?)))
                .collect::<Result<BTreeMap<String, String>, String>>()
        });
    let answer = translated.unwrap_or_else(|error| BTreeMap::from([("error".to_owned(), error)]));
    serde_json::to_string(&answer).expect("strings serialize")
}
