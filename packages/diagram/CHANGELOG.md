# @latkit/diagram

## 0.9.0

### Minor Changes

- df714d5: Every per-row option is a channel: one value for every row, a field, or a field through a scale. Positions are `x`, `y`, and `z` channels, every view reads its channels through one shader struct, and a view's defaults are named after the channels they stand in for.

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
  - network: positions that change keep the drawn topology; only a type moving between circle, plane, and geographic placement rebuilds it.
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

- df714d5: One text system, spatial index, memo, and change test for every view; schemas state facts and views bind every field; diagram styles on the GPU.

  Added

  - model: `samePages`; `fieldDefinition`; `geographic` on a position field; `ReadScope.recording` and `ReadScope.hold`, with `ReadRecord`.
  - gpu: `gpu.layoutText`; `kit.BoxIndex`, `kit.Occupancy`, `kit.sameValues`, and `kit.sameRecords`; `kit.fieldShader({ colormap })` adds `fieldColor`, and the field shader carries the scale WGSL.
  - gpu: `frame.memo(slot, deps, build)`, reused until its deps, the coordinate of a sampled read, a bound buffer, or held memory change.
  - gpu: `kit.TextBank`, `kit.textOrigin`, and `kit.textBox`, with `TextCandidate` and `TextPlacement`; `TextAlign` and `TextBaseline`; `align` on `TextLayoutInput`; `baseline`, `lineHeight`, `capHeight`, and `align` on `TextLayout`; `latkitAnchor` and a pixel halo in `kit.textShader`.
  - gpu: `BufferData.update(values)`, which marks only the words that changed.
  - monitor: `coordinateAt(point)`, the coordinate under a canvas point of the drawn plot.
  - network: `repeatSpacingPx` on labels.

  Changed

  - network: positions are bound like every other field; without them, rows sit on a circle. Whether they are longitude and latitude comes from the bound fields' `geographic`.
  - Text draws from one glyph atlas, one SDF per font and grapheme, and repeated layouts are cached. Lines are the font's ascent and descent tall, so every string of a font shares one baseline, and titles, port names, wire labels, and axis ticks center by their capitals.
  - Every view draws its labels through `kit.TextBank`: a label's glyphs are prepared once, and frames move or hide only its anchor.
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

  - model: `TypeDefinition.spatial`. A position field says whether it is `geographic`, and a view binds its positions itself. Schemas cross connect, so peers upgrade together.
  - gpu: `TextLayout.ascent` and `descent`; `kit.scaleShader` (in `kit.fieldShader`), `kit.defaultShade`, and `kit.localPoint`.

### Patch Changes

- Updated dependencies [df714d5]
- Updated dependencies [df714d5]
  - @latkit/model@4.0.0
  - @latkit/gpu@0.15.0

## 0.8.0

### Minor Changes

- 35b7171: One failure, one item identity, one view contract, one option vocabulary, and one memory budget, with constant CPU work per frame.

  Added

  - model: `Item`, `sameItem`, and `itemId`; `FailureCode` and `isFailure`; `createMemory`, `Memory`, `MemoryBudget`, and `MemoryStats`; `Work` and `interruptible`.
  - gpu: the types an app names at the root, including `ViewConfig`, `ViewEvents`, `Patch`, `FrameInfo`, `Viewport`, `Composition`, `Scale`, `ColorScale`, `Position2D`, `Labels`, and the text types; `kit.resolveLimits` and `kit.clearColor`.
  - Item views: a click in place cycles through overlapping hits and a modifier toggles the topmost; a double click or Enter reports `open`, and a double click on nothing fits the data.
  - Compositions route pointer, wheel, menu, and key input to the view under the pointer.
  - network: `baseColor` on vertex and edge types, and `widthPx` on edge types. diagram: `baseColor` on vertex and edge types.
  - connect: `protocol.forward(id, bytes)` frames a received publication for another stream without encoding it again.

  Changed

  - Every package throws model `Failure`s. A peer's error keeps a code latkit knows, and malformed peer data reports `protocol`.
  - `kit.BaseView`: `resolve` runs once per config, `configure` receives the resolved configs, and `prepare` returns what `encode` and `submitted` receive. `kit.BaseItemView` builds `pipelines` once per variant for every view of a kind, names the view in `kit.ItemShape`, and rejects options it does not know.
  - One memory pool bounds the reader's cache, uploads, and GPU resources: `createReader({ memory })`, and `gpu.stats()` and `reader.stats()` return `MemoryStats`. Its defaults are the former sums.
  - Frames pack their uniforms into shared buffers written once; upload cache hits allocate nothing; network dash phases hold while the camera moves; diagram drags move in the shader and reroute only the wires they touch, so a drag frame costs the same at any size.
  - `image({ format, quality })` takes `png`, `jpeg`, or `webp`, and video `quality` is a number from 0 to 1, as for images.
  - connect checks a model before it opens a socket.
  - Internal dependencies publish as caret ranges, and every package whose types name WebGPU depends on `@webgpu/types`.

  Renamed

  - network: vertex `size` to `sizePx`, a radius in CSS pixels; label `size` to `sizePx`; `curve: 'linear'` to `route: 'straight'`; `focusEnds` to `selectedEnds` and `hoverEnds`; `Labels` to `NetworkLabels`.
  - diagram: edge `width` to `widthPx`; `Labels` to `DiagramLabels`.
  - connect limits drop `max`: `messageBytes`, `metadataBytes`, `bufferedBytes`, `bufferedMessages`, `streams`, `publicationBatches`, and `logs`.
  - gpu: `createRenderTarget` to `createTextureTarget`; `GpuStats` and `Budget` to model `MemoryStats` and `MemoryBudget`.

  Removed

  - gpu: `GpuError`, `GpuErrorCode`, `DataHit`, `kit.Work`, `kit.wheelDelta`, `kit.createCanvasInput`, and `kit.withinBudget`.
  - network: `focusEnabled`, `hoverAlpha`, and `selectedAlpha`; the alpha of `hoverColor` and `selectedColor` sets the halos.
  - monitor: the `pickingBytes` limit.
  - model: `ReaderStats`; reader `maxBytes`, `maxStagingBytes`, and `maxEntries`; `resolveRows`, `RowMapping`, `samplePages`, `copyBuffers`, `sliceColumn`, and `DEFAULT_BLOCK_BYTES`.
  - connect: `remoteFailure`.

### Patch Changes

- Updated dependencies [35b7171]
  - @latkit/model@3.0.0
  - @latkit/gpu@0.14.0

## 0.7.0

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
  - @latkit/gpu@0.13.0

## 0.6.0

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

### Patch Changes

- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
  - @latkit/model@2.0.0
  - @latkit/gpu@0.12.0

## 0.5.2

### Patch Changes

- Updated dependencies [5f19f4e]
- Updated dependencies [5f19f4e]
  - @latkit/model@1.0.0
  - @latkit/gpu@0.11.1

## 0.5.1

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

## 0.5.0

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

## 0.4.0

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

- Updated dependencies
- Updated dependencies [1ade156]
  - @latkit/gpu@0.9.0
  - @latkit/model@0.13.0

## 0.3.3

### Patch Changes

- Updated dependencies [01975bd]
  - @latkit/model@0.12.0
  - @latkit/gpu@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [be20b0b]
  - @latkit/model@0.11.0
  - @latkit/gpu@0.7.1

## 0.3.1

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

## 0.3.0

### Minor Changes

- Add renderer-owned scene snapshots and deterministic worker video exports. `@latkit/video` composes network, diagram, and monitor views on the GPU, reads pinned series through bounded port requests, and encodes MP4 or WebM with cancellation, progress, and optional streamed output. Shared render targets and awaitable channel preparation reuse existing renderer engines. Diagram snapshots retain layout and glyphs; monitor exports reuse history rendering and add a synchronized playhead.

  Validate series state before publishing it, preserve failed connection errors, and reject malformed sample blocks before transport. Video cancellation releases resources even when a destination stalls.

### Patch Changes

- Updated dependencies
  - @latkit/gpu@0.6.0
  - @latkit/model@0.10.1

## 0.2.3

### Patch Changes

- Updated dependencies [ff717f0]
  - @latkit/model@0.10.0
  - @latkit/gpu@0.5.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - @latkit/model@0.9.0
  - @latkit/gpu@0.5.2

## 0.2.1

### Patch Changes

- Updated dependency: `@latkit/gpu@0.5.1`.
- Updated dependency: `@latkit/model@0.8.0`.

## 0.2.0

### Minor Changes

- da58150: Make the model the API as a few classes a format, an engine, and an editor subclass, share one channel binder, open every lazy thing from a source, and give every package one entrypoint.

  - Added: `Model` in `@latkit/model`, the class a format subclasses, immutable. It describes a case to the constructor, which checks it once, and gives each class's `values` when asked, the case's `bytes`, and, for a format that edits, its `document`. Every question about a case is a method: `class`, `load`, `elementAt`, `itemOf`, `fields`, `field` for a number column, `grid` for the class as a table, and `source`.
  - Added: `Engine`, the class an engine subclasses, which records any model it is given: `parse` checks an input, and `execute` records the model for one through an `Engine.Recorder`, whose `append(time, values)` commits frames for every recorded class at once, `values` keyed by class id. `engine.record(model, input, { id, label })` checks the input at once and returns a `Recording` that waits its turn, then fills; `engine.record(model, input, recorder)` records into any recorder, which is how a port forwards one. An engine records as many as its `concurrency` allows and queues the rest, telling each how many wait before it.
  - Added: `Recording`, every class an engine records for one model on one clock. `model` is the model it records, for good; `state` publishes `status` (`waiting`, `recording`, `complete`, `stopped`, or `failed`), `ahead`, `frameCount`, `timeRange`, and `error` together; `span`, `expectedFrames`, and `log` are what its engine declared and said; `frameAt` and `timeAt` read the clock, `series(classId)` is each class's history, `field(ref)` resolves a signal it records or a column of its model, `grid(classId, time)` tables a class with its signals at a time, and `stop()` keeps what it has.
  - Added: `Document`, the class a format that edits subclasses. `apply(...operations)` makes `Document.Operation`s, in the model's identities, true as one step; `undo`, `redo`, and `history` keep one history of the last 200 steps; `schematic` is the case as a diagram draws it, with `elementAt`, `partOf`, `portAt`, and `portOf` between its parts and the case, and `drivers(ref)` the element of a field that drives each net; and `model()` opens the model of the case as it stands once asked, however many changes came between. An edit it refuses throws `Refusal`, saying why and what it is about.
  - Added: fields, a number column or a recorded signal as the `{ series, signal }` every renderer binds, with its label, unit, live `domain`, and `at(time)`: `model.field(ref)` resolves a column and `recording.field(ref)` a signal too. `field.gather(elements)` is the field over other items, such as a diagram's nets over `document.drivers(ref)`, keeping its clock and domain. A column is a sealed series of one frame, and one reference resolves to one series.
  - Added: `model.source()` and `Model.from(source)`, and `recording.source()` and `Recording.from(model, source)`: a model or a recording held elsewhere, in a file or across a port, opens from its source and reads what it holds on demand, a series in windows of at most 1 MiB. A recording opens against the model it records, which refuses one that does not fit, and a model opened from packs serves them again as they came.
  - Added: `Series.create`, a history in memory to `append({ time, values })` to and `seal()`. A source of samples held anywhere else subclasses `Series`.
  - Added: `RGBA`, `Colormap`, and `validateRgba` in `@latkit/colormaps`, beside the `COLORMAPS` catalog, `colormap`, `gradient`, and `parseColor`, so the color vocabulary has one home; `@latkit/colormaps` no longer depends on `@latkit/model`.
  - Added: `createChannels` in `@latkit/gpu`, the channel binder the network and the diagram now share: a slot per channel, domains, and series followed around a playhead with their frames resident on the GPU. `bakeColormap`, `COLORMAP_LUT_SIZE`, and `createEmitter` live there too.
  - Added: a `series` field on every `CHANNELS` entry of `@latkit/diagram`, as on the network's: whether the channel can follow a series.
  - Added: `serveModel` and `connectModel` in `@latkit/port`, a model served across a port, its classes loading as they are asked for; `serveEngine` and `connectEngine`, an engine served across a port that records any model a peer gives it, one its realm serves where it lives and any other through the source the peer lends, each recording forwarded call by call, its frames handed over without a copy; and `serveRecording` and `connectRecording`, a recording opened from its source on the far side, against the model it records. A connected side is a `Remote<T>`.
  - Added: `check` in `@latkit/port`, the checks a protocol runs on every request. Each throws a `TypeError` naming what is wrong, so a refused request says why, and the compiler keeps every field's check the field's type. `loopback()` joins the transports.
  - Added: `loadBorders` and `spotlight` in `@latkit/network`, and `arrange` in `@latkit/diagram`, whose one entrypoint loads in a worker without a DOM or a device.
  - Changed: `Model` and `Series` are classes, and every other type lives under the class that speaks it: `Model.Topology`, `Model.Item`, `Model.Element` for `ElementRef`, `Model.Class` for `ClassSpec`, `Model.Data` for `ClassData`, `Model.Column`, `Model.Signal`, `Model.FieldRef`, `Model.Field`, `Model.Grid`, `Model.GridSort`, and `Model.Source`; `Document.Netlist` and `Document.Part`; `Engine.Recorder`; `Recording.State` and `Recording.Source`; and `Series.State`, `Series.Window`, and `Series.Block`.
  - Changed: a model's `vendor` is `format`, and `FieldRef.source` is `kind`. Each class declares its `columns` before any values load, and `values` gives labels and column values in that order.
  - Changed: a `Series` names its signals in `signals` in place of `signalCount`, adds `state.live`, and emits `change` on an append or the seal.
  - Changed: `vertexHeight` bound without a domain pads a constant extent, as a field's `domain` does.
  - Changed: `Monitor.load` takes `{ series, signal }`, the binding `setChannel` takes, so a field loads as it is, and null clears it. `latkit-monitor` JSON names its signals in `signals`, and the `signal` attribute names one by id.
  - Changed: a protocol takes a `check` in place of a guard.
  - Changed: a pack's core declares each class's columns and signals, a shard holds only their values, and the container carries no version or flags. A pack made by an earlier release does not open; pack the model again.
  - Removed: `@latkit/remote`; serve a model and its recordings with `@latkit/port`.
  - Removed: `createModel`, for subclassing `Model`; `openModel` and `sourceOf`, for `Model.from` and `model.source()`; `elementAt`, `itemOf`, `fieldsOf`, and `createGrid`, for the model's methods; `createSeries`, for `Series.create`; `sample`, for `field.at`; `fieldKey`; `position`, for `field.gather` and a channel's playback; and `Runner`, `RunUpdate`, `RunFrames`, `Results`, `collect`, and `Progress`, for `Engine` and `Recording`.
  - Removed: `RGBA`, `Colormap`, `validateRgba`, `bakeColormap`, `COLORMAP_LUT_SIZE`, and `createEmitter` from `@latkit/model`; import them from `@latkit/colormaps` and `@latkit/gpu`.
  - Removed: every subpath. Use `check` and `loopback` from `@latkit/port` for `@latkit/port/guard` and `@latkit/port/testing`, the network and diagram roots for `@latkit/network/borders`, `@latkit/network/shades`, and `@latkit/diagram/layout`, and `register()` for `@latkit/embed/register`. `embed.js` stays a page script.
  - Removed: `Monitor.setSignal` and `Monitor.clear`; load another signal of the series, or null.

- da58150: Give each view one camera value a host keeps and restores, and one pointer contract.

  - Added: `getCamera()` and `setCamera(camera, animate?)` on `Network`: the camera as one value, `{ projection, centerX, centerY, pitch, bearing, scale, fit }`, where `scale` is CSS pixels per world unit at the view anchor and `fit` says it follows the fit view. `setCamera` moves it in one step, a projection switch keeping the pose it is given, and returns false for a projection the topology cannot show; before a topology loads only a projection applies, and while no canvas has a size the placement waits for the first frame that does.
  - Added: `getCamera()` and `setCamera(camera, animate?)` on `Diagram`, the same value without a projection: `{ centerX, centerY, scale, fit }`, `fit: true` fitting the diagram.
  - Added: a `contextmenu` event on `Monitor`, as the network and the diagram emit: the native menu suppressed, and the sample under the pointer, resolved against the series shown when it was asked, or for the keyboard the sample last hovered.
  - Changed: `@latkit/monitor` selects on the primary button alone.
  - Removed: `getPose`, `setPose`, `setProjection`, and the `Pose` type from `@latkit/network`, for the camera value; a projection the topology cannot show no longer falls back, since `projections` says ahead which it can. `projection` stays, naming the projection shown before a canvas has a size.
  - Removed: `getPose`, `setPose`, and the `Pose` type from `@latkit/diagram`, for the camera value, whose `scale` is the pose's `zoom`.

- da58150: Keep the monitor's image on screen through repaints, and make NaN mean no value in every channel.

  - Changed: `@latkit/monitor` keeps its last complete image on screen, rescaled into the current time and value ranges, while a resize or a new mapping repaints behind it. The repaint starts once the canvas size settles, and `valueRange` reports at once.
  - Changed: `@latkit/monitor`'s automatic value range keeps a tenth of the recorded span to spare on each side and only grows until another series or signal loads, across detach and device loss.
  - Changed: `@latkit/monitor` emits `hover` once per sample under the pointer, and `rendered` once no newer update waits.
  - Changed: in `@latkit/network` and `@latkit/diagram`, an item whose color, height, size, status, flow, or dash value is NaN draws and picks as if the channel were unbound. Diagram visibility channels show only values above zero, as the network's do.
  - Changed: `setChannel` in both renderers takes a `Float32Array` or a `Float64Array`, stores float32, and throws a `TypeError` for anything else. Clearing an unbound channel, or setting the borders already set, schedules no frame.
  - Changed: `@latkit/network` advances `orbit` from its frame loop, so `pause()` and a hidden page hold it.
  - Changed: `@latkit/diagram` redraws its glyphs when a web font finishes loading.
  - Changed: reads of a `Series.create` history yield to the event loop without the 4 ms timer clamp.
  - Removed: `Part` from `@latkit/diagram`; name `Document.Part` from `@latkit/model`.
  - Removed: the `quantize` option of `createFrameLoop`. Every loop quantizes while a resize is in flight, and `settled` means the size has held.

- da58150: Share one attach lifecycle across every controller, let network channels follow recorded series, draw long monitor histories at canvas resolution, and drop what no consumer uses.

  - Added: `createAttachment` in `@latkit/gpu`, the attach lifecycle every controller now shares: supersession, joining a repeat attach, and recovery from device loss.
  - Added: a `canvas` getter on `Network`, `Diagram`, and `Monitor`: the canvas bound or binding.
  - Added: `setChannel` on `Network` and `Diagram` takes `{ series, signal }` to follow one signal of a `Series`, and `seek(time)` shows every such channel at a playhead. The frames around it stay resident on the GPU, shared by the channels following one signal, and the next ones load as it plays or the series appends, so a seek within them rewrites one word per channel. A null domain follows the signal's recorded range as a field's `domain` reports it, padded while the signal is constant, and both emit `error` with the channel when a series read fails. Every channel can follow a series but `vertexPosition`, `blockPosition`, `blockVisible`, and `netVisible`.
  - Added: `parseColor` in `@latkit/colormaps`, reading hex, `rgb()`, `oklab()`, `oklch()`, `color(srgb)`, and `transparent`; with an element it resolves any color the element computes, custom properties included.
  - Added: a `label` on every `OPTIONS` entry of the network, the diagram, and the monitor, and `min` and `max` on bounded numbers.
  - Changed: `attach` resolves `true` once bound, or `false` at once when a newer attach or a detach takes over, instead of rejecting with `AbortError`. Attaching the canvas already bound, binding, or recovering from a lost device joins that attach, and `detach(canvas)` detaches only while that canvas is the current one.
  - Changed: `@latkit/monitor` draws a history repaint over more than two frames per device pixel as each pixel column's extremes, in the order they occurred, and paces repaints by a few milliseconds of work per frame. Appends, the selected trace, and readings stay exact.
  - Changed: `PROJECTIONS` is a frozen record of `{ label }` keyed by mode, like `CHANNELS`; iterate `Object.keys(PROJECTIONS)`.
  - Changed: `nightFloor` and `surfaceNightFloor` reject values outside `[0, 1]`, and `terminatorWidth`, `hoverAlpha`, `selectedAlpha`, and the monitor's `unselectedAlpha` values above 1.
  - Changed: `@latkit/embed` color attributes take four decimals or any color `parseColor` reads, resolved on the element.
  - Removed: `frameAt` from `@latkit/model`.
  - Removed: the `Interaction` and `Insets` types from `@latkit/network`, and `Interaction` from `@latkit/diagram`; name `Options['interaction']` and `Options['fitPaddingPx']` instead.

### Patch Changes

- Updated dependencies [da58150]
- Updated dependencies [da58150]
- Updated dependencies [da58150]
- Updated dependencies [da58150]
  - @latkit/model@0.7.0
  - @latkit/gpu@0.5.0
  - @latkit/colormaps@0.3.0

## 0.1.0

### Minor Changes

- b2631b8: Add `@latkit/diagram`, a WebGPU block-diagram renderer and editor surface, and its netlist in `@latkit/model`.

  - Added: `Netlist` in `@latkit/model`, a block diagram's structure as columns: blocks, the ports each block owns, and the nets that join ports, with optional kinds, sides, tag-drawn nets, groups, keys, and labels. `validateNetlist` checks offsets, ranges, one driver and one kind per net, one net per port, unique keys, and label lengths, and throws an `Error` naming the first invalid field.
  - Added: `createDiagram(options)` in `@latkit/diagram`, a durable controller with the lifecycle of `Network` and `Monitor`: it takes neither a device nor a canvas, `attach` leases a device from the shared pool, `detach` keeps every state, a lost device is recovered in place, and `destroy` forgets the netlist and gives back the memory derived from it. `CHANNELS` and `OPTIONS` name what it speaks, and `validateOptions` checks an option patch before a device exists.
  - Added: automatic layout in layers along the signal flow with feedback returning underneath, one layout per unit shape, units packed six grid steps apart, right-angle wire routing with trunks, junctions, and arrows, and in-canvas text from a runtime glyph atlas. Every size derives from the `gridPitch` option, and blocks grow until no text collides.
  - Added: channels for block placement, block and net color and visibility, block and port status, dashes marching along nets, and shade values. The `blockPosition` channel places blocks, and a NaN pair hands a block back to its automatic position.
  - Added: `load` keeps every block whose `blockKey` survives where it was, with its placement and selection, lands new blocks beside what they connect to, and fades out removed ones. Every other channel clears.
  - Added: `fit(parts)` and `reveal(part, { neighbors })` frame some parts without redefining the fit view the `fit` event reports on.
  - Added: editing proposals. Under `interaction: 'edit'`, drawing a wire emits `connect`, dragging or nudging blocks emits `move`, and Delete emits `delete`; the diagram never edits its netlist, and a host loads the result it accepts.
  - Added: a `Shade` fragment hook for the block, port, wire, and group passes, reading `u.host` and `u.pointer_px`.
  - Added: `@latkit/diagram/layout` exports `arrange(netlist, { gridPitch })`, the same pure, deterministic layout without a device or a DOM, for a worker.

### Patch Changes

- Updated dependencies [b2631b8]
- Updated dependencies [b2631b8]
  - @latkit/model@0.6.0
  - @latkit/gpu@0.4.0
