# @latkit/monitor

## 0.7.0

### Minor Changes

- f694ea4: Render Monitor ticks, labels, gridlines, and playheads on the GPU, with serializable axis formatting and custom ticks. Live views and video exports share one plot assembly, including layout and captured glyphs. Add `Monitor.seek()` and `Monitor.toData()`; axes are enabled by default and can be hidden with null axis options.

  Move Diagram's SDF glyph infrastructure into GPU's root API. Textures track their own upload revisions, snapshots preserve glyph appearance across realms, and bounded atlases fail explicitly on exhaustion. Diagram retains its anchor-based glyph positioning and culling.

  Reuse Monitor upload buffers, bound folded-history carry storage, coalesce hover requests, and cache the latest sampled frame within a byte budget. Keep retained-image remapping during resize and enforce texture and buffer limits. Offscreen preparation uses the same awaitable sampling scheduler as interactive rendering.

  Add opt-in drag/pinch/wheel navigation, anchored `zoom`, CSS-pixel `pan`, and `fit` to Monitor.
  Retained textures respond immediately; the latest view refines after gestures settle, with exact
  readings against displayed ranges. Add asynchronous `setShade` composition with the same host
  uniform and snapshot conventions as Network and Diagram. Share shader failure diagnostics
  through GPU and preserve animated WGSL in video exports without rereading history.

### Patch Changes

- Updated dependencies [f694ea4]
  - @latkit/gpu@0.7.0

## 0.6.0

### Minor Changes

- Add renderer-owned scene snapshots and deterministic worker video exports. `@latkit/video` composes network, diagram, and monitor views on the GPU, reads pinned series through bounded port requests, and encodes MP4 or WebM with cancellation, progress, and optional streamed output. Shared render targets and awaitable channel preparation reuse existing renderer engines. Diagram snapshots retain layout and glyphs; monitor exports reuse history rendering and add a synchronized playhead.

  Validate series state before publishing it, preserve failed connection errors, and reject malformed sample blocks before transport. Video cancellation releases resources even when a destination stalls.

### Patch Changes

- Updated dependencies
  - @latkit/gpu@0.6.0
  - @latkit/model@0.10.1

## 0.5.3

### Patch Changes

- Updated dependencies [ff717f0]
  - @latkit/model@0.10.0
  - @latkit/gpu@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies
  - @latkit/model@0.9.0
  - @latkit/gpu@0.5.2

## 0.5.1

### Patch Changes

- Updated dependency: `@latkit/gpu@0.5.1`.
- Updated dependency: `@latkit/model@0.8.0`.

## 0.5.0

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

## 0.4.1

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

## 0.4.0

### Minor Changes

- 2019574: Use one append-only Series API for memory, files, and remote recordings.

  - Breaking: Series now exposes committed state, bounded strided reads, time lookup, and append events. Use createSeries for initial arrays or retained RunFrames; sample is asynchronous.
  - Breaking: RunFrames requires resultId and supports float64 values and sparse element indices. Results requires id and series(classId). connectResults takes that result id.
  - Breaking: Monitor.load accepts Series; extend, loadSource, refreshSource, and monitor-specific source types are removed. Append to the history; the monitor subscribes automatically.
  - Added: independent colorRange, error/rendered/valueRange events, bounded history and focus reads, cancellation, incremental append rendering with stable mappings, and float64 normalization before GPU upload.
  - Fixed: segment clipping, focus compositing, and canonical Viridis, Inferno, Plasma, and Magma tables. Bundled palette functions are cached.
  - Breaking: monitor JSON uses float64 time and values with optional uint32 elements; every supplied frame is committed and ranges are computed from samples.

### Patch Changes

- 2019574: Include the repository's MIT license in the published package tarballs.
- Updated dependencies [2019574]
- Updated dependencies [2019574]
  - @latkit/gpu@0.3.1
  - @latkit/model@0.5.0

## 0.3.0

### Minor Changes

- 196e170: One durable controller, as on `Network`. `createMonitor(options)` is synchronous and takes neither a device nor a canvas; `attach(canvas)` leases a device and paints the retained series, signal, frontier, selection, and options, `detach()` keeps them, and a lost device is replaced inside the controller.

  - Added: `attach`, `detach`, `attached`, the `attached` event, `recovering` on `deviceLost`, the `OPTIONS` registry, and `validateOptions`.
  - Changed: `setOptions` replaces `setColormap` and `setValueRange` (`valueRange: null` fits the committed extent); `select(element | null)` replaces `setFocus`; the `select` event replaces `pick`, and pointer-down selects the element it reports.
  - Removed: the device and canvas arguments to `createMonitor`, and the `Series` and `Domain` re-exports. Import them from `@latkit/model`.
  - Faster: the auto-fit range grows from newly committed frames only, switching signals no longer reallocates GPU storage, and the focus trace uploads incrementally.

- 196e170: Add `timeRange` (a window over the series' time axis; null shows the whole span), `focusColor` (null brightens the selected trace's own color), and `unselectedAlpha` (the alpha of every other trace while an element is selected). Readings map the cursor through the window.

### Patch Changes

- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
  - @latkit/gpu@0.3.0
  - @latkit/model@0.4.0

## 0.2.0

### Minor Changes

- 4219e1e: `Series` is `@latkit/model`'s: `time` is a `Float64Array`, and `ranges` stays optional. Nothing else changes.

### Patch Changes

- Updated dependencies [4219e1e]
- Updated dependencies [4219e1e]
  - @latkit/gpu@0.2.0
  - @latkit/model@0.3.0

## 0.1.0

### Minor Changes

- 73786c4: Require application-owned native Core `GPUDevice` and `HTMLCanvasElement` instances so device sharing, canvas layout, and DOM ownership stay explicit.

### Patch Changes

- Updated dependencies [73786c4]
  - @latkit/gpu@0.1.0

## 0.0.1

### Patch Changes

- 669e369: Add Read the Docs-ready project documentation and generated TypeScript API reference metadata.
