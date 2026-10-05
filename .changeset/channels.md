---
'@latkit/model': minor
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/diagram': minor
---

Every per-row option is a channel: one value for every row, a field, or a field through a scale. Positions are `x`, `y`, and `z` channels, every view reads its channels through one shader struct, and a view's defaults are named after the channels they stand in for.

Added

- gpu: `Channel` and `ColorChannel`; `component` on `Scale` and `ColorScale`, and `missing` on both.
- gpu: `kit.bindChannels`, `kit.resolveChannels`, `kit.resolveChannel`, `kit.channelValue`, `kit.channelOn`, `kit.writeChannel`, and `kit.resolveLabels`; `LatkitChannel`, `channelNumber`, `channelOn`, `channelColor`, and `finiteValue` in `kit.fieldShader`.
- gpu: `stride` on `BufferData.update`, which compares whole records.
- network: `x`, `y`, and `z` on vertices; `x` and `y` on a net, where its star meets; `dash` and `shade` on paths; `pathColor` and `pathWidthPx`; `LineOptions`, the options edges and paths share.
- diagram: `x`, `y`, `width`, and `height` on vertices; `Positions`.
- monitor: a trace's `y`; `traceColor` and `traceWidthPx`.

Changed

- network, diagram, and monitor: `radiusPx`, `widthPx`, `flowPx`, `visible`, `shade`, `dash`, and `status` each take one value, a field name, or a scale. A `widthPx` field draws each network and monitor line at its own width, and spans 1 to 4 CSS pixels in every view.
- `color` takes one color for every row, in place of `baseColor`; a scale's `missing` fills rows its field leaves empty.
- A boolean channel is on where it reads true or positive in every view; the diagram and monitor showed negative values.
- `null` in a config means unset everywhere: options that used it as a value take `'ends'`, `'now'`, or `'none'`.
- A view keeps a field name as given: `config` holds `color: 'load'`, not `{ field: 'load' }`.
- diagram: `arrange` and a move proposal's `positions` give each type's `{ x, y }`, to spread into its options.
- gpu: `revealPaddingPx` takes insets, like `fitPaddingPx`.
- gpu: the views of a composition keep their memoized work apart.
- gpu: `BufferData.update` records one revision for all it changed, so a consumer uploads those ranges rather than everything.
- network: each page's uniform stays on the GPU between frames, and a frame uploads only the pages that changed; a frame where nothing moved uploads about an eighth of what it did at a million buses.

Renamed

- network: vertex `height` to `z`, `sizePx` to `radiusPx`, and an edge's `junction` to `x` and `y`; `vertexBaseColor` to `vertexColor`, `edgeBaseColor` to `edgeColor` (`'ends'` for `null`), `heightScale` to `zScale`, and `graticule` to `grid`; a label's `sizePx` to `fontSizePx`.
- diagram: `vertexBaseColor` to `vertexColor`, `edgeBaseColor` to `edgeColor`, `flow` to `flowPx`, and a label's `size` to `fontSize`.
- monitor: a trace's `field` to `y`; the camera's `window` and `values` to `x` and `y`; `coordinateAxis` and `valueAxis` to `xAxis` and `yAxis`.
- gpu: `selectedColor: null` to `'none'`; network `sunTime: null` to `'now'`.

Removed

- network and diagram: `position` and `baseColor`. diagram: `size`, now `width` and `height`. monitor: `baseColor`.
- gpu: `Position2D`, `kit.Expanded`, `ConfigShape.fields` and `nested`, and `kit.scaleParameters`; `LatkitScale`, `scaleMapped`, `fieldNumber`, `fieldScaled`, and `fieldColor` in shaders.
- diagram: `DiagramEvents.open`, which every item view's events already carry.
