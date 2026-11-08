---
'latkit': minor
---

Pages show their first frame sooner on a first visit, and no longer stall right after it. The WebAssembly is 3.4 MiB instead of 6.0 MiB (1.0 MiB with brotli instead of 1.3): latkit's shaders are translated to GLSL when it is built, so the page carries no WGSL compiler.

- Added: the `latkit/shaders` asset, the shaders translated for WebGL2. `load()` downloads it while the WebAssembly compiles, wherever a browser canvas is available. Its `shaders` option names another URL for it.
- Added: a custom marker's WGSL translates in a module of its own, `latkit_wgsl_bg.wasm`, which a page loads the first time it draws a custom marker.
- Added: in Rust, `host::Browser::set_shaders` hands over the shaders before a `Gpu` is created, and `host::Browser::set_translator` provides the custom marker translator. The `wgsl` feature translates custom markers in the page instead, and lets the WebGL2 device take WGSL shader modules.
- Changed: every raster pass writes one color target. Chrome on Windows built a shader again on its GPU thread the first time a pass wrote several, which froze the page for up to 1.6 s after its first frame.
- Changed: the WebGL2 canvas latkit draws through starts at the screen's size. Growing it waited for every shader compile in flight.
- Changed: shaders read columns and lists without branching around texture reads or indexing vectors at runtime, which made the D3D compiler behind Chrome on Windows take several times longer. Column descriptors are 8 words.
- Changed: a channel kernel is written in GLSL in a browser and evaluates only the channels the words it writes depend on.
- Removed: in a browser, `Gpu::from_wgpu` takes only the WebGL2 device of a `Gpu` from `Gpu::new`.
