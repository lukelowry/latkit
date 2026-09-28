import { Engine, Model, type Recording } from '../src/index.js';

/** Three vertices in a line with two edges, buses owning vertices, branches owning edges, two
 *  generators anchored to vertices 0 and 2, and one area with no place on the canvas. Buses record
 *  their voltage and generators their power. */
export function sampleData(): Model.Description {
  return {
    format: 'test',
    id: 'sample',
    name: 'Sample',
    meta: { freqBase: 60, note: 'fixture', live: true, empty: null },
    topology: {
      vertexCount: 3,
      vertexCoords: Float32Array.of(-96, 30, -95, 31, -94, 30),
      coordinateSpace: 'geographic',
      edges: Uint32Array.of(0, 1, 1, 2),
      polylineStart: Uint32Array.of(0, 0, 1),
      polylinePoints: Float32Array.of(-94.5, 30.5),
    },
    owners: { vertex: 'bus', edge: 'branch' },
    classes: [
      {
        id: 'bus',
        label: 'Bus',
        count: 3,
        columns: [
          { kind: 'number', id: 'Vm', label: 'Voltage', unit: 'pu' },
          { kind: 'text', id: 'zone', label: 'Zone', group: 'Location' },
          { kind: 'flag', id: 'slack', label: 'Slack' },
        ],
        signals: [
          { id: 'Vm', label: 'Voltage', unit: 'pu', recorded: true },
          { id: 'Va', label: 'Angle', unit: 'deg', recorded: false },
        ],
      },
      {
        id: 'branch',
        label: 'Branch',
        count: 2,
        columns: [{ kind: 'flag', id: 'xfmr', label: 'Transformer' }],
        signals: [],
      },
      {
        id: 'gen',
        label: 'Generator',
        count: 2,
        anchor: { kind: 'vertex', index: Uint32Array.of(0, 2) },
        columns: [],
        signals: [{ id: 'P', label: 'Power', unit: 'MW', recorded: true }],
      },
      { id: 'area', label: 'Area', count: 1, columns: [], signals: [] },
    ],
  };
}

/** One class's data as the model joins it: its labels and declared columns with their values. */
export function sampleClass(id: string): Model.Data {
  switch (id) {
    case 'bus':
      return {
        labels: ['North', 'Middle', 'South'],
        columns: [
          {
            kind: 'number',
            id: 'Vm',
            label: 'Voltage',
            unit: 'pu',
            values: Float64Array.of(1.02, NaN, 0.98),
          },
          { kind: 'text', id: 'zone', label: 'Zone', group: 'Location', values: ['A', null, 'B'] },
          { kind: 'flag', id: 'slack', label: 'Slack', values: Uint8Array.of(1, 0, 0) },
        ],
      };
    case 'branch':
      return {
        labels: ['North-Middle', 'Middle-South'],
        columns: [{ kind: 'flag', id: 'xfmr', label: 'Transformer', values: Uint8Array.of(0, 1) }],
      };
    case 'gen':
      return { labels: ['G1', 'G2'], columns: [] };
    case 'area':
      return { labels: ['Texas'], columns: [] };
    default:
      throw new Error(`no fixture class '${id}'`);
  }
}

/** One class's values as a format gives them: labels and values in declared order. */
export function sampleValues(id: string): Model.Values {
  const data = sampleClass(id);
  return { labels: data.labels, values: data.columns.map((column) => column.values) };
}

/**
 * The fixture as a model, recording every class it is asked for; `values` replaces how it gives
 * a class's values.
 */
export class Sample extends Model {
  readonly calls: string[];
  readonly #values: (classId: string, signal: AbortSignal) => Promise<Model.Values>;

  constructor(
    options: {
      readonly calls?: string[];
      readonly description?: Model.Description;
      readonly values?: (classId: string, signal: AbortSignal) => Promise<Model.Values>;
    } = {},
  ) {
    super(options.description ?? sampleData());
    this.calls = options.calls ?? [];
    this.#values = options.values ?? ((classId) => Promise.resolve(sampleValues(classId)));
  }

  protected values(classId: string, signal: AbortSignal): Promise<Model.Values> {
    this.calls.push(classId);
    return this.#values(classId, signal);
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode('{"case":"sample"}'));
  }
}

export function sampleModel(calls?: string[]): Sample {
  return new Sample({ calls });
}

/** One block of frames an engine appends: its times, and each class's values frame-major. */
export interface Block {
  readonly time: Float64Array;
  readonly values: Readonly<Record<string, Float32Array | Float64Array>>;
}

/**
 * An engine that appends `blocks` in turn, a microtask apart, for an input that is a number: how
 * many of them to append before it throws `failure`, or all of them.
 */
export class Player extends Engine {
  readonly #blocks: readonly Block[];
  readonly #failure: string | null;

  constructor(
    blocks: readonly Block[],
    options: { readonly concurrency?: number; readonly failure?: string } = {},
  ) {
    super({ concurrency: options.concurrency ?? 1 });
    this.#blocks = blocks;
    this.#failure = options.failure ?? null;
  }

  protected parse(input: unknown): number {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0)
      throw new TypeError('an input is how many blocks to append');
    return input;
  }

  protected async execute(_model: Model, count: number, recorder: Engine.Recorder): Promise<void> {
    recorder.declare({ span: [0, 10], expectedFrames: this.#blocks.length });
    for (const { time, values } of this.#blocks.slice(0, count)) {
      await recorder.ready;
      recorder.signal.throwIfAborted();
      recorder.append(time, values);
    }
    if (this.#failure !== null && count < this.#blocks.length) throw new Error(this.#failure);
    recorder.log('info', `appended ${count}`);
  }
}

/** A recording an engine keeps open by hand: its recorder, and what ends it. */
interface Open {
  readonly recorder: Engine.Recorder;
  resolve(): void;
  reject(error: Error): void;
}

/** An engine a test drives by hand: every recording it makes stays open until the test ends it. */
class Hand extends Engine {
  readonly #open: Open[] = [];

  constructor() {
    super({ concurrency: Infinity });
  }

  /** The recorder of the recording it made last, and how the test ends it. */
  get last(): Open {
    return this.#open.at(-1)!;
  }

  protected parse(input: unknown): unknown {
    return input;
  }

  protected execute(_model: Model, _input: unknown, recorder: Engine.Recorder): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#open.push({ recorder, resolve, reject });
      recorder.signal.addEventListener('abort', () => reject(new Error('stopped')));
    });
  }
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
  fail(message: string): Promise<void>;
} {
  const hand = new Hand();
  model.engine = hand;
  const recording = model.record(null, header);
  const { recorder, resolve, reject } = hand.last;
  return {
    recording,
    recorder,
    complete() {
      resolve();
      return ended(recording);
    },
    fail(message) {
      reject(new Error(message));
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

/** Frame-major values for `frames` frames of a class: one signal per element, in order. */
export function block(time: readonly number[], values: Record<string, readonly number[]>): Block {
  return {
    time: Float64Array.from(time),
    values: Object.fromEntries(
      Object.entries(values).map(([classId, list]) => [classId, Float32Array.from(list)]),
    ),
  };
}
