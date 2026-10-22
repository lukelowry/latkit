---
'latkit': patch
---

A view's first frame waits only for what draws its marks, a browser's first GPU is made while the runtime loads, channels compile only what their marks read, and the wasm is an eighth smaller.

- Changed: pipelines compile through one queue per GPU, the most urgent first: what frames draw with at once, their text as the browser's compile workers free up, then what transitions, lit rows, probes, and queries need, a few at a time. A view asks for its scene's as it is shown rather than at its first frame.
- Changed: in a browser the GPU readies what nearly every scene draws with, draws first, once the first scene's frames have all they draw with, or 300 ms after it is made if no view asked by then.
- Changed: `loadLatkit()` asks for the GPU adapter as the runtime starts loading and makes the page's first GPU as it loads; the first `Gpu.create()` takes it.
- Changed: a view's first frame draws its marks; labels, glyphs, and the overlay join once their pipelines landed, fading in as after any change. `complete` still waits for all of it.
- Changed: a mark's channels compile for what they read: without fields of other tables, sampled fields, or `selected()`, `hovered()`, `pointer()`, and `zoom()`, their pipeline leaves each out. Fitted domains reduce in the channels' own pipeline.
- Changed: every transition eases through the settled state, so evaluating channels knows nothing of transitions.
- Changed: expressions, sizes, labels, and colormaps are read where they are written, so error paths reach into expressions.
- Changed: the wasm is 12% smaller (11% gzipped): sorts, name-keyed tables, and JSON reading each compile once, and URLs resolve without the `url` crate.
