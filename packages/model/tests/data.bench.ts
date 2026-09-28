import { bench, describe } from 'vitest';

import { Engine, Model, type Recording } from '../src/index.js';

const ELEMENTS = 2000;
const SIGNALS = 4;
const BLOCK = 10;
const BLOCKS = 100;
const LARGE = 300_000;

/** Frame-major blocks: `BLOCKS` of `BLOCK` frames, every value distinct. */
const blocks = Array.from({ length: BLOCKS }, (_, b) => {
  const time = Float64Array.from({ length: BLOCK }, (_, f) => b * BLOCK + f);
  const values = new Float32Array(BLOCK * SIGNALS * ELEMENTS);
  for (let i = 0; i < values.length; i++) values[i] = (b * values.length + i) % 1000;
  return { time, values };
});
/** The same frames one per block: a clock of many chunks. */
const single = Array.from({ length: BLOCKS * BLOCK }, (_, f) => ({
  time: Float64Array.of(f),
  values: new Float32Array(SIGNALS * ELEMENTS).fill(f % 7),
}));
const largeColumn = Float64Array.from({ length: LARGE }, (_, i) => i % 97);

/** Buses recording four signals, and meters with one large column. */
class Bench extends Model {
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
          columns: [{ kind: 'number', id: 'kv', label: 'kV' }],
          signals: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, unit: '', recorded: true })),
        },
        {
          id: 'meter',
          label: 'Meter',
          count: LARGE,
          columns: [{ kind: 'number', id: 'x', label: 'X' }],
          signals: [],
        },
      ],
    });
  }

  protected values(classId: string): Promise<Model.Values> {
    return Promise.resolve(
      classId === 'bus'
        ? {
            labels: Array.from({ length: ELEMENTS }, String),
            values: [Float64Array.from({ length: ELEMENTS }, (_, i) => i)],
          }
        : { labels: Array.from({ length: LARGE }, String), values: [largeColumn] },
    );
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(0));
  }
}

/** Appends the blocks its input names, awaiting its recorder between them when `paced`. */
class Replay extends Engine {
  constructor() {
    super({ concurrency: Infinity });
  }

  protected parse(input: unknown): { readonly frames: typeof blocks; readonly paced: boolean } {
    return input as { readonly frames: typeof blocks; readonly paced: boolean };
  }

  protected async execute(
    _model: Model,
    input: { readonly frames: typeof blocks; readonly paced: boolean },
    recorder: Engine.Recorder,
  ): Promise<void> {
    for (const { time, values } of input.frames) {
      if (input.paced) await recorder.ready;
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

const model = new Bench();
const engine = new Replay();
const sealed = engine.record(model, { frames: blocks, paced: false });
const chunky = engine.record(model, { frames: single, paced: false });
await Promise.all([ended(sealed), ended(chunky)]);
const bus = (await sealed.field({ classId: 'bus', kind: 'signal', id: 'b' }))!;
const meter = (await model.field({ classId: 'meter', kind: 'column', id: 'x' }))!;

describe('model data plane', () => {
  bench('append 1000 frames of 2000 elements x 4 signals in 100 blocks', async () => {
    await ended(engine.record(model, { frames: blocks, paced: false }));
  });

  bench('read one block of one signal: 10 frames x 2000 elements', async () => {
    await bus.series.read(1, {
      frameOffset: 20,
      frameCount: 10,
      elementOffset: 0,
      elementCount: ELEMENTS,
    });
  });

  bench('read across 13 blocks: 128 frames x 2000 elements', async () => {
    await bus.series.read(1, {
      frameOffset: 0,
      frameCount: 128,
      elementOffset: 0,
      elementCount: ELEMENTS,
    });
  });

  bench('field at a time: 2000 elements', async () => {
    await bus.at(555);
  });

  bench('column field at a time: 300k elements', async () => {
    await meter.at(0);
  });

  bench('grid at a time: 2000 elements, a column and 4 signals', async () => {
    const grid = await sealed.grid('bus', 555);
    await grid.window('', null, 0, 50);
    grid.dispose();
  });

  bench('source: first change of 1000 frames in 1000 chunks', async () => {
    const changes = chunky.source().changes()[Symbol.asyncIterator]();
    await changes.next();
    await changes.return?.();
  });

  bench('record through the engine: 100 blocks', async () => {
    await ended(engine.record(model, { frames: blocks, paced: true }));
  });

  bench('gather 500 of 2000 elements and read 128 frames of them', async () => {
    const picked = bus.gather(Uint32Array.from({ length: 500 }, (_, i) => (i * 4) % ELEMENTS));
    await picked.series.read(0, {
      frameOffset: 0,
      frameCount: 128,
      elementOffset: 0,
      elementCount: 500,
    });
  });
});
