# @latkit/port

## 0.4.0

### Minor Changes

- Added `serveDocument` and `connectDocument` over existing ports, with serialized edits and reads, bounded reconnect replay, incremental view events, and closable immutable model snapshots.
- Added revision-bound document inspection with validated, bounded public payloads and cancellable queued reads. Explicit edit bases use the existing command and replay path.
- Added optional scoped model service IDs while preserving the default model channel.

### Patch Changes

- Fixed framed transport to preserve dictionary keys such as `__proto__`, including inspection column names.
- Updated dependency: `@latkit/model@0.8.0`.

## 0.3.0

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

- da58150: - Changed: a frame's prefix is the magic and the header length; the version byte and reserved bytes are gone, so both ends of a byte port run the same release.

### Patch Changes

- Updated dependencies [da58150]
- Updated dependencies [da58150]
- Updated dependencies [da58150]
- Updated dependencies [da58150]
  - @latkit/model@0.7.0

## 0.2.1

### Patch Changes

- 2019574: Include the repository's MIT license in the published package tarballs.

## 0.2.0

### Minor Changes

- 4219e1e: Narrow the root barrel to `messagePort`, `bytePort`, `socketPort`, `protocol`, `serve`, `connect`, `transferred`, `describeError` and the types `Port`, `Protocol`, `Service`, `Connection`. `ByteTarget`, `MessageTarget`, `SocketTarget`, `Progress`, `Handler`, `CallOptions`, and the `Transferred` class are no longer exported (the constructors take their targets structurally, and call options are inline on `call` and `stream`); `Guard` is imported from `@latkit/port/guard`.

## 0.1.0

### Minor Changes

- e65dc17: Add `@latkit/port`: a two-method `Port` over workers, webviews, and sockets (`messagePort`,
  `bytePort`, `socketPort`); one versioned binary frame that carries typed arrays intact; and typed
  request, reply, and stream protocols (`protocol`, `serve`, `connect`) with guards from
  `@latkit/port/guard` and an in-memory pair in `@latkit/port/testing`.
