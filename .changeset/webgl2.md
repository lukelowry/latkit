---
'latkit': minor
---

latkit draws with WebGL2 in browsers instead of WebGPU, so a page draws wherever the browser has WebGL2.

- Changed: in a browser, a `Gpu` is a WebGL2 device, and `Gpu.create()` rejects with an `unsupported` error where the browser has no WebGL2. latkit no longer uses `navigator.gpu`.
- Changed: a `Gpu`'s default budget is half the device's addressable word-texture capacity, at most 1 GiB, instead of half its largest storage buffer.
- Changed: `stats.gpuMs` comes from WebGL2 timer queries (`EXT_disjoint_timer_query_webgl2`), and is 0 where the browser has none.
- Changed: in Rust, the WebGL2 device reports the wgpu calls WebGL2 cannot do, such as compute passes, query sets, and indirect draws, as validation errors to its error scopes and handler.
- Removed: in Rust, the `gpu` feature without `web` no longer builds for `wasm32`, where it could not draw. Use `web` to draw, or `default-features = false` for data alone.
