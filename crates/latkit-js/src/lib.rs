//! The WebAssembly binding behind the latkit npm package: data and views in the browser, over
//! WebGPU.
//!
//! Values cross as bytes or JSON, in the forms `latkit` reads and writes. Patches cross as byte
//! frames, which the package's TypeScript writes. Scenes, cameras, fits, queries, and rows go in as
//! JSON. Events, hits, stats, and work come out as JSON, with a view's events in batches. A query's
//! columns come out as typed arrays, copied once. Asynchronous results cross as a cancellable
//! `Task`.

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

thread_local! {
    /// The package's callback for a panic, given its message.
    static STOPPED: std::cell::RefCell<Option<js_sys::Function>> = const { std::cell::RefCell::new(None) };
}

/// Logs a panic, stops latkit's frames and input, and tells the package, before the panic aborts.
#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| {
        console_error_panic_hook::hook(info);
        latkit::web::stop();
        let message = JsValue::from_str(&info.to_string());
        STOPPED.with(|stopped| {
            if let Ok(stopped) = stopped.try_borrow()
                && let Some(callback) = stopped.as_ref()
            {
                let _ = callback.call1(&JsValue::NULL, &message);
            }
        });
    }));
}

/// Calls `callback` with the message of a panic that stops latkit.
#[wasm_bindgen(js_name = onStop)]
pub fn on_stop(callback: js_sys::Function) {
    STOPPED.with(|stopped| *stopped.borrow_mut() = Some(callback));
}

/// Deserializes `text` from latkit's JSON form. Error paths are prefixed with `what`.
fn json<T: serde::de::DeserializeOwned>(what: &str, text: &str) -> Result<T, Error> {
    latkit::from_json(text).map_err(|e| e.at(what).into())
}

/// Serializes `value` to the JSON form the npm package's types describe.
fn to_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("latkit values serialize to JSON")
}
/// Runs views' jobs with `run`, the page's workers: `(bytes: Uint8Array) => Promise<Uint8Array>`.
#[wasm_bindgen(js_name = setJobs)]
pub fn set_jobs(run: js_sys::Function) {
    latkit::host::Browser::set_jobs(run);
}

/// Runs a job a view handed to the page, in a worker, and returns the result's bytes.
#[wasm_bindgen]
pub fn job(bytes: &[u8]) -> Vec<u8> {
    latkit::host::Job::from_bytes(bytes.to_vec()).run()
}

/// The compiled module, for workers to instantiate.
#[wasm_bindgen]
pub fn module() -> JsValue {
    wasm_bindgen::module()
}

/// The catalog of named colormaps, in order, as JSON `[{ name, label, kind }]`.
#[wasm_bindgen]
pub fn colormaps() -> String {
    let catalog: Vec<serde_json::Value> = latkit::Colormap::catalog()
        .map(|map| serde_json::json!({ "name": map.name(), "label": map.label(), "kind": map.kind() }))
        .collect();
    to_json(&catalog)
}

/// A CSS `linear-gradient` toward `direction` through `map`, given as JSON (a catalog name or
/// custom colors), in the colors the GPU draws. A categorical map gets one band per category.
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
