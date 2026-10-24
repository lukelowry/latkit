//! The latkit npm package: data and views for the browser, over WebGPU.
//!
//! What crosses is bytes or JSON, in the forms `latkit` reads and writes. Patches cross as their byte
//! frames, which the package's TypeScript writes itself; scenes, cameras, fits, queries, and rows go
//! in as JSON, and events, hits, stats, and work come out as JSON, a view's events a batch at a time.
//! A query's columns come out as typed arrays, copied once. What the page waits for crosses as a
//! task it may cancel.

#![cfg(target_arch = "wasm32")]
#![allow(unsafe_code, reason = "wasm-bindgen's generated glue")]
#![allow(missing_docs, reason = "documented in the npm package's TypeScript")]

mod canvas;
mod convert;
mod data;
mod error;
mod gpu;
mod pending;
mod shot;
mod view;

use wasm_bindgen::prelude::*;

pub use canvas::{Canvas, Handle};
pub use data::{Data, Snapshot, Source, read_patch};
pub use error::Error;
pub use gpu::{Gpu, Listener};
pub use pending::Task;
pub use shot::{Image, Video, image, set_encoder, video};
pub use view::View;

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
