---
'latkit': minor
---

Any mark can color its pixels with WGSL, and the shaders a view opens with compile sooner.

- Added: `shade` on every mark, and `Shade` with each mark's `.shade()` in Rust: WGSL that defines `fn shade(f: ShadeFragment) -> vec4f` and colors each pixel before it blends. It reads the mark's color, the pixel, the pointer, the time, and up to eight `inputs`. A shade that reads the time draws every frame, and one that reads the pointer draws as it moves. A shade that does not compile is its mark's failure.
- Changed: a custom marker sees only `MarkerFragment`, `MarkerColor`, and its own declarations, natively as in the browser. latkit's shader functions, such as `filled`, are no longer in scope, so a marker that called one fails to compile.
- Changed: a page translates a custom marker or shade once, alone, and appends it to latkit's shaders translated ahead of time. Before, it translated latkit's whole shader again for each variant that drew the marker.
- Changed: `stats.gpuMs` counts the GPU's work on a frame's commands, not its waits between them. On WebGL2 it read about three times the GPU's work.
- Changed: the passes that measure rows for a fit no longer hold back a view's first frame. They compile with the drawing pipelines only while a fit that measures rows waits for them.
- Changed: on Direct3D, edges and lines compile in about two thirds of the time, since their shaders read every value they might need and then select one, rather than branch around reads.
