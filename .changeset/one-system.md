---
'@latkit/model': major
'@latkit/connect': major
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/diagram': minor
'@latkit/video': minor
---

One failure, one item identity, one view contract, one option vocabulary, and one memory budget, with constant CPU work per frame.

Added

- model: `Item`, `sameItem`, and `itemId`; `FailureCode` and `isFailure`; `createMemory`, `Memory`, `MemoryBudget`, and `MemoryStats`; `Work` and `interruptible`.
- gpu: the types an app names at the root, including `ViewConfig`, `ViewEvents`, `Patch`, `FrameInfo`, `Viewport`, `Composition`, `Scale`, `ColorScale`, `Position2D`, `Labels`, and the text types; `kit.resolveLimits` and `kit.clearColor`.
- Item views: a click in place cycles through overlapping hits and a modifier toggles the topmost; a double click or Enter reports `open`, and a double click on nothing fits the data.
- Compositions route pointer, wheel, menu, and key input to the view under the pointer.
- network: `baseColor` on vertex and edge types, and `widthPx` on edge types. diagram: `baseColor` on vertex and edge types.
- connect: `protocol.forward(id, bytes)` frames a received publication for another stream without encoding it again.

Changed

- Every package throws model `Failure`s. A peer's error keeps a code latkit knows, and malformed peer data reports `protocol`.
- `kit.BaseView`: `resolve` runs once per config, `configure` receives the resolved configs, and `prepare` returns what `encode` and `submitted` receive. `kit.BaseItemView` builds `pipelines` once per variant for every view of a kind, names the view in `kit.ItemShape`, and rejects options it does not know.
- One memory pool bounds the reader's cache, uploads, and GPU resources: `createReader({ memory })`, and `gpu.stats()` and `reader.stats()` return `MemoryStats`. Its defaults are the former sums.
- Frames pack their uniforms into shared buffers written once; upload cache hits allocate nothing; network dash phases hold while the camera moves; diagram drags move in the shader and reroute only the wires they touch, so a drag frame costs the same at any size.
- `image({ format, quality })` takes `png`, `jpeg`, or `webp`, and video `quality` is a number from 0 to 1, as for images.
- connect checks a model before it opens a socket.
- Internal dependencies publish as caret ranges, and every package whose types name WebGPU depends on `@webgpu/types`.

Renamed

- network: vertex `size` to `sizePx`, a radius in CSS pixels; label `size` to `sizePx`; `curve: 'linear'` to `route: 'straight'`; `focusEnds` to `selectedEnds` and `hoverEnds`; `Labels` to `NetworkLabels`.
- diagram: edge `width` to `widthPx`; `Labels` to `DiagramLabels`.
- connect limits drop `max`: `messageBytes`, `metadataBytes`, `bufferedBytes`, `bufferedMessages`, `streams`, `publicationBatches`, and `logs`.
- gpu: `createRenderTarget` to `createTextureTarget`; `GpuStats` and `Budget` to model `MemoryStats` and `MemoryBudget`.

Removed

- gpu: `GpuError`, `GpuErrorCode`, `DataHit`, `kit.Work`, `kit.wheelDelta`, `kit.createCanvasInput`, and `kit.withinBudget`.
- network: `focusEnabled`, `hoverAlpha`, and `selectedAlpha`; the alpha of `hoverColor` and `selectedColor` sets the halos.
- monitor: the `pickingBytes` limit.
- model: `ReaderStats`; reader `maxBytes`, `maxStagingBytes`, and `maxEntries`; `resolveRows`, `RowMapping`, `samplePages`, `copyBuffers`, `sliceColumn`, and `DEFAULT_BLOCK_BYTES`.
- connect: `remoteFailure`.
