# @latkit/model

## 0.9.0

### Minor Changes

- Let an engine offer its studies as forms any frontend draws, and record an input that names one.

  - Added: `engine.studies`, the studies an engine offers as plain data, each an `Engine.Study`: a label, the `formats` it records, its `parameters` by kind (`number`, `text`, `flag`, `choice`, `element`, or `file`), and `groups`, one with a `switch` turning its parameters on and off. A subclass passes `studies` to the constructor and `offer`s one later, the return withdrawing it; `on('change')` tells.
  - Added: `engine.shown(input)` and `engine.problems(model, input)`: what an input's form shows, and what is wrong with it by parameter.
  - Added: once it offers a study, an engine records only an input that names one, `{ study, values }`. `record` checks the values against the form, throwing a `Refusal` at the parameter to fix before anything is recorded; `parse` gets each shown parameter's value, null for one left empty, and each switch's position; the recording's label defaults to the study's. A parameter marked `each` takes several values in a form, and a host records once for each.
  - Added: an optional `engine.read(model, file)`, the input a saved file holds.
  - Changed: `Refusal.at` may name a study's parameter by id.
  - Changed: `serveEngine` carries the engine's studies and `read`. `connectEngine` resolves once the studies its peer offers are in, follows each change, and checks a study's form where it is.

## 0.8.0

### Minor Changes

- Added asynchronous document sessions with cached views, shared schematic lookups, typed revision conflicts, and closable immutable model snapshots.
- Added required `Document.inspect(element)` for native editable values, identity, and complete wiring, independently of model snapshots and diagram visibility. Document subclasses must implement this method.
- Added `session.apply(base, ...operations)` for drafts checked against their inspected revision. Ordinary apply calls retain their existing behavior.

### Patch Changes

- Fixed failed document model opens so the next call retries without another edit. Concurrent readers share each attempt, and a superseded failure cannot invalidate a newer capture.

## 0.7.0

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

- da58150: Fix a released helper.

  - Fixed: a grid query no longer keeps a Node process from exiting.

## 0.6.0

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

## 0.5.0

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

## 0.4.0

### Minor Changes

- 196e170: - Added: `RGBA` and `Colormap` types, `validateRgba`, `bakeColormap` with `COLORMAP_LUT_SIZE`, and `createEmitter`; the one home for the color vocabulary and the event dispatcher every renderer shares.
- 196e170: Add `Domain`, the `[min, max]` every renderer takes, with `extent(values)` to scan one and `validateDomain(value, name)` to check one, and `validateTopology`, the topology check a host runs before a device exists (moved here from `@latkit/network`).

## 0.3.0

### Minor Changes

- 4219e1e: Add `Field` and `FieldRef`, the identity of one quantity of a class a host binds or plots, with `fieldsOf` and `fieldKey`. `Topology`, `Item`, and `Series` are now the one definition every renderer imports; `Series.ranges` is optional so a hand-built series need not carry it. `Loader` and `signalIndex` are no longer exported.

## 0.2.0

### Minor Changes

- 299e99f: Add `Results`, the interface for what a run leaves behind: its recorded samples read back class by class as the `RunFrames` batches the run streamed. `collect` now also folds an async stream of batches, filling a preallocated series when the frame count is known.

## 0.0.1

### Patch Changes

- 669e369: Add Read the Docs-ready project documentation and generated TypeScript API reference metadata.
