---
'latkit': minor
---

The WebAssembly carries latkit's shaders, so a page serves one asset where it served two, and a test can lose the GPU device to check what follows.

- Removed: the `latkit/shaders` asset and the `shaders` option of `load()`. `latkit/wasm` carries the shaders, so `Gpu.create()` no longer waits for a second download or fails when it fails. The WebAssembly is 3.81 MB instead of 3.56 MB (1.24 MB with brotli), the same bytes a drawing page downloaded before.
- Removed: in Rust, `host::Browser::set_shaders`. A browser build carries its shaders.
- Changed: a worker URL on another origin, such as a CDN or a webview's resources, is fetched by the page and started from a Blob URL, instead of a Blob URL that imports it. The bundled worker follows the same rule, so latkit loaded from another origin starts its workers.
- Added: `gpu.lose()`, and `Gpu::lose` in Rust, lose the device as a GPU reset does, so a test can check that views move to a new device.
- Fixed: a WebGL2 context lost before the browser reports it is the device's loss, not an error. Before, the next frame raised a view error, and a canvas presented through a wgpu surface stopped latkit.
