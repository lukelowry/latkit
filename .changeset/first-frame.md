---
'latkit': minor
---

A view's first frame waits only for what draws its marks, a browser compiles what nearly every scene draws with as soon as its GPU exists, channels compile only what their marks read, and the wasm is an eighth smaller.

- Changed: pipelines compile through one queue per GPU, the most urgent first: what frames draw with at once, then their text, then what transitions, lit rows, probes, and queries need, a few at a time. In a browser `Gpu.create()` asks for what nearly every scene draws with straight away, and a view asks for its scene's as it is shown rather than at its first frame.
- Changed: a view's first frame draws its marks; labels, glyphs, and the overlay join once their pipelines landed, fading in as after any change. `complete` still waits for all of it.
- Changed: `loadLatkit()` starts the browser's GPU process while the runtime loads.
- Changed: a mark's channels compile for what they read: without fields of other tables or sampled fields, their pipeline leaves both out. Fitted domains reduce in the channels' own pipeline.
- Changed: every transition eases through the settled state, so evaluating channels knows nothing of transitions.
- Changed: expressions, sizes, labels, and colormaps are read where they are written, so error paths reach into expressions.
- Changed: the wasm is 12% smaller (11% gzipped): sorts, name-keyed tables, and JSON reading each compile once, and URLs resolve without the `url` crate.
- Removed: `selected()`, `hovered()`, `pointer()`, and `zoom()`. Hover and selection glow through the focus styles, and sizes in pixels hold across zoom.
