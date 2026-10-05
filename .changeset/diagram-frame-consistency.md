---
'@latkit/model': minor
'@latkit/gpu': minor
'@latkit/network': patch
'@latkit/monitor': minor
'@latkit/diagram': minor
---

One text layout, spatial index, and change test for every view; diagram styles on the GPU.

Added

- model: `samePages`.
- gpu: `gpu.layoutText`; `kit.BoxIndex`, `kit.Occupancy`, `kit.sameValues`, and `kit.sameRecords`; `kit.fieldShader({ colormap })` adds `fieldColor`, and the field shader carries the scale WGSL.
- monitor: `coordinateAt(point)`, the coordinate under a canvas point of the drawn plot.

Changed

- Text draws from one glyph atlas, one SDF per font and grapheme, and repeated layouts are cached.
- diagram: bound colors, widths, flow, shade, and status are written on the GPU each frame, so restyling or playing them never rereads or reroutes the scene, and styles keep playing during a drag.
- diagram: wires route as net trees with separated tracks and rounded bends; ports, arrowheads, and junctions scale with the blocks; blocks draw a header band, outline, status ring, and shadow; picking holds typed arrays.
- diagram: `msaa` defaults to `1`, since every shape antialiases in its shader.
- monitor: a null visibility shows the trace; shade defaults to `0`.

Renamed

- diagram: `portSizePx` to `portSize` and `portFontSizePx` to `portFontSize`, in diagram units.

Removed

- gpu: `kit.scaleShader` (in `kit.fieldShader`), `kit.defaultShade`, and `kit.localPoint`.
