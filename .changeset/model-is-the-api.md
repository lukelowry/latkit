---
'@latkit/model': minor
'@latkit/port': minor
'@latkit/gpu': minor
'@latkit/colormaps': minor
'@latkit/network': minor
'@latkit/diagram': minor
'@latkit/monitor': minor
'@latkit/embed': minor
---

Make the model the API as a few classes a format, an engine, and an editor subclass, share one channel binder, open every lazy thing from a source, and give every package one entrypoint.

- Added: `Model` in `@latkit/model`, the class a format subclasses. It describes a case to the constructor, which checks it once, and gives each class's `values` when asked, the case's `bytes`, and, for a format that edits, its `document`. Every question about a case is a method: `class`, `load`, `elementAt`, `itemOf`, `fields`, `field`, `grid`, `record`, and `source`.
- Added: `Engine`, the class an engine subclasses: `parse` checks an input, and `execute` records a model for one through an `Engine.Recorder`, whose `append(time, values)` commits frames for every recorded class at once, `values` keyed by class id. Attach one as `model.engine` at any time; `model.record(input, { id, label })` checks the input at once and returns a `Recording` that waits its turn, then fills. An engine records as many as its `concurrency` allows and queues the rest, telling each how many wait before it, and `engine.record(model, input, recorder)` records into any recorder, which is how a port forwards one.
- Added: `Recording`, every class an engine records on one clock. `state` publishes `status` (`waiting`, `recording`, `complete`, `stopped`, or `failed`), `ahead`, `frameCount`, `timeRange`, and `error` together; `span`, `expectedFrames`, and `log` are what its engine declared and said; `frameAt` and `timeAt` read the clock, `series(classId)` is each class's history, and `stop()` keeps what it has.
- Added: `Document`, the class a format that edits subclasses. `apply(...operations)` makes `Document.Operation`s, in the model's identities, true as one step; `undo`, `redo`, and `history` keep one history; `schematic` is the case as a diagram draws it, with `elementAt`, `partOf`, `portAt`, and `portOf` between its parts and the case; and `model()` follows each change with a model that keeps the engine. An edit it refuses throws `Refusal`, saying why and what it is about.
- Added: `model.field(ref, recording)`, a number column or a recorded signal as the `{ series, signal }` every renderer binds, with its label, unit, live `domain`, and `at(time)`. `field.gather(elements)` is the field over other items, such as a diagram's nets over the elements that drive them, keeping its clock and domain. A column is a sealed series of one frame, and one reference resolves to one series.
- Added: `model.grid(classId, at?)`, a class as a table, its recorded signals sampled at `{ recording, time }` when given. `grid.columns` says what each cell shows, and a sort names a column by its index there.
- Added: `model.source()` and `Model.from(source)`, and `recording.source()` and `Recording.from(source)`: a model or a recording held elsewhere, in a file or across a port, opens from its source and reads what it holds on demand, a series in windows of at most 1 MiB.
- Added: `Series.create`, a history in memory to `append({ time, values })` to and `seal()`. A source of samples held anywhere else subclasses `Series`.
- Added: `RGBA`, `Colormap`, and `validateRgba` in `@latkit/colormaps`, beside the `COLORMAPS` catalog, `colormap`, `gradient`, and `parseColor`, so the color vocabulary has one home; `@latkit/colormaps` no longer depends on `@latkit/model`.
- Added: `createChannels` in `@latkit/gpu`, the channel binder the network and the diagram now share: a slot per channel, domains, and series followed around a playhead with their frames resident on the GPU. `bakeColormap`, `COLORMAP_LUT_SIZE`, and `createEmitter` live there too.
- Added: a `series` field on every `CHANNELS` entry of `@latkit/diagram`, as on the network's: whether the channel can follow a series.
- Added: `serveModel` and `connectModel` in `@latkit/port`: a model served across a port, its classes loading as they are asked for and, with an engine, each recording made by the served engine and forwarded call by call, its frames handed over without a copy. `serveRecording` and `connectRecording` open a recording from its source on the far side. A connected side is a `Remote<T>`.
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
- Removed: `createModel`, for subclassing `Model`; `openModel` and `sourceOf`, for `Model.from` and `model.source()`; `elementAt`, `itemOf`, `fieldsOf`, and `createGrid`, for the model's methods; `createSeries`, for `Series.create`; `sample`, for `field.at`; `fieldKey`; `position`; and `Runner`, `RunUpdate`, `RunFrames`, `Results`, `collect`, and `Progress`, for `Engine` and `Recording`.
- Removed: `RGBA`, `Colormap`, `validateRgba`, `bakeColormap`, `COLORMAP_LUT_SIZE`, and `createEmitter` from `@latkit/model`; import them from `@latkit/colormaps` and `@latkit/gpu`.
- Removed: every subpath. Use `check` and `loopback` from `@latkit/port` for `@latkit/port/guard` and `@latkit/port/testing`, the network and diagram roots for `@latkit/network/borders`, `@latkit/network/shades`, and `@latkit/diagram/layout`, and `register()` for `@latkit/embed/register`. `embed.js` stays a page script.
- Removed: `Monitor.setSignal` and `Monitor.clear`; load another signal of the series, or null.
