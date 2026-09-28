# @latkit/network

## 0.11.3

### Patch Changes

- Updated dependencies [ff717f0]
  - @latkit/model@0.10.0
  - @latkit/gpu@0.5.3

## 0.11.2

### Patch Changes

- Updated dependencies
  - @latkit/model@0.9.0
  - @latkit/gpu@0.5.2

## 0.11.1

### Patch Changes

- Updated dependency: `@latkit/gpu@0.5.1`.
- Updated dependency: `@latkit/model@0.8.0`.

## 0.11.0

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

## 0.10.3

### Patch Changes

- b2631b8: Drive every renderer's frames from one shared scheduler.

  - Added: `createFrameLoop(presentation, render, options?)` in `@latkit/gpu`, one canvas's frame scheduler: coalesced wakes, a re-render before the next paint whenever the canvas resizes (the observer's initial notification included), and a backing store quantized up while a resize is in flight that snaps exact once the size holds. `render` receives the frame's time, CSS size, backing scale, and whether the size has settled, and returns true to be called again. `{ quantize: false }` sizes the backing store exactly on every frame, for a renderer that repaints everything on any size change.
  - Changed: `@latkit/network` renders on `createFrameLoop`. A still view now stops scheduling after its last frame instead of arming one more guard frame.
  - Changed: `@latkit/monitor` renders on `createFrameLoop` without quantizing: resize, cursor, and presenting a lane share one frame, and a resize still reallocates and repaints once.
  - Changed: `@latkit/monitor` emits `rendered` only once the canvas has a layout size, like the network's `painted`; a canvas without area presents nothing until the resize that gives it area.
  - Fixed: in `@latkit/network` and `@latkit/monitor`, a `detach()` or `attach()` made from a `deviceLost` handler, or from the `attached: false` (and network `painted: false`) the release emits first, now supersedes the device-loss recovery instead of being undone by it. `deviceLost` reports `recovering: false` when such a call came before it, since no recovery follows.

- Updated dependencies [b2631b8]
- Updated dependencies [b2631b8]
  - @latkit/model@0.6.0
  - @latkit/gpu@0.4.0

## 0.10.2

### Patch Changes

- Updated dependencies [2019574]
- Updated dependencies [2019574]
  - @latkit/gpu@0.3.1
  - @latkit/model@0.5.0

## 0.10.1

### Patch Changes

- a90cb89: A frame a host can await.

  - Added: `paint()` schedules a frame and resolves once it is painted, after a pending shade and a deferred camera placement; every caller between two paints shares one promise. It rejects while detached, on detach, and with the cause of a pipeline failure for the active projection.
  - Changed: a pipeline failure is forgotten on re-attach and when a later shade compiles, so `pipelineError` is not replayed to late subscribers after the renderer that reported it is gone.

## 0.10.0

### Minor Changes

- 298b509: Vertex placement is a channel. `vertexPosition` holds interleaved `x, y` pairs in topology coordinates, the shape `vertexCoords` has; `load` seeds it from the topology, and rebinding it moves vertices, the ends of their edges, and their height poles at the cost of one upload, with no reload and no allocation, so a layout engine can hand over its array every frame.

  - Added: the `vertexPosition` channel, raw and always bound while a topology is loaded; `null` restores the topology's own layout. `CHANNELS` entries carry `components`, `2` for position and `1` for every scalar channel, and a channel's length is `count * components`. `fit()` frames the positions in effect; `null` is accepted before a load, as for every channel. `NetworkField` carries `components` (`1`, or `2` for an interleaved pair; the JSON slot defaults to `1`), and the `vertex-position` attribute on `latkit-network` binds a vertex pair field.
  - Changed: the plane shaders read vertex placement from the position channel, the edge ends follow the endpoint vertices, and polyline bends keep the coordinates the topology baked; the picker indexes the position snapshot and rebuilds its index only once positions have held still, so while positions change from one frame to the next hover clears and `hitTest` finds nothing, resuming one frame after the last write; the globe draws the layout the topology carries, so `projections.globe` is false while positions override it and binding positions on the globe falls back to flat; the uniform block grows to 464 bytes.

## 0.9.0

### Minor Changes

- fd27b40: A fragment shade hook, a framed fit, an inspect interaction mode, an external pointer, and a first-paint signal. Every one costs the same on any graph: a shade is one 64-float upload per frame, a framed fit is the refit the controller already does on resize, and the pointer is the hover probe the canvas already keeps.

  - Added: `setShade(shade)` installs WGSL `fn shade(f: Fragment) -> vec4f` into the vertex and edge passes with an optional per-frame `tick` over a `host` block; `@latkit/network/shades` ships `spotlight`; the raw `vertexShade` and `edgeShade` channels carry one scalar per item into a shade as `f.value`; `u.pointer_px` is the latest pointer in canvas-local CSS pixels.
  - Added: the `fitPaddingPx`, `fitPitch`, and `fitBearing` options define the fit every resize, `fit()`, Home key, and double-tap returns to, so a framed view stays framed without host code.
  - Added: the `interaction` option. `'inspect'` keeps hover, tap selection, and arrow-key stepping along the topology while wheel and touch scrolling stay the page's; `'none'` installs no listeners.
  - Added: `setPointer(clientX, clientY)` and `setPointer(null)` report a pointer from outside the canvas through the same hover path; `painted` as an event and a property reports the first frame after each attach; `pause()` clears hover at once.
  - Changed: the uniform block grows to 448 bytes and the channels bind group carries the shade's host block at binding 4; a shader build failure names every compilation error it can find.

## 0.8.0

### Minor Changes

- 196e170: One durable controller. `createNetwork(options)` is synchronous and takes neither a device nor a canvas; `attach(canvas)` leases a device and paints every retained state, `detach()` keeps it, and a lost device is replaced inside the controller.

  - Added: `attach`, `detach`, `attached`, the `attached` event, `recovering` on `deviceLost`, `load(topology, { fit })`, and the live `keyboard`, `motion`, and `wheel` options.
  - Changed: the `zoom` event is `fit`; `contextmenu` carries `{ event, keyboard, clientX, clientY, items }` with the hits already resolved; loading the topology already loaded is a no-op; borders draw only over a geographic topology; every channel slot is allocated at load.
  - Removed: the device and canvas arguments to `createNetwork`, and the `Topology`, `Item`, and `Domain` re-exports. Import them, and `validateTopology`, from `@latkit/model`.

- 196e170: Policy is an option; intent is an argument. `reveal(item, { neighbors, animate })` takes its two intents inline and the `RevealOptions` type is gone.

  - Added: `edgeBaseColor` (null averages the endpoint colors), `sizeRange` (the `vertexSize` channel's radius multipliers, the twin of `heightRange`), `sunTime` (null follows the clock), `animationMs`, `orbitRate`, `revealPaddingPx`, and `pickRadiusPx`.
  - Renamed: `baseColor` is `vertexBaseColor`.
  - Removed: `RevealOptions`, and with it `paddingPx` (now `revealPaddingPx`) and `center`; a visible item is left in place. `vertexLodPx` is gone: a vertex never zooms out of sight, its radius clamps to a 1.5 px floor the way an edge already keeps a 1 px half-width.

### Patch Changes

- 196e170: An edge ends at the rim of its endpoint discs instead of running under them, so a vertex always covers its own edges while true depth orders every other overlap. The edge shader discards fragments inside the disc the vertex pass draws, in every projection.

  - Changed: edges and focused edges write depth; halos, borders, and the earth axis only test it. Items of one kind share one depth bias, so overlapping edges or discs blend in draw order instead of cutting each other's anti-aliased fringe.

- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
  - @latkit/gpu@0.3.0
  - @latkit/model@0.4.0

## 0.7.0

### Minor Changes

- 4219e1e: One controller, three registries. `Network` gains `neighborhood`, `reveal(item, { neighbors })`, `setProjection(mode, fallback)`, `orbit(active)` with `orbiting` and an `orbit` event, `setChannelDomain`, and `getChannelDomain`; `select(item | null)` replaces `select(kind, index)` and `clearSelection`; `setChannel(channel, null)` clears; `setPose(pose, animate)` takes a boolean; every event carries one payload (`hover` and `select` an `Item | null`, `deviceLost` and `pipelineError` an object); `setColormap`, `setBaseColor`, and `fadeIn` are gone (patch `colormap` and `baseColor` through `setOptions`; the host owns canvas visibility). The height output range is the live `heightRange` option. `CHANNELS`, `OPTIONS`, and `PROJECTIONS` replace `CHANNEL_DEFINITIONS`, `channelDefinition`, `channelNormalizes`, `OPTION_DEFINITIONS`, `DEFAULT_OPTIONS`, `validateOption`, and `PROJECTION_MODES`; `Projection`, `Pose`, and `Domain` replace `ProjectionMode`, `CameraPose`, and `ChannelRange`; `Topology` and `Item` are `@latkit/model`'s. `finiteExtent`, `validateChannelRange`, `validateBorders`, `adjacency`, `revealNeighborhood`, `preferProjection`, `canAutoRotate`, and `createOrbit` are no longer exported. The packaged Natural Earth borders load through `@latkit/network/borders`.

### Patch Changes

- Updated dependencies [4219e1e]
- Updated dependencies [4219e1e]
  - @latkit/gpu@0.2.0
  - @latkit/model@0.3.0

## 0.6.1

### Patch Changes

- 986ed05: Require caller-supplied vertex coordinates for geographic interpretation: generated ring layouts no longer arm daylight shading, geographic ground clipping, the daylight refresh timer, or globe availability. Expose the stored interpretation as `Network.geographic` (mirrored by `NetworkElement.geographic`) and add an optional `Topology.coordinateSpace` declaration — `'cartesian'` keeps abstract data off geographic features even when its bounds fit lon/lat ranges — forwarded through the embed's serialized topology format.

## 0.6.0

### Minor Changes

- f061538: Unify flat, tilt, and globe navigation around a transferable camera pose; expose the active projection plus `getPose()` and `setPose()`, support pitch and bearing on the globe, and rename the public shader grouping type to `ProjectionFamily`. Apply shared solar-terminator daylight rendering across geographic projections, consolidate projection pipelines and picking math by family, and forward pose controls through `NetworkElement` and the standalone embed.

## 0.5.0

### Minor Changes

- 9a09a67: Add raw `vertexVisible` and `edgeVisible` channels with matching renderer, picking, Embed attributes, and lifecycle behavior; `Network` and `NetworkElement` consistently ignore range arguments for raw dash and visibility channels. Add `rotateBy()` plus live `vertexScale`, `edgeScale`, `heightScale`, `vertexLodPx`, and `dashPeriodPx` geometry controls with matching Embed attributes. Channel values are now snapshotted, topology fit bounds and visual scales consistently use vertices, crossing edge segments clip to positive W, teardown releases retained scene data, and asynchronous pipeline failures are exposed through `pipelineError` and forwarded by `NetworkElement` as a DOM event.

### Patch Changes

- 9a09a67: Validate encoded scenes once per topology load and stage picking indices before replacing the active renderer scene.

## 0.4.0

### Minor Changes

- 184bffc: Add view-preserving item reveal and forward it through `NetworkElement`. Export the
  colormap and option-definition types referenced by public renderer configuration. Unify flat
  and tilted height rendering, warm inactive projection pipelines serially after paints and
  topology loads, and remove duplicated topology preparation from the load path.

## 0.3.0

### Minor Changes

- 3ed363b: Add threshold-gated `contextmenu` events, synchronous CPU `hitTest` and `locate` queries, and subset fitting without changing the existing picker hot path. Forward subset fitting through `NetworkElement`.

## 0.2.0

### Minor Changes

- 17d22ec: Add the complete declarative Network embed, including durable view configuration, semantic controls, accessible interaction, shared-device recovery, packaged borders, and a bundled standalone browser entry. Export Network-owned channel, projection, option, color, focus, range, and border-validation semantics for higher-level consumers.

## 0.1.0

### Minor Changes

- 73786c4: Require application-owned native Core `GPUDevice` and `HTMLCanvasElement` instances so device sharing, canvas layout, and DOM ownership stay explicit.

### Patch Changes

- Updated dependencies [73786c4]
  - @latkit/gpu@0.1.0

## 0.0.2

### Patch Changes

- 4f87a78: Harden focus handling across pointer navigation, camera animation, and resize interactions.

## 0.0.1

### Patch Changes

- 669e369: Add Read the Docs-ready project documentation and generated TypeScript API reference metadata.
