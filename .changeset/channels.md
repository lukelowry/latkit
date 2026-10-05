---
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/diagram': minor
---

Every per-row option is a channel: one value for every row, a field, or a field through a scale. Positions are `x`, `y`, and `z` channels, and every view reads its channels through one shader struct.

Added

- gpu: `Channel` and `ColorChannel`; `component` on `Scale` and `ColorScale`, and `missing` on `ColorScale`.
- gpu: `kit.bindChannels`, `kit.readChannels`, `kit.channelRead`, `kit.channelValue`, `kit.writeChannel`, and `kit.labelOptions`; `LatkitChannel`, `channelNumber`, `channelColor`, and `finiteValue` in `kit.fieldShader`.
- gpu: `stride` on `BufferData.update`, which compares whole records.
- network: `x`, `y`, and `z` on vertices; `x` and `y` on a net, where its star meets; `dash` and `shade` on paths; `LineOptions`, the options edges and paths share.
- diagram: `x`, `y`, `width`, and `height` on vertices; `Positions`.
- monitor: a trace's `y`.

Changed

- network, diagram, and monitor: `sizePx`, `widthPx`, `flow`, `visible`, `shade`, `dash`, and `status` each take one value, a field name, or a scale. A `widthPx` field draws each network and monitor line at its own width.
- `color` takes one color for every row, in place of `baseColor`; a color scale's `missing` colors rows its field leaves empty.
- A view keeps a field name as given: `config` holds `color: 'load'`, not `{ field: 'load' }`.
- diagram: `arrange` and a move proposal's `positions` give each type's `{ x, y }`, to spread into its options.
- gpu: the views of a composition keep their memoized work apart.
- gpu: `BufferData.update` records one revision for all it changed, so a consumer uploads those ranges rather than everything.
- network: each page's uniform stays on the GPU between frames, and a frame uploads only the pages that changed; a frame where nothing moved uploads about an eighth of what it did at a million buses.

Renamed

- network: vertex `height` to `z`, and an edge's `junction` to `x` and `y`.
- monitor: a trace's `field` to `y`.

Removed

- network and diagram: `position` and `baseColor`. diagram: `size`, now `width` and `height`. monitor: `baseColor`.
- gpu: `Position2D`, `kit.Expanded`, `ConfigShape.fields` and `nested`, and `kit.scaleParameters`; `LatkitScale`, `scaleMapped`, `fieldNumber`, `fieldScaled`, and `fieldColor` in shaders.
