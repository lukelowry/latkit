---
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/diagram': minor
'@latkit/video': patch
'@latkit/model': patch
---

Network, monitor, and diagram build on one item-view base, so camera, selection, picking, hover, style, input, and events behave the same in each.

Added

- `ItemView`, `ItemViewConfig`, `ItemEvents`, `ViewCamera`, `ViewInput`, `PickOptions`, `ViewStats`, `ViewStyle`, `viewStyle`, and `Point` in gpu.
- `kit.BaseItemView`, `kit.resolveViewStyle`, `kit.Attachments`, `kit.Work`, `kit.Expanded`, and `kit.HoverSearch`.
- `gpu.shaderModule(code, label)`: validated shader modules, shared by identical code.
- `stats()` on every view, with frames, preparation time, draw calls, picking bytes, and hover state and time; `pick(point, { radiusPx, limit, signal })` on every item view.
- `selectedColor: null`, which keeps each selected item's own color.
- `benchmark/`, with `pnpm bench`, `pnpm bench:update`, `pnpm bench:gate`, and a CI gate.

Changed

- One set of shared style options and defaults: `background` (was `backgroundColor`), `hoverWidthPx`, `selectedWidthPx`, `selectedColor`, `msaa`, `hover`, `hoverBudgetMs`, `pickRadiusPx`, `fitPaddingPx`, `revealPaddingPx`, `animationMs`, `motion`, `font`, `fontSizePx`, and `textColor`.
- `pick` returns hits nearest first, topmost breaking ties, at most 16 by default.
- `fit(items)` frames once; `fit()` and `set({ camera: null })` follow all the data. Moving a framed camera key turns `fit` off.
- Events arrive together after each frame, in order: `frame`, `camera`, `hover`, `select`.
- Unknown options and limits, and invalid cameras, throw `invalid-input`.
- `SetOptions`, `DataHit`, `ContextMenu`, `Modifiers`, and `HoverState` moved from `kit` to the root export.
- Network: `showVertices`, `showEdges`, `showPoles`, `showGraticule`, `showEarthAxis` → `markers`, `lines`, `poles`, `graticule`, `earthAxis`; `graticuleColor` → `gridColor`; `vertexHoverPx`/`edgeHoverPx` → `hoverWidthPx`; `vertexSelectedPx`/`edgeSelectedPx` → `selectedWidthPx`; limits `maxVertices`, `maxSegments`, `cpuBytes` → `vertices`, `segments`, `geometryBytes`, `pickingBytes`. Items compare by kind, index, and row.
- Diagram: `selectionWidthPx` → `selectedWidthPx`; limit `prepareMs` → `layoutMs`.
- Monitor: `focusColor` → `selectedColor`; `stats().traces` → `rows`; selection survives appends.
- Model: a sampled field bound both by name and as a binding to the request's own source is read once; such reads no longer stall under a frames window.

Removed

- `kit.HoverOptions`, `NetworkInput`, `MonitorInput`, and monitor `PickOptions`; use `ViewStyle`, `ViewInput`, and `PickOptions`.
