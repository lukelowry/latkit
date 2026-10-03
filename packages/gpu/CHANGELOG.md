# @latkit/gpu

## 0.13.0

### Minor Changes

- 96f79d2: Exports never change a view, item views check every option the same way, and views stop cleanly with their Gpu.

  Added

  - `gpu.signal`: aborts when the Gpu stops, with `device-lost` or `closed`.
  - `FrameInfo.presented` and `RenderView.presented`: video, and images of a view on a canvas or in a composition, render frames that are not presented.
  - `kit.ItemShape`: an item view describes its framed camera keys, input modes, and style defaults once.

  Changed

  - Video, and images of a view on a canvas or in a composition, draw the view as it is and change nothing: its camera, hover, selection, and picking stay as presented. A monitor draws them into history of its own. A view with neither presents in its images.
  - Unknown camera and input options, and input modes a view does not have, throw `invalid-input` in every view, and the patch changes nothing.
  - A mode shorthand merges like the option it names: `set({ input: 'inspect' })` keeps `wheel` and `keyboard`.
  - The `frame` event reports the frame's `FrameInfo` and nothing it borrowed.
  - A right click opens the context menu where the button comes up; a right drag never opens it.
  - Views stop drawing when their Gpu stops: device loss reports one `device-lost` error per view, and destroying the Gpu reports none. The Gpu no longer keeps destroyed views alive.
  - `image()` and `exportVideo` wait for a canvas frame that cannot stop at once, instead of failing `busy`.
  - `view.config` is typed without `camera`, which lives on `view.camera`.
  - `kit.BaseItemView` takes `(gpu, config, shape)`; `compileShade` receives the `msaa` to compile for; `kit.BaseView`'s `moveCamera` hook is `cameraMove`, which validates before a patch applies.
  - Network: `pick`, clicks, and context menus wait for the background hit-test index, starting it at once, instead of building it on the main thread.
  - Video: an export ends with the Gpu's `device-lost` error.
  - Model: `sliceColumn` returns exactly its kind's keys, so a point read of a sampled field is a plain column however its pages lie; `selectRows` encodes each requested ID into one reused buffer.

  Removed

  - `Gpu.lost`; use `gpu.signal`.
  - `kit.BaseItemView`'s `framed` and `inputMode` members; use `kit.ItemShape`.

### Patch Changes

- Updated dependencies [96f79d2]
- Updated dependencies [96f79d2]
  - @latkit/model@2.1.0

## 0.12.0

### Minor Changes

- b958ddc: Move the CPU data layer from gpu into model as one bounded `Reader`, and drop the data version.

  Added

  - `createReader`, `Reader`, `ReadScope` in model: memoized reads, joined fields, and extents under one budget.
  - `sampleDomain(pages)` in model.
  - `gpu.reader`, `frame.reader`, `kit.fieldScale`, `kit.wiring`.
  - `protocol` namespace export in connect.
  - `pixelRatio` option for `exportVideo`.

  Changed

  - `createData(schema, batches)` and `appendData(previous, batches)`.
  - Reads yield blocks only; `RowsBlock.position` is `rowOffset`; `TableData.ids` is `ColumnPages`.
  - `FieldInput`, `FieldBinding`, `FieldValues`, `FieldsRequest`, `FieldsBlock` (was `NativeFields`), and `ExtentRequest` live in model; `ExtentRequest` takes `{ source, from, rows, field, window }`.
  - `frame.upload` takes a `FieldsBlock` or `EnvelopeBlock`; `GpuPage.native` is `GpuPage.block`.
  - `BufferData` and `TextureData` report `revision`.
  - App-facing gpu types (`CompositionConfig`, `GpuStats`, `Budget`, `ImageOptions`, `TextOptions`, `ColormapOptions`, `ShadeFrame`, …) moved from `kit` to the root export.
  - Field shader header is seven words; kinds are named `FIELD_*` constants.
  - Connect frames carry no version field; the magic is `LATK` and the opcode is u32. Binary descriptors use `type: 'float32' | …`. `connectLattice` is `connectModel`; `maxBatchBytes` is `maxBlockBytes`.
  - `exportVideo` keeps the view's `at` when no `at` mapping is given.
  - Monitor `fit()` with no readings fits the recorded window; following appends no longer scans every page, and cached tiles before the window are pruned as it advances.
  - Diagram re-reads its scene for a new `at` only when a sampled field is bound, and checks edge-end indices.

  Removed

  - `Data.version`, `QueryHeader`, block `version` fields, and monitor `Reading.version`.
  - `Gpu.query`, `Gpu.fields`, `Gpu.envelope`, `frame.query`, `frame.fields`, `frame.envelope`, `frame.extent`, `frame.values`, `frame.scale`, `kit.createNativeReader`, `kit.NativeReader`, `kit.QueryResult`.
  - The `@latkit/connect/protocol` subpath.

- b958ddc: Network, monitor, and diagram build on one item-view base, so camera, selection, picking, hover, style, input, and events behave the same in each.

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

- b958ddc: Monitors draw streamed frames reliably: each image keeps what it has drawn and draws only what it is missing. Network picking stays fast at a million vertices.

  Added

  - `Progress.domain`: the coordinates a run covers, carried by connect.
  - `sampleFrames(pages, window)` in model: the frames a sample window covers.

  Changed

  - Monitor history draws, each frame, what an image is missing, continuing from the last frame drawn. Arrivals reach the shown image first; a new window or value range redraws behind it while the shown image stretches to the camera's axes. Fixed windows at epoch coordinates, and monitors created before any samples, now stream.
  - Monitor fitted values come from per-page extents, so appends never read history again.
  - Monitor limits are `{ rows, segmentsPerFrame, historyBytes, pickingBytes }`; `segmentsPerFrame` bounds the lines drawn per frame.
  - Network `pick` and hover use a compact hit-test index, built in the background within `limits.pickingBytes`: a million vertices and two million edges fit the default, and pick takes milliseconds instead of seconds. `stats().pickingBytes` counts the index as it builds.
  - A hover budget miss suspends automatic hover until the scene moves or the view can search faster, as when its index is built.
  - gpu field pages bind four value buffers, which needs five storage buffers per shader stage; pages keep every frame of their rows; buffers grow with use; cache eviction takes constant time in model and gpu.

  Removed

  - Monitor `camera.follow`, `detail`, `autoDomain`, `limits.frameMs`, `limits.observationsPerFrame`, `stats().pendingBytes`, and pointer pan and zoom.

### Patch Changes

- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
  - @latkit/model@2.0.0

## 0.11.1

### Patch Changes

- 5f19f4e: Replace connect with demand-driven connectLattice and acceptModel endpoints. Registration carries metadata only; bounded binary publications, cumulative credit windows, cancellation, typed command arguments, bounded diagnostics, and encoded forwarding replace snapshots and transaction event plumbing.

  Make model the shared data and command vocabulary: add CommandDescription, Parameters, Arguments, Progress, Diagnostic, validateBatch, validateSelection, and selectBatches. Remove Model, Commands, Routine, DataEvent, transactions, and schema delivery limits. Read limits belong to QueryOptions; connection limits belong to connect. Update GPU/monitor consumers accordingly. This intentionally breaks the previous connection and model contracts.

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

## 0.11.0

### Minor Changes

- dc8b6a0: Replace renderer prepare/encode hooks with captured and prepared frame contracts. Ordinary
  invalidation schedules the latest state without cancelling valid work; canvas playback coalesces
  requests without adding an extra animation-frame wait. Compositions capture every child before
  preparation, and images and video share submission and discard behavior.

  Monitor append progress survives cancelled frames and tracks independently sampled fields.
  Bounded camera-independent tiles reuse geometry and exact bounds for domain changes, with local
  refinement at summary boundaries and local rereads on cache misses. Models and transport remain
  free of observation retention and replay.

### Patch Changes

- 70030a4: Add `locateSample` for consistent observation lookup. Reuse local query, field, and scale results by
  immutable sample dependencies rather than exact playhead coordinates or whole data publications.
  Playback benefits automatically through existing view APIs, including after sample appends.
- Updated dependencies [dc8b6a0]
- Updated dependencies [70030a4]
  - @latkit/model@0.15.0

## 0.10.0

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
  - @latkit/model@0.14.0

## 0.9.0

### Minor Changes

- Diagram is a public runtime over the shared GPU lifecycle.

  Added

  - Diagram: native fields, headless `arrange`, measured labels, orthogonal routing, groups,
    editing proposals, and indexed picking.
  - GPU: `createNativeReader`, a bounded, device-independent native read session for headless
    consumers.

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

- Updated dependencies [1ade156]
  - @latkit/model@0.13.0

## 0.8.0

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
