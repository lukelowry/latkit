# @latkit/model

The immutable, columnar description of a network and its element classes that a vendor produces
once and every latkit renderer and view consumes directly, plus the byte form that lets it cross a
process boundary lazily.

Seven nouns:

| Noun      | What it is                                                                                |
| --------- | ----------------------------------------------------------------------------------------- |
| `Model`   | A value: topology, owners, element classes, and one lazy, cached loader for class columns |
| `Field`   | One quantity of a class a host binds or plots: a numeric column or a recorded signal      |
| `Series`  | Append-only samples over one element axis and time, read in bounded windows               |
| A run     | What any engine emits: `RunUpdate`s whose frames `collect` into a `Series`                |
| `Results` | What a run leaves behind: its recorded samples, read back class by class as those batches |
| `Source`  | The same model as bytes: one core plus one shard per class, owned by whoever asks         |
| `Netlist` | A block diagram's structure: blocks, the ports each owns, and the nets that join ports    |

`Topology` and `Item` are field-for-field the shapes `@latkit/network` loads and picks, so a model
never adapts for a renderer. `Domain` is the `[min, max]` every renderer takes; `extent` scans one,
`validateDomain` checks one, and `validateTopology` checks a topology, all before a device exists.
`Netlist` is likewise the shape `@latkit/diagram` loads, and `validateNetlist` checks one. The
package has no dependencies, I/O, or rendering.

## Produce a model

A vendor builds a model with `createModel`; there is no interface to implement. Owner classes are
the ones whose element `i` is vertex `i` or edge `i`, and they declare nothing more. Any other class
may anchor each element to a topology item, `0xffffffff` marking an element with no place. Columns
are scalar: number, text, or flag.

```ts
import { createModel, type ClassData } from '@latkit/model';

const model = createModel(
  {
    vendor: 'gridkit',
    id: caseId,
    name: 'IEEE 14',
    meta: { freqBase: 60 },
    topology,
    owners: { vertex: 'bus', edge: 'branch' },
    classes: [
      { id: 'bus', label: 'Bus', count: 14, signals: BUS_SIGNALS },
      {
        id: 'gen',
        label: 'Generator',
        count: 5,
        anchor: { kind: 'vertex', index: genBus },
        signals: GEN_SIGNALS,
      },
    ],
  },
  {
    load: async (classId): Promise<ClassData> => columnsFor(classId),
    bytes: async () => caseBytes,
  },
);
```

## Consume a model

```ts
import { createGrid, elementAt, extent, itemOf } from '@latkit/model';

network.load(model.topology);

const bus = await model.load('bus');
const vm = bus.columns.find((column) => column.id === 'Vm');
if (vm?.kind === 'number') {
  const values = Float32Array.from(vm.values);
  network.setChannel('vertexColor', values, extent(values));
}

network.on('select', (item) => {
  const ref = item && elementAt(model, item);
  if (ref) console.log(bus.labels[ref.index]);
});

const grid = createGrid(bus.labels, bus.columns);
const { rows, total } = await grid.window('north', { column: 'Vm', dir: 'desc' }, 0, 50);
```

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

## Name what a host shows

A `Field` is one quantity of a class: a numeric column, or a signal the class records. A binding
picker, a plot lane, and an inspector row all speak in fields, never in columns or arrays.
`fieldsOf` lists a class's fields and `fieldKey` keys a reference to one.

```ts
import { fieldKey, fieldsOf } from '@latkit/model';

const fields = fieldsOf(spec, await model.load(spec.id), results);
const bound = new Map(fields.map((field) => [fieldKey(field), field]));
```

## Run a model

A `Runner` emits `RunUpdate`s. Every frame batch names its `resultId` and `classId`; keep those
pairs separate when collecting histories.

```ts
import { collect, sample, type RunFrames } from '@latkit/model';

const frames: RunFrames[] = [];
for await (const update of runner.run(command, signal)) {
  if (update.type === 'frames' && update.resultId === resultId && update.classId === 'bus')
    frames.push(update);
}
const series = collect(frames);
monitor.load(series, 0);

const head = series.state.frameCount;
if (head) {
  const [, end] = await series.locate([t, t], head, signal);
  const values = await sample(series, 0, Math.max(0, end - 1), signal);
  console.log(values);
}
```

## Read and retain samples

`createSeries({ elementCount, signalCount })` creates an empty history with an `append(batch)`
method. Optional initial `time` and `values` use signal-major order; appended `RunFrames` use
frame-major order. Float64 time and float32 or float64 values are borrowed, never mutated or
detached after publication. Reads within a retained chunk are strided views; reads across chunks
pack only the requested window.

`Series.state` publishes committed `frameCount`, `timeRange`, and per-signal `ranges` together.
Previous states remain unchanged. A null range array means the extents are unknown; a NaN pair
means that signal has no finite samples. Optional sorted `elements` maps stored columns to class
indices. `on('append', listener)` returns an unsubscribe function.

A disk store or remote recording implements the same `Results` interface:

```ts
import type { Results } from '@latkit/model';

const results: Results = {
  id: resultId,
  series: (classId, signal) => store.series(classId, signal),
  read: (classId, signals, signal) => store.batches(classId, signals, signal),
};
const series = await results.series('bus');
const block = await series.read(
  0,
  {
    frameOffset: 10,
    frameCount: 20,
    elementOffset: 0,
    elementCount: Math.min(4, series.elementCount),
  },
  signal,
);
const first = block.values[0];
const next = block.values[block.stride];
```

Only request committed frames. Returned arrays are borrowed and immutable. A transport copies
them before transfer. `locate([from, to], frameCount)` returns the half-open frame interval
containing every timestamp in that inclusive range, including duplicates, within the captured
head. `Results.read` emits batches with signals in requested order; null selects all signals.
`collect` accepts arrays or async iterables and retains their batches without a full transpose.

## Move a model

```ts
import { openModel, sourceOf } from '@latkit/model';

// pack, for example when staging a library at build time
const source = sourceOf(model);
await write('core.bin', await source.core());
for (const cls of model.classes) await write(`${cls.id}.bin`, await source.class(cls.id));

// unpack, classes still lazy
const opened = await openModel(
  { core: fetchCore, class: fetchShard, bytes: fetchCase },
  { signal, progress: (loaded, total) => bar.set(loaded / total) },
);
```

The pack format is versioned and private: a small JSON directory followed by 8-byte-aligned typed
sections, so unpacking is a set of typed-array views into the received buffer.
