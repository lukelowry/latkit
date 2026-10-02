# @latkit/network

## 0.15.2

### Patch Changes

- 5f19f4e: Store field pages and sample indexes in persistent balanced collections. Appending shares earlier
  storage instead of copying and reindexing the full history. TableData.fields now contains readonly
  ColumnPages: use at() or iteration rather than array indexing and construct columns through
  createData/appendData. copyBuffers preserves the indexed representation. Add appendedPages,
  samplePages, and resolveRows for consistent indexed suffix, window, and row-coverage access.

  Compile field bindings in the shared GPU layer independently of Data snapshots. Resolve row
  identity without gathering bound values, and cache each point field independently so static
  columns and slower sampled fields remain reusable through playback, including reordered IDs.
  Index cached reads by their actual dependencies, and reuse network binding records across frames.
  Monitor append detection now visits only added pages while preserving cancellation and replacement
  semantics. Application view usage is unchanged.

- Updated dependencies [5f19f4e]
- Updated dependencies [5f19f4e]
  - @latkit/model@1.0.0
  - @latkit/gpu@0.11.1

## 0.15.1

### Patch Changes

- dc8b6a0: Replace renderer prepare/encode hooks with captured and prepared frame contracts. Ordinary
  invalidation schedules the latest state without cancelling valid work; canvas playback coalesces
  requests without adding an extra animation-frame wait. Compositions capture every child before
  preparation, and images and video share submission and discard behavior.

  Monitor append progress survives cancelled frames and tracks independently sampled fields.
  Bounded camera-independent tiles reuse geometry and exact bounds for domain changes, with local
  refinement at summary boundaries and local rereads on cache misses. Models and transport remain
  free of observation retention and replay.

- Updated dependencies [dc8b6a0]
- Updated dependencies [dc8b6a0]
- Updated dependencies [70030a4]
  - @latkit/gpu@0.11.0
  - @latkit/model@0.15.0

## 0.15.0

### Minor Changes

- 145a02d: Breaking change: remove model retention and historical reads. Models publish one-pass passive
  transactions, commands are a separate optional capability, and applications own immutable
  columnar Data. Views consume Data directly and accept updates with set({ source: nextData }).
  Local read computes rows, samples, aggregates, and envelopes without contacting a producer.
  Connect protocol 3 removes queryable roots, retained reference trees, and remote exports;
  upgrade both peers together. Delivered values survive unsubscribe and disconnect. Shared
  unchanged pages preserve local read caching and GPU uploads.
- 145a02d: A renderer is its own view: `createX(gpu, config)` draws on the config's canvas, handles its input,
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

### Patch Changes

- Updated dependencies [145a02d]
- Updated dependencies [145a02d]
  - @latkit/model@0.14.0
  - @latkit/gpu@0.10.0

## 0.14.0

### Minor Changes

- 1ade156: Topology is data: a reference field wires each row to a row of another type, and views draw
  those types as vertices and edges.

  Added

  - `Schema.types` with `TypeDefinition`, and `ReferenceColumn`: row numbers under the referenced
    type's `Index`, read like any field. `numberAt` reads them.
  - `direction: 'in' | 'out'` on reference fields.
  - `ends` on network and diagram edges: the two reference fields a row joins. Without `ends` an edge
    type is a net, joining the vertices whose references name each row.

  Changed

  - `spatial.system` is `'geographic' | 'cartesian'`; the network reads its coordinates from it.
  - Diagram ports are the reference fields that name a drawn net; `arrows` is a boolean.
  - `ConnectProposal.replaces` names the net and the port leaving it.
  - A `reference` parameter takes `to`; problem targets are `row` and `field` with a type.

  Renamed

  - Diagram: `components`/`connections` → `vertices`/`edges`, `setComponent`/`setConnection` →
    `setVertex`/`setEdge`, item kinds `component`/`connection` → `vertex`/`edge`,
    `ComponentOptions`/`ConnectionOptions` → `VertexOptions`/`EdgeOptions`, `EntityRef` → `RowRef`,
    `ConnectionGesture` → `ConnectProposal`, `RouteEndpoint` → `RouteEnd`, `LayoutNode` →
    `LayoutVertex`, `Group.components` → `Group.vertices`.
  - Diagram options and limits: `nodePadding`, `nodeGap`, `componentBaseColor`, `connectionBaseColor`,
    `connectionWidthPx`, `animationMaxComponents`, `connectionRadiusPx` → `vertexPadding`,
    `vertexGap`, `vertexBaseColor`, `edgeBaseColor`, `edgeWidthPx`, `animationMaxVertices`,
    `connectRadiusPx`; `components`/`connections`/`endpoints` → `vertices`/`edges`/`ends`.
  - Network `focusEndpointMode` → `focusEnds`.

  Removed

  - `components`, `connections`, and `tables`, with `ComponentDefinition`, `ComponentPort`,
    `ConnectionDefinition`, `ConnectionRole`, and `TableDefinition`.
  - The `endpoints` and `links` queries and blocks.
  - Network `coordinates` and `connectivity`; diagram roles and end ordinals.

### Patch Changes

- Updated dependencies
- Updated dependencies [1ade156]
  - @latkit/gpu@0.9.0
  - @latkit/model@0.13.0

## 0.13.0

### Minor Changes

- 01975bd: Replace the previous model and rendering APIs with native Queryable data, explicit
  retained acquisitions, shared GPU rendering, and worker/socket connections.

  Network and monitor use the shared GPU and canvas-view lifecycle. Video exports
  renderers directly, including composed views. Colors now come from @latkit/gpu.
  Rewrite usage guides and package READMEs for these APIs.

  This is a breaking pre-1.0 release. Migrate consumers together; the retired port,
  colormaps, document-session, and scene-snapshot APIs have no compatibility exports.
  The diagram package remains private and declaration-only.

### Patch Changes

- Updated dependencies [01975bd]
  - @latkit/model@0.12.0
  - @latkit/gpu@0.8.0
