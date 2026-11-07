---
'latkit': patch
---

WebGL2 pages show their first frame about a quarter sooner on a first visit. Frames that zoom, evaluate rows, append, or answer the pointer draw faster in Chrome on Windows.

- Changed: a pipeline waits to compile while more urgent ones still compile, so the pipelines a first frame draws with have the browser's compile threads to themselves. Those that answer the pointer and draw lit rows and layers start once the GPU has finished the frames drawn with the others.
- Changed: building a pipeline no longer asks the browser for its errors, which waited for the browser's GPU process while it compiled. Translation and link errors still refuse the pipeline.
- Fixed: a shader's flat values come from the first vertex of each primitive, as WGSL defines. Chrome on Windows no longer runs every mark's draw through a geometry shader to take them from the last.
- Changed: the rows a frame evaluates are copied into place with one draw per batch, instead of a texture copy per page and row span.
- Changed: one task waits on everything the GPU is doing. Compiling programs are checked every 4 ms instead of every browser task, which kept the page busy while a scene compiled.
- Fixed: a native `Gpu` no longer opens OpenGL alongside Vulkan, DirectX 12, or Metal. On Windows, opening several at once from different threads could hang.
