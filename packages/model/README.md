# @latkit/model

What a format, an engine, and an editor implement, and what they make. An `Engine` is a vendor: it
keeps the vendor's cases, opens each as a `Document` through its `Document.Format`, and hands out
`Document.Session`s on them; it records any model into a `Recording`. A document produces
immutable `Model` snapshots on demand, and a `Series` is what every view follows. It has no
dependencies, I/O, or rendering.

| Class       | What it is                                                                               |
| ----------- | ---------------------------------------------------------------------------------------- |
| `Model`     | An immutable case snapshot: topology, element classes, values loaded on demand           |
| `Engine`    | A vendor: keeps its cases, opens them as sessions, and records any model it is given     |
| `Document`  | A native case open for editing: current bytes, history, schematic, and model snapshots   |
| `Recording` | Every signal an engine records for a model, each class's series on one clock             |
| `Series`    | A history a view follows: signals over time for an element axis, read in bounded windows |

Every other type lives under the class that speaks it: `Model.Topology` and `Model.Item` are the
shapes `@latkit/network` loads and picks, as `Document.Netlist` and `Document.Part` are for
`@latkit/diagram`; `Engine.Recorder` is how an engine writes, and `Engine.Cases` where it keeps
its cases; `Document.Session` is how a host edits a case, and `Document.Operation` is one edit.
`Domain` is the `[min, max]` every renderer takes; `extent` scans one and `normalizeDomain` pads one
for display. `validateTopology`, `validateNetlist`, `validateSeries`, and `validateDomain` check
what a host builds before a device exists.

## Implement a model snapshot

A format subclasses `Model` to represent an immutable snapshot produced by a document. It describes
the case to the constructor, which checks it once, and supplies each class's values and the
snapshot's native bytes when asked. Those values and bytes must remain independent of later edits.
Each class declares its columns and signals up front. Owner classes are the ones whose element `i` is vertex `i` or edge `i`; any other class may
anchor each element to a topology item, `0xffffffff` marking an element with no place.

```ts
import { Model } from '@latkit/model';

export class GridkitModel extends Model {
  readonly #case: Parsed;

  constructor(bytes: Uint8Array) {
    const parsed = parse(bytes);
    super({
      format: 'gridkit',
      id: parsed.digest,
      name: parsed.name,
      topology: parsed.topology,
      owners: { vertex: 'bus', edge: 'branch' },
      classes: parsed.classes, // columns and signals declared before any values load
    });
    this.#case = parsed;
  }

  protected values(classId: string): Promise<Model.Values> {
    return Promise.resolve(this.#case.values(classId)); // labels, and values in declared order
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(this.#case.bytes());
  }
}
```

## Keep a vendor's cases

An engine keeps its cases in the formats it opens. A `Document.Format` is how: `open` and optional
`create` return a document, ready to edit without building a model, and keep nothing themselves.
The id matches `model.format`; name extensions include the dot, preferred first. The store is the
host's: bytes by name, each read and written with a tag, so a write replaces only what the engine
last read or wrote. A directory, a bucket, and memory are each one.

```ts
import { Engine, type Document } from '@latkit/model';

const gridkit: Document.Format = {
  id: 'gridkit',
  label: 'GridKit',
  extensions: ['.case.json'],
  async open(bytes, signal) {
    signal?.throwIfAborted();
    return new GridkitDocument(bytes);
  },
  async create(title, signal) {
    signal?.throwIfAborted();
    return new GridkitDocument(encodeEmptyCase(title));
  },
};

class GridkitEngine extends Engine {
  constructor(cases: Engine.Cases) {
    super({ concurrency: 4, studies: STUDIES, formats: [gridkit], cases });
  }
  // parse and execute, as below
}

const engine = new GridkitEngine(directory); // the host's store
await engine.cases(); // [{ name: 'ieee39.case.json', format: 'gridkit', saved: null }, ...]
const session = await engine.open('ieee39.case.json'); // one document per case, for every session
const created = await engine.create('new.case.json', { title: 'Untitled' }); // kept at once
const imported = await engine.create('copy.case.json', { file }); // a user's file, as gridkit opens it
await engine.save('ieee39.case.json', session.view.version); // exactly that version
```

`GridkitDocument` is the format's native `Document` subclass. Its constructor calls `super()` and
retains independent native state; its protected `open` captures a `GridkitModel` when requested.
`open` does not modify the caller's bytes, and both factories reject when their signal is aborted.
The title passed to `create` is the case's display name; its name among the engine's cases is the
host's choice. Check `engine.formats[i].creates` before offering New Case.

Every session on a case shares the one document the engine holds for it. A document with unsaved
edits stays open until it is saved; clean ones no session uses stay open while their bytes fit the
engine's `idleBytes` budget, so reopening a case is instant. `engine.cases()` reports the version
each open document last saved. A public read-only catalog can serve packed models directly through
`Model.from` without an engine.

## Ask the model

Queries over an immutable case snapshot are methods on its model.

```ts
const model = await session.model();
network.load(model.topology);
network.on('select', (item) => {
  const element = item && model.elementAt(item); // the element a pick is
  if (element) inspect(element);
});
model.itemOf({ classId: 'gen', index: 2 }); // where it sits: { kind: 'vertex', index: 7 }

const bus = await model.load('bus'); // labels and columns, loaded once and shared
const grid = await model.grid('bus'); // the class as a table
const { rows, total } = await grid.window('north', { column: 0, dir: 'desc' }, 0, 50);
```

A grid's `columns` say what each cell shows: the class's columns, and in a recording's grid every
signal it records, at a time. A sort names a column by its index there, or `null` for the label.
`formatNumber` is the rule its cells follow, for any number shown beside them. A model is immutable:
views and recordings can keep a snapshot while its document continues editing. `model.bytes()`
belongs to that snapshot; keep the current case with `engine.save` instead.

## Record it

An engine subclasses `Engine`: `parse` checks an input from a host or a peer, and `execute` records
the model it is given for one through its recorder, resolving once complete; throwing fails the
recording. One engine records any model, so a host keeps one per solver, whatever cases and
revisions it opens: `record` checks the input at once, and the recording returned waits its turn,
then fills as the engine computes. An engine records as many at once as its `concurrency` allows and
queues the rest, telling each how many wait before it. Each recording keeps its frames in the
`store` its host gives the engine, in memory unless the host keeps them elsewhere, such as on disk,
and `recording.close()` lets them go.

```ts
import { Engine, type Model } from '@latkit/model';

export class GridkitEngine extends Engine {
  constructor(readonly solver: Solver) {
    super({ concurrency: 4 }); // solvers it runs at once; the rest wait their turn
  }

  protected parse(input: unknown): Input {
    return checkInput(input);
  }

  protected async execute(model: Model, input: Input, recorder: Engine.Recorder): Promise<void> {
    recorder.declare({ span: [0, input.duration], expectedFrames: framesOf(input) });
    for await (const update of this.solver.run(model, input, recorder.signal)) {
      if (update.kind === 'log') recorder.log(update.level, update.message);
      else {
        await recorder.ready; // go at the pace of the store that keeps the frames
        recorder.append(update.time, update.values);
      }
    }
  }
}

const engine = new GridkitEngine(solver);
const recording = engine.record(model, input, { label: 'Fault at bus 5' });
recording.on('change', () => status.show(recording.state)); // waiting, recording, then how it ended
stop.onclick = () => recording.stop();
```

`append(time, values)` commits frames for every recorded class at once, a class it leaves out
reading NaN over them; a class's values are frame-major, `(frame * signals + signal) * elements +
element`, signals in the order its class declares them. The recorder takes the buffers.
`recording.state` publishes `status`, `ahead`, `frameCount`, `timeRange`, and `error` together;
`span`, `expectedFrames`, and `log` are what the engine declared and said; `frameAt(time)` and
`timeAt(frame)` read the clock. `recording.model` is the model it records, whatever becomes of the
case since, so its results never attach to another revision.

## Offer studies

An engine describes what a host may record as studies: plain data any frontend lists and draws as
forms, each a label and its parameters by kind (`number`, `text`, `flag`, `choice`, `element`, or
`file`), some in groups a switch turns on and off. Once it offers a study, an engine records only
an input that names one: `record` checks its values against the form before `parse` sees them,
throwing a `Refusal` at the parameter to fix, and `shown` and `problems` answer a form as the user
types, on either side of a port.

```ts
const SIMULATION: Engine.Study = {
  id: 'dynamic-simulation',
  label: 'Dynamic Simulation',
  formats: ['gridkit'],
  groups: [{ id: 'fault', label: 'Fault', switch: 'off' }],
  parameters: [
    { id: 'tmax', kind: 'number', label: 'End time', unit: 's', above: 0, default: 10 },
    { id: 'bus', group: 'fault', kind: 'element', classId: 'bus', label: 'Bus' },
  ],
};

super({ concurrency: Infinity, studies: [SIMULATION] }); // `offer` adds one later

const input = { study: 'dynamic-simulation', values: { fault: true, bus } };
engine.shown(input); // tmax, then bus
engine.problems(model, input); // {} when it records as it stands
engine.record(model, input); // labelled 'Dynamic Simulation'
```

`parse` gets each shown parameter's value, null for one left empty, and each switch's position. A
parameter marked `each` takes several values in a form, and a host records once for each.

## Bind a field

A field is one number column or one recorded signal, resolved to the `{ series, signal }` every
renderer binds: a column's series is sealed with one frame, which holds at every time. A model
resolves its columns, and a recording its signals and its model's columns; `fields` lists what a
class can bind, and a `Model.FieldRef` is the plain data a host persists.

```ts
const vm = await recording.field({ classId: 'bus', kind: 'signal', id: 'Vm' });
network.setChannel('vertexColor', vm); // frames stay on the GPU; the domain follows; null unbinds
monitor.load(vm);
network.seek(t);
const values = await vm?.at(t); // every bus at t, NaN where one has no value

// The same field over other items: a diagram's nets over the elements that drive them.
diagram.setChannel('netColor', vm ? vm.gather(session.drivers(vm.ref)) : null);
```

A field resolves to null when there are no values for it. One reference
resolves to one series, so the renderers binding it share its frames, and `domain` is the display
interval over every committed value; a gathered field keeps it, so each view colors a value alike.

## Edit it

A host edits a case through a `Document.Session`, whether the engine is in its realm or across a
port: asynchronous apply, undo, redo, inspection, model capture, and native byte export, every call
in the one queue of the document it is on. Its `view` holds the schematic, palette, history
metadata, `{ epoch, revision }` version, the document's own `document.version`, and `saved`, the
version its engine last kept, which `on('saved')` hears change whichever session saved; schematic
lookups (`elementAt`, `partOf`, `portAt`, `portOf`, `drivers`) are local and synchronous.

```ts
const session = await engine.open('ieee39.case.json');
diagram.load(session.view.schematic.netlist);
diagram.on('move', ({ blocks, positions }) =>
  session.apply({
    kind: 'place',
    elements: Array.from(blocks, (block) => session.view.schematic.blocks[block]!),
    positions,
  }),
);
session.on('change', async (change) => {
  const { schematic } = session.view;
  if (change.scope === 'structure') diagram.load(schematic.netlist, { fit: false });
  diagram.setChannel('blockPosition', schematic.positions);
  if (change.scope !== 'layout') show(await session.model());
});
undo.onclick = () => session.undo();
```

An edit uses an explicit base or the view's version at invocation. One the case refuses rejects
with `Refusal`, saying why and what it is about, and changes nothing; one made against a revision
gone by rejects with `DocumentConflict`, and never silently rebases. `inspect(elementOrKey)`
returns current editable values and wiring with their revision, without opening a model; submit a
retained draft with `apply(version, ...operations)`. `model()` captures an immutable snapshot,
shared by concurrent readers; layout changes keep it, while values or structure changes invalidate
it. Close a model once its readers finish, and `session.close()` once the case is no longer
wanted. Record the model to record the case as it stands.

A native format subclasses `Document`: it makes operations true as one change, reverts a change,
describes its schematic, and implements synchronous `inspect(element)` alongside its identity
lookups. Its constructor needs no initial model. The base keeps one history of the last 200 steps,
maps the schematic's parts to elements and back, and finds the element that drives each net.
`document.version` advances for each successful edit, undo, and redo. Document implementations
replace changed schematic parts and retain unchanged parts by identity; published parts must not
be mutated. Keep the same palette array until the palette changes, so sessions send only the parts
that changed. See [Document sessions](../../docs/document-sessions.md) for what an engine keeps
open, ordering, and the wire contract.

## Keep a history

`Series.create` is an in-memory history for samples that are not a recording of a model. Initial
`time` and `values` are signal-major; appends are frame-major. Buffers are taken, never mutated or
detached after publication, and reads within one append are zero-copy views. A source of samples
held anywhere else subclasses `Series`: it publishes what it holds and fetches checked windows.

```ts
import { Series } from '@latkit/model';

const series = Series.create({ signals: ['temperature'], elementCount: 3 });
series.append({ time: Float64Array.of(0), values: Float32Array.of(21, 22, 23) });
monitor.load({ series, signal: 0 });
series.seal(); // no frame follows
```

`read(signal, window)` borrows a bounded, strided window, and `locate([from, to], frameCount)`
returns the half-open frame interval holding those times within a captured head. `state.ranges`
holds each signal's finite extent, a NaN pair while it has none.

## Move a case or a recording

Everything lazy opens from a source. A model's `Model.Source` is its core and one shard per class,
packed on demand, and its bytes; a `Recording.Source` is a recording's classes, its changes as it
grows, and sample windows on demand. `source()` makes one from the instance, and `Model.from` and
`Recording.from` open one from anywhere: a file, a fetch, or `@latkit/port`, which serves exactly
these across a port. A recording opens against the model it records, which checks it fits; a model
opened from packs serves them again as they came, so a relay decodes nothing.

```ts
// pack, for example when staging a library at build time
const source = model.source();
await write('core.bin', await source.core());
for (const spec of model.classes) await write(`${spec.id}.bin`, await source.class(spec.id));

// unpack, classes still lazy
const opened = await Model.from(
  { core: fetchCore, class: fetchShard, bytes: fetchCase },
  { signal, progress: (loaded, total) => bar.set(loaded / total) },
);
```

The pack format is private: a small JSON directory, the core's declaring every class's columns and
signals, followed by 8-byte-aligned typed sections, so unpacking is a set of typed-array views into
the received buffer. A series held elsewhere reads it in windows of at most 1 MiB, however large
the window asked for.

## Describe a diagram

A `Document.Netlist` is a block diagram's structure as columns: blocks, the ports each block owns
(`portStart` offsets), and the nets that join ports (`netStart` offsets into `netPorts`). A net has
at most one `out` port, its driver, and a port joins at most one net. Placement is not structure;
`blockKey` keeps each block's position, placement, and selection across reloads.

```ts
import { validateNetlist, type Document } from '@latkit/model';

// TGOV1 drives pmech, IEEET1 drives efd, GENROU's speed feeds both back.
const unit: Document.Netlist = {
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
