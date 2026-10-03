# @latkit/video

## 0.5.1

### Patch Changes

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

- Updated dependencies [96f79d2]
- Updated dependencies [96f79d2]
  - @latkit/model@2.1.0
  - @latkit/gpu@0.13.0

## 0.5.0

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

### Patch Changes

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

- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
  - @latkit/model@2.0.0
  - @latkit/gpu@0.12.0

## 0.4.2

### Patch Changes

- Updated dependencies [5f19f4e]
- Updated dependencies [5f19f4e]
  - @latkit/model@1.0.0
  - @latkit/gpu@0.11.1

## 0.4.1

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

## 0.4.0

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

## 0.3.1

### Patch Changes

- Updated dependencies
- Updated dependencies [1ade156]
  - @latkit/gpu@0.9.0
  - @latkit/model@0.13.0

## 0.3.0

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

## 0.2.0

- Replace scene serialization and the internal worker with `exportVideo({ gpu, renderer, duration, at, output })` over the native shared GPU renderer.
- Add bounded WebCodecs encoding, streamed positional output, MP4/WebM muxing, complete progressive preparation, cancellation, and explicit borrowed ownership.
- Move reusable renderer composition into `@latkit/gpu`; remove dependencies on specific renderer packages.

## 0.1.2

### Patch Changes

- Updated dependencies [be20b0b]
- Updated dependencies [be20b0b]
  - @latkit/monitor@0.7.1
  - @latkit/model@0.11.0
  - @latkit/port@0.8.0
  - @latkit/diagram@0.3.2
  - @latkit/gpu@0.7.1
  - @latkit/network@0.12.2

## 0.1.1

### Patch Changes

- f694ea4: Render Monitor ticks, labels, gridlines, and playheads on the GPU, with serializable axis formatting and custom ticks. Live views and video exports share one plot assembly, including layout and captured glyphs. Add `Monitor.seek()` and `Monitor.toData()`; axes are enabled by default and can be hidden with null axis options.

  Move Diagram's SDF glyph infrastructure into GPU's root API. Textures track their own upload revisions, snapshots preserve glyph appearance across realms, and bounded atlases fail explicitly on exhaustion. Diagram retains its anchor-based glyph positioning and culling.

  Reuse Monitor upload buffers, bound folded-history carry storage, coalesce hover requests, and cache the latest sampled frame within a byte budget. Keep retained-image remapping during resize and enforce texture and buffer limits. Offscreen preparation uses the same awaitable sampling scheduler as interactive rendering.

  Add opt-in drag/pinch/wheel navigation, anchored `zoom`, CSS-pixel `pan`, and `fit` to Monitor.
  Retained textures respond immediately; the latest view refines after gestures settle, with exact
  readings against displayed ranges. Add asynchronous `setShade` composition with the same host
  uniform and snapshot conventions as Network and Diagram. Share shader failure diagnostics
  through GPU and preserve animated WGSL in video exports without rereading history.

- Updated dependencies [f694ea4]
  - @latkit/gpu@0.7.0
  - @latkit/monitor@0.7.0
  - @latkit/diagram@0.3.1
  - @latkit/network@0.12.1

## 0.1.0

### Minor Changes

- Add renderer-owned scene snapshots and deterministic worker video exports. `@latkit/video` composes network, diagram, and monitor views on the GPU, reads pinned series through bounded port requests, and encodes MP4 or WebM with cancellation, progress, and optional streamed output. Shared render targets and awaitable channel preparation reuse existing renderer engines. Diagram snapshots retain layout and glyphs; monitor exports reuse history rendering and add a synchronized playhead.

  Validate series state before publishing it, preserve failed connection errors, and reject malformed sample blocks before transport. Video cancellation releases resources even when a destination stalls.

### Patch Changes

- Updated dependencies
  - @latkit/gpu@0.6.0
  - @latkit/port@0.7.0
  - @latkit/model@0.10.1
  - @latkit/network@0.12.0
  - @latkit/diagram@0.3.0
  - @latkit/monitor@0.6.0
