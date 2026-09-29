# @latkit/embed

## 0.11.4

### Patch Changes

- Updated dependencies
  - @latkit/model@0.10.1
  - @latkit/network@0.12.0
  - @latkit/monitor@0.6.0

## 0.11.3

### Patch Changes

- Updated dependencies [ff717f0]
  - @latkit/model@0.10.0
  - @latkit/monitor@0.5.3
  - @latkit/network@0.11.3

## 0.11.2

### Patch Changes

- Updated dependencies
  - @latkit/model@0.9.0
  - @latkit/monitor@0.5.2
  - @latkit/network@0.11.2

## 0.11.1

### Patch Changes

- Updated dependency: `@latkit/model@0.8.0`.
- Updated dependency: `@latkit/monitor@0.5.1`.
- Updated dependency: `@latkit/network@0.11.1`.

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
- Updated dependencies [da58150]
  - @latkit/model@0.7.0
  - @latkit/colormaps@0.3.0
  - @latkit/network@0.11.0
  - @latkit/monitor@0.5.0

## 0.10.1

### Patch Changes

- Updated dependencies [b2631b8]
- Updated dependencies [b2631b8]
  - @latkit/model@0.6.0
  - @latkit/network@0.10.3
  - @latkit/monitor@0.4.1
  - @latkit/colormaps@0.2.2

## 0.10.0

### Minor Changes

- 2019574: Use one append-only Series API for memory, files, and remote recordings.

  - Breaking: Series now exposes committed state, bounded strided reads, time lookup, and append events. Use createSeries for initial arrays or retained RunFrames; sample is asynchronous.
  - Breaking: RunFrames requires resultId and supports float64 values and sparse element indices. Results requires id and series(classId). connectResults takes that result id.
  - Breaking: Monitor.load accepts Series; extend, loadSource, refreshSource, and monitor-specific source types are removed. Append to the history; the monitor subscribes automatically.
  - Added: independent colorRange, error/rendered/valueRange events, bounded history and focus reads, cancellation, incremental append rendering with stable mappings, and float64 normalization before GPU upload.
  - Fixed: segment clipping, focus compositing, and canonical Viridis, Inferno, Plasma, and Magma tables. Bundled palette functions are cached.
  - Breaking: monitor JSON uses float64 time and values with optional uint32 elements; every supplied frame is committed and ranges are computed from samples.

### Patch Changes

- Updated dependencies [2019574]
- Updated dependencies [2019574]
  - @latkit/colormaps@0.2.1
  - @latkit/model@0.5.0
  - @latkit/monitor@0.4.0
  - @latkit/network@0.10.2

## 0.9.1

### Patch Changes

- Updated dependencies [a90cb89]
  - @latkit/network@0.10.1

## 0.9.0

### Minor Changes

- 298b509: Vertex placement is a channel. `vertexPosition` holds interleaved `x, y` pairs in topology coordinates, the shape `vertexCoords` has; `load` seeds it from the topology, and rebinding it moves vertices, the ends of their edges, and their height poles at the cost of one upload, with no reload and no allocation, so a layout engine can hand over its array every frame.

  - Added: the `vertexPosition` channel, raw and always bound while a topology is loaded; `null` restores the topology's own layout. `CHANNELS` entries carry `components`, `2` for position and `1` for every scalar channel, and a channel's length is `count * components`. `fit()` frames the positions in effect; `null` is accepted before a load, as for every channel. `NetworkField` carries `components` (`1`, or `2` for an interleaved pair; the JSON slot defaults to `1`), and the `vertex-position` attribute on `latkit-network` binds a vertex pair field.
  - Changed: the plane shaders read vertex placement from the position channel, the edge ends follow the endpoint vertices, and polyline bends keep the coordinates the topology baked; the picker indexes the position snapshot and rebuilds its index only once positions have held still, so while positions change from one frame to the next hover clears and `hitTest` finds nothing, resuming one frame after the last write; the globe draws the layout the topology carries, so `projections.globe` is false while positions override it and binding positions on the globe falls back to flat; the uniform block grows to 464 bytes.
  - Fixed: an `msaa` attribute present when the controller is created no longer warns on creation and after every load; only a later change to it does.

### Patch Changes

- Updated dependencies [298b509]
  - @latkit/network@0.10.0

## 0.8.0

### Minor Changes

- fd27b40: `latkit-network` reflects the controller's first paint and reads the new network options and channels from attributes.

  - Added: the `painted` attribute and event, present once the bound canvas has shown a frame; `interaction`, `fit-padding-px` (one value or four), `fit-pitch`, `fit-bearing`, `vertex-shade`, and `edge-shade` attributes, mechanically from the registries.

### Patch Changes

- Updated dependencies [fd27b40]
  - @latkit/network@0.9.0

## 0.7.1

### Patch Changes

- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
  - @latkit/colormaps@0.2.0
  - @latkit/model@0.4.0
  - @latkit/monitor@0.3.0
  - @latkit/network@0.8.0

## 0.7.0

### Minor Changes

- 4219e1e: Build `latkit-network` on the tightened primitives of its dependencies and mirror the new `Network` surface one-to-one.

  - The device pool, colormap registry, and Network registries now come from `@latkit/gpu` (`createDevicePool`), `@latkit/colormaps` (`COLORMAPS`, `gradient`), and `@latkit/network` (`CHANNELS`, `OPTIONS`, `PROJECTIONS`, `validateOptions`) instead of private copies or removed helpers. The attribute table is derived from `OPTIONS` and `CHANNELS`.
  - `hover` and `select` DOM events carry an `Item | null` detail (`{ kind, index }`), `zoom` and the new `orbit` event carry a boolean, `deviceLost` carries `{ reason, message, recovering }`, and `pipelineError` carries `{ family, cause }`. The separate `*EventDetail` interfaces are gone; `NetworkElementEventMap` inlines every detail shape.
  - The element forwards exactly the `Network` verbs: `setOptions`, `setBorders`, `setChannel(channel, values | null, domain?)`, `setChannelDomain`, `getChannelDomain`, `setProjection(mode, fallback?)`, `fit`, `reveal`, `neighborhood`, `select(item | null)`, `panBy`, `rotateBy`, `getPose`, `setPose(pose, animate?)`, `zoomBy`, `orbit`, `pause`, and `resume`, plus the readonly `projections`, `geographic`, and `orbiting`.
  - The height output range is the ordinary live option `heightRange`, reflected as the `height-range` attribute; the per-channel `vertex-height-range` attribute and the fourth `setChannel` argument are gone.
  - Removed: `setColormap` (use `setOptions({ colormap })`), `setBaseColor` (use `setOptions({ baseColor })`), `clearChannel` (use `setChannel(channel, null)`), `setChannelRange` (use `setChannelDomain`), `clearSelection` (use `select(null)`), and `fadeIn`. The barrel exports only `register`, `parseNetwork`, and the types `NetworkElement`, `NetworkElementEventMap`, `NetworkData`, and `NetworkJSON`.

  The border binaries remain published under `@latkit/embed/assets/*` for the standalone bundle.

### Patch Changes

- Updated dependencies [4219e1e]
- Updated dependencies [4219e1e]
- Updated dependencies [4219e1e]
  - @latkit/colormaps@0.1.0
  - @latkit/gpu@0.2.0
  - @latkit/network@0.7.0

## 0.6.1

### Patch Changes

- 986ed05: Require caller-supplied vertex coordinates for geographic interpretation: generated ring layouts no longer arm daylight shading, geographic ground clipping, the daylight refresh timer, or globe availability. Expose the stored interpretation as `Network.geographic` (mirrored by `NetworkElement.geographic`) and add an optional `Topology.coordinateSpace` declaration — `'cartesian'` keeps abstract data off geographic features even when its bounds fit lon/lat ranges — forwarded through the embed's serialized topology format.
- Updated dependencies [986ed05]
  - @latkit/network@0.6.1

## 0.6.0

### Minor Changes

- f061538: Unify flat, tilt, and globe navigation around a transferable camera pose; expose the active projection plus `getPose()` and `setPose()`, support pitch and bearing on the globe, and rename the public shader grouping type to `ProjectionFamily`. Apply shared solar-terminator daylight rendering across geographic projections, consolidate projection pipelines and picking math by family, and forward pose controls through `NetworkElement` and the standalone embed.

### Patch Changes

- Updated dependencies [f061538]
  - @latkit/network@0.6.0

## 0.5.0

### Minor Changes

- 9a09a67: Add raw `vertexVisible` and `edgeVisible` channels with matching renderer, picking, Embed attributes, and lifecycle behavior; `Network` and `NetworkElement` consistently ignore range arguments for raw dash and visibility channels. Add `rotateBy()` plus live `vertexScale`, `edgeScale`, `heightScale`, `vertexLodPx`, and `dashPeriodPx` geometry controls with matching Embed attributes. Channel values are now snapshotted, topology fit bounds and visual scales consistently use vertices, crossing edge segments clip to positive W, teardown releases retained scene data, and asynchronous pipeline failures are exposed through `pipelineError` and forwarded by `NetworkElement` as a DOM event.

### Patch Changes

- Updated dependencies [9a09a67]
- Updated dependencies [9a09a67]
  - @latkit/network@0.5.0

## 0.4.0

### Minor Changes

- 184bffc: Add view-preserving item reveal and forward it through `NetworkElement`. Export the
  colormap and option-definition types referenced by public renderer configuration. Unify flat
  and tilted height rendering, warm inactive projection pipelines serially after paints and
  topology loads, and remove duplicated topology preparation from the load path.

### Patch Changes

- Updated dependencies [184bffc]
  - @latkit/network@0.4.0

## 0.3.0

### Minor Changes

- 3ed363b: Add threshold-gated `contextmenu` events, synchronous CPU `hitTest` and `locate` queries, and subset fitting without changing the existing picker hot path. Forward subset fitting through `NetworkElement`.

### Patch Changes

- Updated dependencies [3ed363b]
  - @latkit/network@0.3.0

## 0.2.0

### Minor Changes

- 17d22ec: Add the complete declarative Network embed, including durable view configuration, semantic controls, accessible interaction, shared-device recovery, packaged borders, and a bundled standalone browser entry. Export Network-owned channel, projection, option, color, focus, range, and border-validation semantics for higher-level consumers.

### Patch Changes

- Updated dependencies [17d22ec]
  - @latkit/network@0.2.0
