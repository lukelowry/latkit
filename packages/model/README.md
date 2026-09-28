# @latkit/model

What a format, an engine, and an editor implement, and what they make. A native format opens or
creates a `Document` through `Document.Format`. The document owns editing and produces immutable
`Model` snapshots on demand; an `Engine` records a model, a `Recording` holds its results, and a
`Series` is what every view follows. It has no dependencies, I/O, or rendering.

| Class       | What it is                                                                               |
| ----------- | ---------------------------------------------------------------------------------------- |
| `Model`     | An immutable case snapshot: topology, element classes, values loaded on demand           |
| `Engine`    | What records any model it is given: a solver, a simulator, an analysis, a feed           |
| `Document`  | A native case open for editing: current bytes, history, schematic, and model snapshots   |
| `Recording` | Every signal an engine records for a model, each class's series on one clock             |
| `Series`    | A history a view follows: signals over time for an element axis, read in bounded windows |

Every other type lives under the class that speaks it: `Model.Topology` and `Model.Item` are the
shapes `@latkit/network` loads and picks, as `Document.Netlist` and `Document.Part` are for
`@latkit/diagram`; `Engine.Recorder` is how an engine writes; `Document.Operation` is one edit.
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

## Register a native format

A host registers native formats through `Document.Format`. Both `open` and optional `create`
return a document, ready to edit or save without building a model. The id matches `model.format`;
filename extensions include the dot, preferred first.

```ts
import { Document } from '@latkit/model';

const gridkit: Document.Format = {
  id: 'gridkit',
  label: 'GridKit',
  extensions: ['.case.json'],
  async open(bytes, signal) {
    signal?.throwIfAborted();
    return new GridkitDocument(bytes);
  },
  async create(name, signal) {
    signal?.throwIfAborted();
    return new GridkitDocument(encodeEmptyCase(name));
  },
};

const document = await gridkit.open(bytes);
const model = await document.model(); // First immutable snapshot, built only when requested.
const currentBytes = await document.bytes(); // What the host saves.

if (gridkit.create) {
  const untitled = await gridkit.create('Untitled');
  // The same document API: edit, undo, model, and bytes. No file has been written.
  await saveFile(chosenPath, await untitled.bytes()); // Host-owned I/O.
}
```

`GridkitDocument` is the format's native `Document` subclass. Its constructor calls `super()` and
retains independent native state; its protected `open` captures a `GridkitModel` when requested.
`open` does not modify the caller's bytes, and both factories reject when their signal is aborted.
The name passed to `create` is the case's display name; the host chooses its filename and destination.

Check `format.create` before offering New Case. The host decides which sources allow editing,
retains the document while the case is open, and saves `document.bytes()`. A public read-only catalog
can serve packed models directly through `Model.from` without opening a native document. The same
native format works on a server, in a worker, or in an editor extension; it does not own storage.

## Ask the model

Queries over an immutable case snapshot are methods on its model.

```ts
const model = await document.model();
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
belongs to that snapshot; save the current case through `document.bytes()` instead.

## Record it

An engine subclasses `Engine`: `parse` checks an input from a host or a peer, and `execute` records
the model it is given for one through its recorder, resolving once complete; throwing fails the
recording. One engine records any model, so a host keeps one per solver, whatever cases and
revisions it opens: `record` checks the input at once, and the recording returned waits its turn,
then fills as the engine computes. An engine records as many at once as its `concurrency` allows and
queues the rest, telling each how many wait before it.

```ts
import { Engine, type Model } from '@latkit/model';

export class GridkitEngine extends Engine {
  constructor(readonly server: URL) {
    super({ concurrency: Infinity }); // the server keeps its own queue
  }

  protected parse(input: unknown): Input {
    return checkInput(input);
  }

  protected async execute(model: Model, input: Input, recorder: Engine.Recorder): Promise<void> {
    recorder.declare({ span: [0, input.duration], expectedFrames: framesOf(input) });
    for await (const update of solve(this.server, model, input, recorder.signal)) {
      if (update.kind === 'queued') recorder.wait(update.ahead);
      else if (update.kind === 'running') recorder.start();
      else if (update.kind === 'log') recorder.log(update.level, update.message);
      else {
        await recorder.ready; // go at the pace of whoever reads the frames
        recorder.append(update.time, update.values);
      }
    }
  }
}

const engine = new GridkitEngine(new URL('/api/', location.href));
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
diagram.setChannel('netColor', vm ? vm.gather(document.drivers(vm.ref)) : null);
```

A field resolves to null when there are no values for it. One reference
resolves to one series, so the renderers binding it share its frames, and `domain` is the display
interval over every committed value; a gathered field keeps it, so each view colors a value alike.

## Edit it

A native format opens a `Document` subclass that makes operations true as one change, reverts a
change, and describes its schematic. Its constructor needs no initial model. The base keeps one
history of the last 200 steps, maps the schematic's parts to elements and back, and finds the
element that drives each net. `model()` builds and caches an immutable snapshot on demand; layout
changes keep it, while values or structure changes invalidate it. Concurrent readers share one
open, and a failed open can be retried. Record that model to record the case as it stands.

```ts
const document = await gridkit.open(bytes);
diagram.load(document.schematic.netlist);
diagram.on('move', ({ blocks, positions }) =>
  document.apply({
    kind: 'place',
    elements: Array.from(blocks, (block) => document.schematic.blocks[block]!),
    positions,
  }),
);
document.on('change', async (change) => {
  if (change.scope === 'structure') diagram.load(document.schematic.netlist, { fit: false });
  diagram.setChannel('blockPosition', document.schematic.positions);
  if (change.scope !== 'layout') show(await document.model());
});
undo.onclick = () => document.undo();
```

An edit the case refuses throws `Refusal`, saying why and what it is about, and changes nothing.

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

## Asynchronous editing

`Document.Session` exposes asynchronous apply, undo, redo, inspection, model capture, and native
byte export. `inspect(elementOrKey)` returns current editable values and wiring with their revision,
without opening a model. Submit a retained draft with `apply(version, ...operations)` so the owner
rejects intervening changes; ordinary `apply(...operations)` uses the current cached view.
Its `view` caches the schematic, palette, history metadata, and `{ epoch, revision }` version.
Stale edits reject with `DocumentConflict`; accepted edits resolve after the view includes them.
A `Document.Snapshot` is an immutable model with `close()` to release its resources.

Sessions and local documents share `Document.parts(schematicOrGetter)` for synchronous
`elementAt`, `partOf`, `portAt`, `portOf`, and `drivers` lookups. Native vendor implementations
subclass `Document`, implementing synchronous `inspect(element)` alongside native
editing and identity lookups. See [Document sessions](../../docs/document-sessions.md)
for serving that document through `@latkit/port` and the persistence boundary.
