---
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/diagram': minor
'@latkit/video': minor
---

A renderer is its own view: `createX(gpu, config)` draws on the config's canvas, handles its input,
and shares one API with every other view.

Added

- `View`: `config`, `set(patch, { animate })`, `image(options)`, `on`, `destroy`. Networks,
  monitors, diagrams, and compositions add `camera`, `selection`, `select(items)`, `pick(point)`,
  `locate`, `fit(items?)`, `reveal`, and `stats`.
- Config keys every view shares: `canvas`, `at`, `paused`, `input`, `camera`, `shade`, `limits`.
- `set` merges keyed records per entry, `camera`/`input`/`limits`/`layout` per option, and removes
  with `null`.
- `frame`, `camera`, and `error` events; `select` reports arrays everywhere.
- Shorthands: `color: 'load'`, `labels: 'name'`, `colormap: 'viridis'`, `layout: 'layered'`,
  `valueAxis: 'Temperature'`.
- Networks halo any number of selected items.
- `kit`: the renderer-authoring namespace of `@latkit/gpu`, with `kit.BaseView`.

Changed

- `createNetwork(gpu, config)`, `createMonitor(gpu, config)`, `createDiagram(gpu, config)`,
  `createComposition(gpu, { views: [{ view, region: [x, y, w, h] }] })`,
  `exportVideo(view, options)`, and `arrange(gpu, config, { signal })`.
- Style options sit on the config; the `data` and `options` buckets are gone.
- `pick` is asynchronous everywhere.
- Network camera: `center: [x, y]`, plus `fit` and `orbit`. Diagram camera: `{ center, scale, fit }`.
  Monitor camera: `{ window, values, fit, follow }`, holding the former `data.window`,
  `valueDomain`, and `follow`.
- `@latkit/gpu` exports only the app surface; renderer plumbing moved under `kit`.

Renamed

- Network `vertices`/`edges`/`poles`/`graticule`/`earthAxis` options → `showVertices`/`showEdges`/
  `showPoles`/`showGraticule`/`showEarthAxis`.
- `hitTest` → `pick`.
- `Limits` → `NetworkLimits`, `MonitorLimits`, `DiagramLimits`; `InputOptions` → `NetworkInput`,
  `MonitorInput`, `DiagramInput`.

Removed

- `createCanvasView` and `attachNetworkInput`/`attachMonitorInput`/`attachDiagramInput`: views own
  their canvas and input.
- Every `set*` method, `getCamera`, `panBy`/`rotateBy`/`zoomBy`, `orbit()`, `setPointer`, `toData`,
  and `toDiagram`.
- `invalidate`, `fit`, `orbit`, `window`, and `valueDomain` events.
- `PROJECTIONS` and the `Options` exports.
