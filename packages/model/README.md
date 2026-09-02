# @latkit/model

The immutable, columnar description of a network and its element classes that a vendor produces
once and every latkit renderer and view consumes directly, plus the byte form that lets it cross a
process boundary lazily.

Six nouns:

| Noun      | What it is                                                                                    |
| --------- | --------------------------------------------------------------------------------------------- |
| `Model`   | A value: topology, owners, element classes, and one lazy, cached loader for class columns     |
| `Field`   | One quantity of a class a host binds or plots: a numeric column or a recorded signal          |
| `Series`  | Packed signals over one element axis and time, shaped exactly as `@latkit/monitor` loads them |
| A run     | What any engine emits: `RunUpdate`s whose frames `collect` into a `Series`                    |
| `Results` | What a run leaves behind: its recorded samples, read back class by class as those batches     |
| `Source`  | The same model as bytes: one core plus one shard per class, owned by whoever asks             |

`Topology` and `Item` are field-for-field the shapes `@latkit/network` loads and picks, so a model
never adapts for a renderer. The package has no dependencies, no state machines, no I/O, and no
rendering.

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
import { createGrid, elementAt, itemOf } from '@latkit/model';

network.load(model.topology);

const bus = await model.load('bus');
const vm = bus.columns.find((column) => column.id === 'Vm');
if (vm?.kind === 'number') network.setChannel('vertexColor', Float32Array.from(vm.values));

network.on('pick', (item) => {
  const ref = elementAt(model, item);
  if (ref) console.log(bus.labels[ref.index]);
});

const grid = createGrid(bus.labels, bus.columns);
const { rows, total } = await grid.window('north', { column: 'Vm', dir: 'desc' }, 0, 50);
```

## Name what a host shows

A `Field` is one quantity of a class: a numeric column, or a signal the class records. `fieldsOf`
lists them in a stable order, columns first and then recorded signals in the order a `Series` packs
them, and `fieldKey` keys a reference. A binding picker, a plot lane, and an inspector row all speak
in fields, never in columns or arrays.

```ts
import { fieldKey, fieldsOf } from '@latkit/model';

const bus = model.classes.find((cls) => cls.id === 'bus')!;
const fields = fieldsOf(bus, await model.load('bus'), results.get('bus'));
const bound = new Map(fields.map((field) => [fieldKey(field), field]));
```

## Run a model

Running is held by whoever has an engine, never by the model. A `Runner` streams `RunUpdate`s; the
frames for one class `collect` into a `Series` the monitor loads unchanged.

```ts
import { collect, frameAt, sample, type RunFrames } from '@latkit/model';

const frames: RunFrames[] = [];
for await (const update of runner.run(command, signal)) {
  if (update.type === 'frames' && update.classId === 'bus') frames.push(update);
}
const series = collect(frames);
monitor.load(series);
network.setChannel('vertexColor', sample(series, 0, frameAt(series.time, t)));
```

## Read what a run recorded

Whoever keeps a run's samples, a store on disk, a file the solver wrote, series held in memory,
exposes them as `Results`: one class's batches in frame order, the same `RunFrames` the run
streamed. `collect` folds a stream of them too, filling a preallocated series when the frame count
is known.

```ts
import { collect, type Results } from '@latkit/model';

const results: Results = {
  read: (classId, signals, signal) => store.batches(classId, signals, signal),
};
const vm = await collect(results.read('bus', [0], signal), frames);
```

A read selects signals by recorded-order index; `null` reads every recorded signal. The format
behind a `Results` is its own business, so a viewer written against one never learns what it was.

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
