---
'@latkit/model': minor
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/diagram': minor
---

One text system, spatial index, memo, and change test for every view; positions declare their space; diagram styles on the GPU.

Added

- model: `samePages`; `fieldDefinition` and `positionField`; `space` on a position field, with `Space`; `ReadScope.recording` and `ReadScope.hold`, with `ReadRecord`.
- gpu: `gpu.layoutText`; `kit.BoxIndex`, `kit.Occupancy`, `kit.sameValues`, and `kit.sameRecords`; `kit.fieldShader({ colormap })` adds `fieldColor`, and the field shader carries the scale WGSL.
- gpu: `frame.memo(slot, deps, build)`, reused until its deps, the coordinate of a sampled read, a bound buffer, or held memory change.
- gpu: `kit.TextBank`, `kit.textOrigin`, and `kit.textBox`; `TextAlign` and `TextBaseline`; `align` on `TextLayoutInput`; `baseline`, `lineHeight`, `capHeight`, and `align` on `TextLayout`; `latkitAnchor` and a pixel halo in `kit.textShader`.
- monitor: `coordinateAt(point)`, the coordinate under a canvas point of the drawn plot.
- network: `repeatSpacingPx` on labels.

Changed

- Text draws from one glyph atlas, one SDF per font and grapheme, and repeated layouts are cached. Lines are the font's ascent and descent tall, so every string of a font shares one baseline, and titles, port names, wire labels, and axis ticks center by their capitals.
- `TextBitmap.ascent` and `descent` are the font's line metrics; the rasterizer reports `fontBoundingBox` values.
- `textColor(uv, color, halo, haloPx)` in `kit.textShader` takes a halo.
- network: labels try right, left, above, and below a marker, never over another marker, with a halo over lines; line labels center on their line.
- network and diagram: field reads, scales, style passes, and scene geometry are memoized, so a frame where nothing changed reads and uploads nothing.
- diagram: bound colors, widths, flow, shade, and status are written on the GPU, so restyling or playing them never rereads or reroutes the scene, and styles keep playing during a drag.
- diagram: wires route as net trees with separated tracks and rounded bends; ports, arrowheads, and junctions scale with the blocks; blocks draw a header band, outline, status ring, and shadow; titles read on any fill; picking holds typed arrays.
- diagram: `msaa` defaults to `1`, since every shape antialiases in its shader.
- monitor: a null visibility shows the trace; shade defaults to `0`.

Renamed

- diagram: `portSizePx` to `portSize` and `portFontSizePx` to `portFontSize`, in diagram units.
- gpu: `kit.BoxIndex.query` to `kit.BoxIndex.some`, which visits until told to stop and allocates nothing.

Removed

- model: `TypeDefinition.spatial`; a position field declares `space` instead. Schemas cross connect, so peers upgrade together.
- gpu: `TextLayout.ascent` and `descent`; `kit.scaleShader` (in `kit.fieldShader`), `kit.defaultShade`, and `kit.localPoint`.
