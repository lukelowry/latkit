import { bench, describe } from 'vitest';

import { Engine, Model, type Recording } from '@latkit/model';

import { connectEngine, connectModel, loopback, serveEngine, serveModel } from '../src/index.js';

const ELEMENTS = 2000;
const SIGNALS = 4;
const BLOCK = 10;
const BLOCKS = 100;

/** Frame-major blocks: `BLOCKS` of `BLOCK` frames of 80k values each. */
const blocks = Array.from({ length: BLOCKS }, (_, b) => {
  const time = Float64Array.from({ length: BLOCK }, (_, f) => b * BLOCK + f);
  const values = new Float32Array(BLOCK * SIGNALS * ELEMENTS);
  for (let i = 0; i < values.length; i++) values[i] = (b * values.length + i) % 1000;
  return { time, values };
});

/** Buses recording four signals. */
class Buses extends Model {
  constructor() {
    super({
      format: 'bench',
      id: 'bench',
      name: 'Bench',
      topology: { vertexCount: 0, edges: new Uint32Array(0), polylineStart: Uint32Array.of(0) },
      classes: [
        {
          id: 'bus',
          label: 'Bus',
          count: ELEMENTS,
          columns: [],
          signals: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, unit: '', recorded: true })),
        },
      ],
    });
  }

  protected values(): Promise<Model.Values> {
    return Promise.resolve({ labels: Array.from({ length: ELEMENTS }, String), values: [] });
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(0));
  }
}

/** Appends every block, awaiting its recorder between them. */
class Replay extends Engine {
  constructor() {
    super({ concurrency: Infinity });
  }

  protected parse(input: unknown): unknown {
    return input;
  }

  protected async execute(
    _model: Model,
    _input: unknown,
    recorder: Engine.Recorder,
  ): Promise<void> {
    for (const { time, values } of blocks) {
      await recorder.ready;
      recorder.append(time, { bus: values });
    }
  }
}

/** Resolves once `recording` has ended. */
function ended(recording: Recording): Promise<void> {
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

// The engine's realm serves the model too, so every recording records it where it lives.
const [modelServer, modelClient] = loopback();
const [engineServer, engineClient] = loopback();
serveModel(modelServer, new Buses());
serveEngine(engineServer, new Replay());
const remote = await connectModel(modelClient);
const engine = connectEngine(engineClient);

describe('port', () => {
  bench('record across a port: 100 blocks of 80k values', async () => {
    await ended(engine.record(remote, null));
  });
});
