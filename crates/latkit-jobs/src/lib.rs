//! The npm package's jobs module: the work views hand to the page's workers. It lays out graphs,
//! assigns edge lanes, triangulates areas, groups rows into tiles, and decodes vector tiles and
//! GeoJSON. The module that draws carries none of that code. A page loads this one the first time
//! a view or dataset has a job, and its workers run it.

#![cfg(target_arch = "wasm32")]
#![allow(unsafe_code, reason = "wasm-bindgen's generated glue")]

use wasm_bindgen::prelude::*;

/// Runs the job in `bytes` and returns its result's bytes. The job's bytes come in once, owned,
/// rather than borrowed and copied again.
#[wasm_bindgen]
pub fn job(bytes: Vec<u8>) -> Vec<u8> {
    latkit::host::Job::from_bytes(bytes).run()
}
