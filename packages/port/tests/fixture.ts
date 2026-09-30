import { Document, Engine, Model, Refusal, type Recording, type Series } from '@latkit/model';

/** Let every queued microtask-delivered message land. */
export async function settle(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round++) await Promise.resolve();
}

/**
 * A two-bus, one-line model whose class values load lazily; buses record their voltage. `bytes`
 * and `source` replace what it gives for them.
 */
export class Fixture extends Model {
  readonly #bytes: (() => Promise<Uint8Array>) | null;
  readonly #source: ((own: Model.Source) => Model.Source) | null;

  constructor(
    name = 'Fixture',
    options: {
      readonly bytes?: () => Promise<Uint8Array>;
      readonly source?: (own: Model.Source) => Model.Source;
    } = {},
  ) {
    super({
      format: 'test',
      id: 'fixture',
      name,
      topology: {
        vertexCount: 2,
        edges: Uint32Array.of(0, 1),
        polylineStart: Uint32Array.of(0, 0),
      },
      owners: { vertex: 'bus', edge: 'line' },
      classes: [
        {
          id: 'bus',
          label: 'Bus',
          count: 2,
          columns: [{ kind: 'number', id: 'kv', label: 'kV' }],
          signals: [{ id: 'Vm', label: 'Vm', unit: 'pu', recorded: true }],
        },
        { id: 'line', label: 'Line', count: 1, columns: [], signals: [] },
      ],
    });
    this.#bytes = options.bytes ?? null;
    this.#source = options.source ?? null;
  }

  protected values(id: string): Promise<Model.Values> {
    return Promise.resolve(
      id === 'bus'
        ? { labels: ['Bus 1', 'Bus 2'], values: [Float64Array.of(1, 2)] }
        : { labels: ['Line 1'], values: [] },
    );
  }

  bytes(): Promise<Uint8Array> {
    return this.#bytes?.() ?? Promise.resolve(new TextEncoder().encode(this.name));
  }

  override source(): Model.Source {
    const own = super.source();
    return this.#source ? this.#source(own) : own;
  }
}

/** The fixture. */
export function fixture(name = 'Fixture'): Fixture {
  return new Fixture(name);
}

/**
 * An engine that runs `script` for each recording, noting every model and input it is given;
 * `parse` checks an input, as a real engine's does, `studies` are what it offers, `store` keeps
 * each recording's frames, and `formats`, `cases`, and `idleBytes` are the cases it keeps.
 */
export class Scripted extends Engine {
  readonly inputs: unknown[] = [];
  readonly models: Model[] = [];
  readonly #script: (recorder: Engine.Recorder, input: unknown, model: Model) => Promise<void>;
  readonly #parse: (input: unknown) => unknown;

  constructor(
    script: (recorder: Engine.Recorder, input: unknown, model: Model) => Promise<void>,
    options: {
      readonly concurrency?: number;
      readonly parse?: (input: unknown) => unknown;
      readonly studies?: readonly Engine.Study[];
      readonly store?: () => Series.Store;
      readonly formats?: readonly Document.Format[];
      readonly cases?: Engine.Cases;
      readonly idleBytes?: number;
    } = {},
  ) {
    super({
      concurrency: options.concurrency ?? 1,
      studies: options.studies,
      store: options.store,
      formats: options.formats,
      cases: options.cases,
      idleBytes: options.idleBytes,
    });
    this.#script = script;
    this.#parse = options.parse ?? ((input) => input);
  }

  override offer(study: Engine.Study): () => void {
    return super.offer(study);
  }

  protected parse(input: unknown): unknown {
    return this.#parse(input);
  }

  protected execute(model: Model, input: unknown, recorder: Engine.Recorder): Promise<void> {
    this.inputs.push(input);
    this.models.push(model);
    return this.#script(recorder, input, model);
  }
}

/** Cases kept in memory, each tagged by the write that made it. */
export function memory(initial: Record<string, readonly number[]> = {}) {
  const kept = new Map<string, { readonly bytes: Uint8Array; readonly tag: string }>();
  let writes = 0;
  for (const [name, bytes] of Object.entries(initial))
    kept.set(name, { bytes: Uint8Array.from(bytes), tag: `t${++writes}` });
  const store: Engine.Cases = {
    list: () => Promise.resolve([...kept.keys()]),
    read(name) {
      const entry = kept.get(name);
      if (!entry) return Promise.reject(new Error(`No case ${name}.`));
      return Promise.resolve({ bytes: entry.bytes.slice(), tag: entry.tag });
    },
    write(name, bytes, tag) {
      if ((kept.get(name)?.tag ?? null) !== tag)
        return Promise.reject(new Error(`The case ${name} changed.`));
      const next = `t${++writes}`;
      kept.set(name, { bytes: bytes.slice(), tag: next });
      return Promise.resolve(next);
    },
  };
  return { store, kept, bytes: (name: string) => [...(kept.get(name)?.bytes ?? [])] };
}

/** One frame over the two buses at 0.5. */
export const FRAMES = { time: Float64Array.of(0.5), values: { bus: Float32Array.of(1, 2) } };

/** A store that keeps its lanes in memory and says whether it was closed. */
export function kept(): Series.Store & { closed: boolean } {
  const lanes: (Float32Array | Float64Array)[] = [];
  return {
    closed: false,
    put: (values) => lanes.push(values) - 1,
    get: (lane, { offset, count, rows, stride }) =>
      Promise.resolve({
        values: lanes[lane]!.subarray(offset, offset + (rows - 1) * stride + count),
        stride,
      }),
    close() {
      this.closed = true;
    },
  };
}

/**
 * A recording of `model` a test writes by hand: its recorder, and what ends it, each resolving
 * once the recording says it ended.
 */
export function byHand(
  model: Model,
  header: { readonly id?: string; readonly label?: string } = {},
): {
  readonly recording: Recording;
  readonly recorder: Engine.Recorder;
  complete(): Promise<void>;
} {
  let recorder!: Engine.Recorder;
  let resolve!: () => void;
  const engine = new Scripted(
    (given) =>
      new Promise<void>((done, reject) => {
        recorder = given;
        resolve = done;
        given.signal.addEventListener('abort', () => reject(new Error('stopped')));
      }),
    { concurrency: Infinity },
  );
  const recording = engine.record(model, null, header);
  return {
    recording,
    recorder,
    complete() {
      resolve();
      return ended(recording);
    },
  };
}

/** Resolves once `recording` has ended. */
export function ended(recording: Recording): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (recording.state.status === 'waiting' || recording.state.status === 'recording') return;
      off();
      resolve();
    };
    const off = recording.on('change', check);
    check();
  });
}

interface State {
  readonly value: number;
  readonly count: number;
  readonly positions: Float32Array;
}
interface Step extends Document.Change {
  readonly before: State;
  readonly privateInverse: () => void;
}

/**
 * A case of one number and a row of buses, editable in every way a test needs: `set` changes its
 * value, `insert` adds a bus, `place` pins blocks, and `remove` and `record` are refused. Its steps
 * keep a private inverse, as a vendor's may; `opening` holds a model open until it resolves.
 */
export class Editable extends Document {
  state: State = { value: 0, count: 2, positions: new Float32Array(4).fill(NaN) };
  applied = 0;
  readonly models: Model[] = [];
  opening: Promise<void> | null = null;
  #schematic: Document.Schematic;

  constructor() {
    super();
    this.#schematic = this.describe();
  }
  get schematic(): Document.Schematic {
    return this.#schematic;
  }
  get palette(): readonly Document.BlockClass[] {
    return [{ classId: 'bus', label: 'Bus', group: 'Network', ports: [] }];
  }
  keyOf(element: Model.Element): string | null {
    const { classId, index } = element;
    const count = classId === 'bus' ? this.state.count : classId === 'signal' ? 1 : 0;
    return Number.isInteger(index) && index >= 0 && index < count ? `${classId}/${index}` : null;
  }
  find(key: string): Model.Element | null {
    const [classId, at] = key.split('/');
    const element = { classId, index: Number(at) };
    return this.keyOf(element) === key ? element : null;
  }
  inspect(element: Model.Element): Document.Inspection | null {
    const key = this.keyOf(element);
    if (key === null) return null;
    const net = { element: { classId: 'signal', index: 0 }, key: 'signal/0' };
    return {
      element,
      key,
      values:
        element.classId === 'bus'
          ? { kv: this.state.value, enabled: true, label: 'Bus', limit: null }
          : {},
      ports:
        element.classId === 'bus'
          ? [
              { name: 'voltage', net },
              { name: 'unused', net: null },
            ]
          : [],
      members:
        element.classId === 'signal'
          ? Array.from({ length: this.state.count }, (_, index) => ({
              owner: { element: { classId: 'bus', index }, key: `bus/${index}` },
              port: 'voltage',
            }))
          : [],
    };
  }
  bytes(): Promise<Uint8Array> {
    return Promise.resolve(Uint8Array.of(this.state.value));
  }

  describe(): Document.Schematic {
    return {
      netlist: {
        blockCount: this.state.count,
        portStart: new Uint32Array(this.state.count + 1),
        portFlow: new Uint8Array(),
        netStart: Uint32Array.of(0),
        netPorts: new Uint32Array(),
      },
      blocks: Array.from({ length: this.state.count }, (_, index) => ({ classId: 'bus', index })),
      nets: [],
      sources: [],
      status: new Float32Array(),
      positions: this.state.positions,
      problems: [],
    };
  }
  protected change(operations: readonly Document.Operation[]): Step | null {
    const before = this.state;
    let next = before;
    let scope: Document.Change['scope'] = 'values';
    const created: Model.Element[] = [];
    for (const operation of operations) {
      if (operation.kind === 'remove') throw new Refusal('Keep this bus', operation.elements[0]);
      if (operation.kind === 'record') throw new Refusal('Nothing records here', operation.signal);
      if (operation.kind === 'set') {
        if (typeof operation.value !== 'number')
          throw new Refusal('A number is required', operation.element);
        next = { ...next, value: operation.value };
      } else if (operation.kind === 'insert') {
        created.push({ classId: 'bus', index: next.count });
        next = {
          ...next,
          count: next.count + 1,
          positions: new Float32Array((next.count + 1) * 2).fill(NaN),
        };
        scope = 'structure';
      } else if (operation.kind === 'place') {
        const positions = next.positions.slice();
        operation.elements.forEach((element, i) => {
          positions[element.index * 2] = operation.positions?.[i * 2] ?? NaN;
          positions[element.index * 2 + 1] = operation.positions?.[i * 2 + 1] ?? NaN;
        });
        next = { ...next, positions };
        scope = 'layout';
      }
    }
    if (next === before || (scope === 'values' && next.value === before.value)) return null;
    this.applied++;
    this.state = next;
    this.#schematic =
      scope === 'structure' ? this.describe() : { ...this.#schematic, positions: next.positions };
    return { label: 'Edit', scope, created, before, privateInverse() {} };
  }
  protected revert(change: Document.Change): Step {
    const before = this.state;
    this.state = (change as Step).before;
    this.#schematic = this.describe();
    return { label: 'Undo edit', scope: change.scope, created: [], before, privateInverse() {} };
  }
  protected async open(): Promise<Model> {
    const value = this.state.value;
    await this.opening;
    const model = new Fixture(String(value));
    this.models.push(model);
    return model;
  }
}
/** An edit that sets the first bus to `value`. */
export const set = (value: number): Document.Operation => ({
  kind: 'set',
  element: { classId: 'bus', index: 0 },
  column: 'kv',
  value,
});
