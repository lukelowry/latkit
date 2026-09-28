import { Engine, Model, type Recording } from '@latkit/model';

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
 * `parse` checks an input, as a real engine's does.
 */
export class Scripted extends Engine {
  readonly inputs: unknown[] = [];
  readonly models: Model[] = [];
  readonly #script: (recorder: Engine.Recorder, input: unknown, model: Model) => Promise<void>;
  readonly #parse: (input: unknown) => unknown;

  constructor(
    script: (recorder: Engine.Recorder, input: unknown, model: Model) => Promise<void>,
    options: { readonly concurrency?: number; readonly parse?: (input: unknown) => unknown } = {},
  ) {
    super({ concurrency: options.concurrency ?? 1 });
    this.#script = script;
    this.#parse = options.parse ?? ((input) => input);
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

/** One frame over the two buses at 0.5. */
export const FRAMES = { time: Float64Array.of(0.5), values: { bus: Float32Array.of(1, 2) } };

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
