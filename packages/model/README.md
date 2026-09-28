# @latkit/model

The vocabulary every latkit package speaks: the immutable, columnar model of a network and its
element classes that a vendor builds once, the instance every question about it goes to, the
recordings its runs fill and the fields a host binds, and the sources that move a model or a
recording across a boundary lazily. It has no dependencies, I/O, or rendering.

| Noun        | What it is                                                                                |
| ----------- | ----------------------------------------------------------------------------------------- |
| `Model`     | The instance: topology, owners, classes that declare their columns and signals, lazy data |
| `Recording` | One run's output: a `Series` per recorded class, every class on one clock                 |
| `Series`    | Append-only samples over one element axis and time, read in bounded windows               |
| `Field`     | One number column or signal, resolved to the `{ series, signal }` every renderer binds    |
| `Grid`      | One class as a table: search, sort, and windows of formatted rows                         |
| A run       | What an engine emits, `RunUpdate`s, and the recording they fill                           |
| `Source`    | The same model as bytes and an engine; a `RecordingSource` is a recording held elsewhere  |
| `Netlist`   | A block diagram's structure: blocks, the ports each owns, and the nets that join ports    |

`Topology` and `Item` are field-for-field the shapes `@latkit/network` loads and picks, as `Netlist`
and `Part` are for `@latkit/diagram`, so a model never adapts for a renderer. `Domain` is the
`[min, max]` every renderer takes; `extent` scans one and `normalizeDomain` pads one for display.
`validateTopology`, `validateNetlist`, `validateSeries`, and `validateDomain` check what a host
builds before a device exists.

## Produce a model

A vendor builds a model with `createModel`; there is no interface to implement. Each class declares
its columns and signals up front, and the loader returns its labels and column values in that
order. Owner classes are the ones whose element `i` is vertex `i` or edge `i`; any other class may
anchor each element to a topology item, `0xffffffff` marking an element with no place. A model with
an engine runs; `run` yields a run's updates and ends with one done, cancelled, or failed.

```ts
import { createModel } from '@latkit/model';

const model = createModel({
  vendor: 'gridkit',
  id: caseId,
  name: 'IEEE 14',
  meta: { freqBase: 60 },
  topology,
  owners: { vertex: 'bus', edge: 'branch' },
  classes: [
    {
      id: 'bus',
      label: 'Bus',
      count: 14,
      columns: [{ kind: 'number', id: 'baseKV', label: 'Base kV', unit: 'kV' }],
      signals: [{ id: 'Vm', label: 'Voltage', unit: 'pu', recorded: true }],
    },
    {
      id: 'gen',
      label: 'Generator',
      count: 5,
      anchor: { kind: 'vertex', index: genBus },
      columns: [],
      signals: [{ id: 'P', label: 'Power', unit: 'MW', recorded: true }],
    },
  ],
  load: async (classId) => ({ labels: labelsOf(classId), values: valuesOf(classId) }),
  bytes: async () => caseBytes,
  run: (command, signal) => engine.run(command, signal), // omitted when the model cannot run
});
```

## Ask the model

Every question about a model is a method on it.

```ts
network.load(model.topology);
network.on('select', (item) => {
  const ref = item && model.elementAt(item); // the element a pick is
  if (ref) inspect(ref);
});
model.itemOf({ classId: 'gen', index: 2 }); // where it sits: { kind: 'vertex', index: 7 }

const spec = model.class('bus')!; // columns and signals, declared before any data loads
const bus = await model.load('bus'); // labels and columns, loaded once and shared

const grid = await model.grid('bus'); // the class as a table
const { rows, total } = await grid.window('north', { column: 0, dir: 'desc' }, 0, 50);
const now = await model.grid('bus', { recording, time: t }); // its signals too, sampled at t
```

A grid's `columns` say what each cell shows: the class's columns, then, at a time, every signal
the recording holds. A sort names a column by its index there, or `null` for the label.
`formatNumber` is the rule its cells follow, for any number shown beside them.

## Run the model

A run fills one recording, which holds every class that records a signal. Iterate the run to run
it: each update as it arrives, frames already appended, ending with one done, cancelled, or failed,
after which the recording is sealed. Leaving the loop early cancels it; an aborted signal ends it
as cancelled.

```ts
const run = model.run!(command, { id: study.id, span: [0, 20], expectedFrames: 2000, signal });
network.setChannel('vertexColor', await model.field(VM, run.recording));
for await (const update of run) {
  if (update.type === 'queued') showQueue(update.ahead);
  else if (update.type === 'log') print(update);
  else if (update.type !== 'frames' && update.type !== 'running') end(update); // done, cancelled, or failed
}
```

`model.record(header)` makes the same recording empty, for frames that come from anywhere else:
`append({ time, values })` commits a block for every class at once, a class it leaves out reading
NaN over it, and `seal()` ends it. A block's values are frame-major per class,
`values[classId][(frame * signals + signal) * elements + element]`, signals in the order
`recording.series(classId)` lists them. `recording.state` publishes `frameCount`, `timeRange`, and
`live` together, `on('change')` follows appends and the seal, and `frameAt(time)` and
`timeAt(frame)` read the clock at once.

## Bind a field

A `Field` is one number column or one recorded signal, resolved to the `{ series, signal }` every
renderer binds: a column's series is sealed with one frame, which holds at every time. A picker
lists a class's fields from its declared `columns` and `signals` without loading anything; a
`FieldRef` is the plain data a host persists.

```ts
const vm = await model.field({ classId: 'bus', kind: 'signal', id: 'Vm' }, recording);
const kv = await model.field({ classId: 'bus', kind: 'column', id: 'baseKV' });
if (vm) network.setChannel('vertexColor', vm); // frames stay on the GPU; the domain follows
if (kv) network.setChannel('vertexHeight', kv);
if (vm) monitor.load(vm);
network.seek(t);
const values = await vm?.at(t); // every bus at t, NaN where one has no value
```

A field resolves to null when the model or the recording has no values for it. One reference
resolves to one series, so the renderers binding it share its frames, and `domain` is the display
interval over every committed value.

## Keep a history

`createSeries` is an in-memory history for samples that are not a run of a model. Initial `time`
and `values` are signal-major; appends are frame-major. Buffers are borrowed, never mutated or
detached after publication, and reads within one append are zero-copy views.

```ts
import { createSeries } from '@latkit/model';

const series = createSeries({ signals: ['temperature'], elementCount: 3 });
series.append({ time: Float64Array.of(0), values: Float32Array.of(21, 22, 23) });
monitor.load({ series, signal: 0 });
series.seal(); // no frame follows
```

`read(signal, window)` borrows a bounded, strided window, and `locate([from, to], frameCount)`
returns the half-open frame interval holding those times within a captured head. Only request
committed frames. `state.ranges` holds each signal's finite extent, a NaN pair while it has none.

## Move a model or a recording

Everything lazy opens from a source. A model's `Source` is its bytes, one core plus one shard per
class, and its engine; a `RecordingSource` is a recording's declaration, its clock as it grows, and
sample windows on demand. `source()` makes one from the instance, and `openModel` and
`openRecording` open one from anywhere: a file, a fetch, or `@latkit/port`, which serves exactly
these across a port.

```ts
import { openModel, openRecording } from '@latkit/model';

// pack, for example when staging a library at build time
const source = model.source();
await write('core.bin', await source.core());
for (const spec of model.classes) await write(`${spec.id}.bin`, await source.class(spec.id));

// unpack, classes still lazy
const opened = await openModel(
  { core: fetchCore, class: fetchShard, bytes: fetchCase },
  { signal, progress: (loaded, total) => bar.set(loaded / total) },
);

// a recording held elsewhere: its clock at hand, its samples read on demand
const results = await openRecording(resultsFile(path));
```

The pack format is private: a small JSON directory, the core's declaring every class's columns and
signals, followed by 8-byte-aligned typed sections, so unpacking is a set of typed-array views into
the received buffer.

## Describe a diagram

A `Netlist` is a block diagram's structure as columns: blocks, the ports each block owns
(`portStart` offsets), and the nets that join ports (`netStart` offsets into `netPorts`). A net has
at most one `out` port, its driver, and a port joins at most one net. Placement is not structure;
`blockKey` keeps each block's position, placement, and selection across reloads.

```ts
import { validateNetlist, type Netlist } from '@latkit/model';

// TGOV1 drives pmech, IEEET1 drives efd, GENROU's speed feeds both back.
const unit: Netlist = {
  blockCount: 3,
  blockKey: ['Genrou/1_1_genrou', 'Tgov1/1_1_tgov1', 'Ieeet1/1_1_ieeet1'],
  blockTitle: ['GENROU', 'TGOV1', 'IEEET1'],
  portStart: Uint32Array.of(0, 3, 5, 7),
  portFlow: Uint8Array.of(0, 0, 1, /* tgov1 */ 0, 1, /* ieeet1 */ 0, 1),
  portLabel: ['pmech', 'efd', 'speed', 'speed', 'pmech', 'speed', 'efd'],
  netStart: Uint32Array.of(0, 2, 4, 7),
  netPorts: Uint32Array.of(4, 0, /* efd */ 6, 1, /* speed */ 2, 3, 5),
  netLabel: ['1_1_pmech', '1_1_efd', '1_1_speed'],
};
validateNetlist(unit);
```
