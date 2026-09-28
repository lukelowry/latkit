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

Make the model the API, share one channel binder, move every lazy thing through a source, and give every package one entrypoint.

- Added: `Recording` in `@latkit/model`, one run's output with every recorded class on one clock. `model.record(header)` makes one to `append` blocks to and `seal`; a class a block leaves out reads NaN over it. `state` publishes `frameCount`, `timeRange`, and `live` together, and `frameAt(time)` and `timeAt(frame)` read the clock at once.
- Added: `model.run(command, header)` on a model with an engine, given as `createModel({ run })`. It fills the recording it returns as frames arrive, yields every update, and seals the recording when the run ends; leaving the loop early cancels it, and a run its signal aborts ends `cancelled`.
- Added: `model.field(ref, recording)`, a number column or a recorded signal as the `{ series, signal }` every renderer binds, with its label, unit, live `domain`, and `at(time)`. A column is a sealed series of one frame, so a bound column takes two playback slots, and one reference resolves to one series.
- Added: `model.grid(classId, at?)`, a class as a table, its recorded signals sampled at `{ recording, time }` when given. `grid.columns` says what each cell shows, and a sort names a column by its index there.
- Added: `model.class(id)`, `model.elementAt(item)`, `model.itemOf(ref)`, and `model.source()`, a model's bytes and engine.
- Added: `recording.source()` and `openRecording(source)` in `@latkit/model`: a recording held elsewhere, across a port or in a file, opens with its clock at hand and reads its samples on demand. A host implements `RecordingSource` to open one from its own storage.
- Added: `validateSeries` in `@latkit/model`, and the `queued` and `running` run updates.
- Added: `RGBA`, `Colormap`, and `validateRgba` in `@latkit/colormaps`, beside the `COLORMAPS` catalog, `colormap`, `gradient`, and `parseColor`, so the color vocabulary has one home; `@latkit/colormaps` no longer depends on `@latkit/model`.
- Added: `createChannels` in `@latkit/gpu`, the channel binder the network and the diagram now share: a slot per channel, domains, and series followed around a playhead with their frames resident on the GPU. `bakeColormap`, `COLORMAP_LUT_SIZE`, and `createEmitter` live there too.
- Added: a `series` field on every `CHANNELS` entry of `@latkit/network` and `@latkit/diagram`: whether the channel can follow a series.
- Added: `serveModel` and `connectModel` in `@latkit/port`: a model served across a port, its classes loading as they are asked for and its runs streaming from the served engine, and `serveRecording` and `connectRecording`, a recording opened from its source on the far side. A connected side is a `Remote<T>`.
- Added: `check` in `@latkit/port`, the checks a protocol runs on every request. Each throws a `TypeError` naming what is wrong, so a refused request says why, and the compiler keeps every field's check the field's type. `loopback()` joins the transports.
- Added: `loadBorders` and `spotlight` in `@latkit/network`, and `arrange` in `@latkit/diagram`, whose one entrypoint loads in a worker without a DOM or a device.
- Changed: `createModel` takes one object: the description, `load`, `bytes`, and an optional `run`. Each class declares its `columns` before any data loads, and a loader returns labels and column values in that order.
- Changed: a `Series` names its signals in `signals` in place of `signalCount`, adds `state.live`, and emits `change` on an append or the seal. `createSeries({ signals, elementCount })` returns a history with `append({ time, values })` and `seal()`.
- Changed: a run's frames are one block: `time`, and `values` keyed by class id; they no longer carry `resultId`, `classId`, or counts.
- Changed: `FieldRef.source` is `kind`.
- Changed: `Monitor.load` takes `{ series, signal }`, the binding `setChannel` takes, so a `Field` loads as it is. `latkit-monitor` JSON names its signals in `signals`, and the `signal` attribute names one by id.
- Changed: a protocol takes a `check` in place of a guard.
- Changed: a pack's core declares each class's columns, a shard holds only their values, and the container carries no version or flags. A pack made by an earlier release does not open; pack the model again.
- Removed: `@latkit/remote`; serve a model and its recordings with `@latkit/port`.
- Removed: `RGBA`, `Colormap`, and `validateRgba` from `@latkit/model`; import them from `@latkit/colormaps`.
- Removed: every subpath. Use `check` and `loopback` from `@latkit/port` for `@latkit/port/guard` and `@latkit/port/testing`, the network and diagram roots for `@latkit/network/borders`, `@latkit/network/shades`, and `@latkit/diagram/layout`, and `register()` for `@latkit/embed/register`. `embed.js` stays a page script.
- Removed: `Runner`, since a model runs; `fieldKey`; `createGrid`, for `model.grid`; `sourceOf`, `elementAt`, `itemOf`, `fieldsOf`, `sample`, `collect`, and `Results`, for the model's methods, `Recording`, and `Field.at`; and the `started` run update, for `running`.
- Removed: the `ClassSpec`, `ClassData`, `Column`, `Signal`, `ElementRef`, `Progress`, `RunFrames`, `GridSort`, and `GridWindow` exports; reach them through `Model`, `Source`, `RunUpdate`, and `Grid`.
- Removed: `Monitor.setSignal`; load another signal of the series.
