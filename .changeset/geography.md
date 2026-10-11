---
'@latkit/geography': minor
'@latkit/gpu': minor
'@latkit/model': minor
'@latkit/network': minor
'@latkit/diagram': patch
---

A geography package draws the earth alone or beneath a network, and network edges curve over the globe and pick on every projection.

Added

- geography: `createGeography` draws the ground, areas, lines, and labels from Data, `geojson()`, or `tiles()`, flat or on a globe. Data prepares in workers, simplified alike along shared borders, and each frame draws what is in view at the detail it shows.
- geography: `geojson()` reads JSON text, a URL, a Blob such as a local file, or bytes, decoded and parsed in a worker.
- geography: `tiles()` reads vector tiles from a PMTiles archive by URL, as a local file, or as bytes; a `{z}/{x}/{y}` template; or TileJSON. A feature with an id is one item in every tile and zoom that holds it.
- geography: lines take `dash` and `flowPx` as network edges do, with `flowColor` and `flowSpacingPx`.
- network: `geography` draws a geography beneath the graph, in its pass. Its sun lights the graph, and a gesture the graph leaves reaches it.
- network: the `mercator` projection, for geographic data.
- network: edges curve over the globe on the GPU, in as many pieces as the screen needs; geodesics also draw on flat and mercator maps.
- gpu: `Labels` takes `fontSizePx` and `repeatSpacingPx`, for every view that labels in CSS pixels.
- gpu: `Projection` and `ProjectedCamera`; `kit.Projector` and `kit.projectionShader`, one projection in TypeScript and WGSL; `kit.layerOf` and the `Layer` types, which draw one view beneath another; `stroke_comet` in `kit.strokeShader`; and `BaseView.paused`, called as a view pauses.
- model: `Work` takes a `WorkPriority`; `'background'` work yields to everything else.
- model: a `geographic` field may hold lists of positions, as polylines, and lists of those, as rings.

Changed

- network: an edge's `route` defaults to `geodesic` on the globe and `straight` on flat maps.
- network: geographic positions start on the mercator plane, as a geography does.
- network: picking and hover query hit-test indexes on every projection, built in the background once the positions and the camera hold still. Only rows raised by `z` scan.
- network: a dashed edge picks along its whole length, gaps included.
- network: a camera move uploads no draw parameters, and a frame draws edges in one render pass.
- gpu: `ItemViewConfig` holds no `source`; each view's config declares its own.

Removed

- network: `paths`, `PathOptions`, and `LineOptions`. Draw lines that join no vertices as a geography's `lines`.
- network: `grid`, `gridColor`, `earthAxis`, `surfaceColor`, `daylight`, `sunTime`, `nightFloor`, `surfaceNightFloor`, `terminatorWidth`, `pathColor`, and `pathWidthPx`. Set `graticule`, `graticuleColor`, `earthAxis`, `surfaceColor`, `daylight` (a time, `'now'`, or `false`), `nightFloor`, and `terminatorWidth` on a geography.
- network: `Camera` and `Projection`. Import `ProjectedCamera` and `Projection` from `@latkit/gpu`.
- network: `NetworkLabels`. Its `fontSizePx` and `repeatSpacingPx` are `Labels` options now.
