# @latkit/model

## 4.1.0

### Minor Changes

- 6ebb914: Selected and hovered items glow in every view, picks answer with what the frame draws, and a network draws its selection over the rest, so a crowded region never hides it.

  Added

  - model: `itemKey(item, ...qualifiers)`, the identity every view's selection builds on.
  - gpu: `unselectedAlpha` for every view, `glowAlpha` and `stroke_nearest` in the kit shaders, and a view's `detail` hook.

  Changed

  - gpu: `hoverColor` and `selectedColor` color a glow, and `hoverWidthPx` and `selectedWidthPx`, now 6 and 8, set its reach. `'none'` glows in each item's own color.
  - gpu: clicks, double clicks, and menus answer with what the presented frame draws; a later one supersedes one still finding its hits. Clicking again in place cycles only while the same items lie there.
  - gpu: `BufferData.touch` takes several ranges as one revision.
  - network: selected and hovered rows, and the ends of a focused edge, draw over everything but labels. Picks keep one hit per item and take `limit`.
  - diagram: selected, hovered, and targeted items glow. Selecting a row of another row space throws `conflict`.
  - monitor: pick and hover hit a line anywhere it draws, one reading per row, and a reading selects its row. A selected trace glows, and a lone sample between gaps draws as a dot.

  Removed

  - monitor: its own `unselectedAlpha`, now every view's, and the selected traces' minimum width.

## 4.0.0

### Major Changes

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

## 3.0.0

### Major Changes

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

## 2.1.0

### Minor Changes

- 96f79d2: A model is a value both sides of a connection share, and either side may dial.

  Added

  - `Model`, `Command`, `MonitorContext`, `CommandContext`, and `Publication` in model: the contract a
    model meets, whether used in process or across a connection.
  - `staticFields(schema)` and `sampledFields(schema, types?)` in model.
  - `protocol.subprotocols`: `latkit.connect` for a dialing side that offers a model, `latkit.accept`
    for one that accepts it.
  - An accepted model can be offered onward as it is. Publications connect received go on as the bytes
    that arrived when they fit the onward bounds, and the onward connections close with the model.
  - A peer that closes a socket before registering rejects with its close reason.

  Changed

  - `connectModel(model, { url } | { socket })` and `acceptModel({ url } | { socket })`: either side
    dials a URL or answers on a socket a server accepted. The URL is dialed exactly; nothing is
    appended to it.
  - An accepted model is a `ConnectedModel`, a `Model` and a `Connection`. Commands run as
    `model.commands[name].run(values, { outputs, publish, progress, log, signal })`, with the context a
    model's own handler receives.
  - `monitor` is absent when a model offers no reading, and an empty selection reads nothing.
  - A log entry that carries a `dropped` count is counted, not forwarded as an entry.
  - `Limits` is `ConnectLimits`.

  Removed

  - `model.run(name, values, { onData, onProgress, onLog })`, `format: 'encoded'`, `MonitorOptions`,
    `RunOptions`, `EncodedMonitorOptions`, and `EncodedRunOptions`. `EncodedPublication` is in
    `protocol`.
  - `Command`, `CommandContext`, `MonitorContext`, `Publication`, and `Publish` from connect; the first
    four are in model.
  - `protocol.subprotocol`, and the `/models/<name>` connect appended to a URL.

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

## 2.0.0

### Major Changes

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

### Minor Changes

- b958ddc: Connect sizes publications for the wire, so producers never do.

  Added

  - `failure(code, message, details)` in model: the shared `Failure` constructor.
  - `sliceSamples(column, row, rows, frame, frames)` in model: a strided view of sample cells.

  Changed

  - `publish` and monitor yields deliver in the fewest messages within the negotiated limits. A group that fits stays one atomic message; batches share a message while they fit, and a larger sample batch is cut only between whole frames, so each message appends in turn. A row batch must still fit one message. `protocol.preparePublication` remains the strict one-message primitive.
  - `selectRows` resolves ID selections through a UTF-8 index of the ID pages instead of a retained string map.
  - Connect raises model's typed `failure`; errors reported by a peer keep the peer's code.

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

## 1.0.0

### Major Changes

- 5f19f4e: Replace connect with demand-driven connectLattice and acceptModel endpoints. Registration carries metadata only; bounded binary publications, cumulative credit windows, cancellation, typed command arguments, bounded diagnostics, and encoded forwarding replace snapshots and transaction event plumbing.

  Make model the shared data and command vocabulary: add CommandDescription, Parameters, Arguments, Progress, Diagnostic, validateBatch, validateSelection, and selectBatches. Remove Model, Commands, Routine, DataEvent, transactions, and schema delivery limits. Read limits belong to QueryOptions; connection limits belong to connect. Update GPU/monitor consumers accordingly. This intentionally breaks the previous connection and model contracts.

### Minor Changes

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

## 0.15.0

### Minor Changes

- dc8b6a0: Replace data patch operations with complete construction and sample-only append. `createData`
  accepts disjoint `RowBatch` and `SampleBatch` values; `appendData` accepts only new sampled
  observations. Static changes require a fresh `Data` value. Overlapping writes, sample corrections,
  backfilling, and the `replace` option reject without changing earlier values. Immutable payloads
  remain shared, with cached per-field append boundaries and one assembly per changed table.

  Remove `DataPatch`, `RowsPatch`, and `SamplesPatch` in favor of `DataBatch`, `RowBatch`, and
  `SampleBatch`. Data events now carry `block` instead of `patch`. Connect protocol 4 requires
  upgrading both peers together. Transaction assembly remains independent of commands and does
  not accumulate history.

- 70030a4: Add `locateSample` for consistent observation lookup. Reuse local query, field, and scale results by
  immutable sample dependencies rather than exact playhead coordinates or whole data publications.
  Playback benefits automatically through existing view APIs, including after sample appends.

## 0.14.0

### Minor Changes

- 145a02d: Breaking change: remove model retention and historical reads. Models publish one-pass passive
  transactions, commands are a separate optional capability, and applications own immutable
  columnar Data. Views consume Data directly and accept updates with set({ source: nextData }).
  Local read computes rows, samples, aggregates, and envelopes without contacting a producer.
  Connect protocol 3 removes queryable roots, retained reference trees, and remote exports;
  upgrade both peers together. Delivered values survive unsubscribe and disconnect. Shared
  unchanged pages preserve local read caching and GPU uploads.

## 0.13.0

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

## 0.12.0

### Minor Changes

- 01975bd: Replace the previous model and rendering APIs with native Queryable data, explicit
  retained acquisitions, shared GPU rendering, and worker/socket connections.

  Network and monitor use the shared GPU and canvas-view lifecycle. Video exports
  renderers directly, including composed views. Colors now come from @latkit/gpu.
  Rewrite usage guides and package READMEs for these APIs.

  This is a breaking pre-1.0 release. Migrate consumers together; the retired port,
  colormaps, document-session, and scene-snapshot APIs have no compatibility exports.
  The diagram package remains private and declaration-only.
