import { describe, expect, it, vi } from 'vitest';

import { Engine, type Recording, type Series } from '../src/index.js';
import { memoryStore } from '../src/series.js';
import { block, ended, Player, sampleModel } from './fixture.js';

/** Each status a recording passes through, with how many waited ahead while it waited. */
function heard(recording: Recording): string[] {
  const said = (): string =>
    recording.state.status === 'waiting'
      ? `waiting:${recording.state.ahead}`
      : recording.state.status;
  const statuses = [said()];
  recording.on('change', () => {
    if (statuses.at(-1) !== said()) statuses.push(said());
  });
  return statuses;
}

const blocks = [block([0], { bus: [1, 2, 3] }), block([1], { bus: [4, 5, 6] })];
const window = { frameOffset: 0, frameCount: 2, elementOffset: 0, elementCount: 3 };

describe('engine', () => {
  it('records into a recording held here, parsing the input first', async () => {
    const model = sampleModel();
    const engine = new Player(blocks);
    const recording = engine.record(model, 2);
    await ended(recording);
    expect(recording.state).toMatchObject({ status: 'complete', frameCount: 2, error: null });
    expect(recording.expectedFrames).toBe(2);
    expect(recording.log).toEqual([{ level: 'info', message: 'appended 2' }]);
    expect(() => engine.record(model, -1)).toThrow(/how many blocks/);
  });

  it('runs as many as its concurrency allows and queues the rest, telling each its place', async () => {
    const model = sampleModel();
    const engine = new Player(blocks, { concurrency: 2 });
    const recordings = [1, 2, 3, 4].map(() => engine.record(model, 2));
    const statuses = recordings.map(heard);
    expect(statuses.map((said) => said[0])).toEqual([
      'recording',
      'recording',
      'waiting:0',
      'waiting:1',
    ]);
    await Promise.all(recordings.map(ended));
    expect(statuses[3]).toEqual(['waiting:1', 'waiting:0', 'recording', 'complete']);
    expect(engine.concurrency).toBe(2);
  });

  it('lets a waiting recording leave the queue when it stops, moving the rest up', async () => {
    const model = sampleModel();
    const engine = new Player(blocks);
    const first = engine.record(model, 2);
    const second = engine.record(model, 2);
    const third = engine.record(model, 1);
    const statuses = heard(third);
    second.stop();
    expect(second.state).toMatchObject({ status: 'stopped', frameCount: 0 });
    expect(statuses).toEqual(['waiting:1', 'waiting:0']);
    await Promise.all([ended(first), ended(third)]);
    expect(third.state).toMatchObject({ status: 'complete', frameCount: 1 });
  });

  it('fails a recording with what its execute throws, at once or later, and frees its turn', async () => {
    class Broken extends Engine {
      constructor() {
        super();
      }
      protected parse(input: unknown): unknown {
        return input;
      }
      protected execute(): Promise<void> {
        throw new Error('at once');
      }
    }
    const model = sampleModel();
    const engine = new Broken();
    const [one, two] = [engine.record(model, null), engine.record(model, null)];
    await Promise.all([ended(one), ended(two)]);
    expect([one.state.error, two.state.error]).toEqual(['at once', 'at once']);
    const failing = new Player(blocks, { failure: 'diverged' });
    const diverged = failing.record(model, 1);
    await ended(diverged);
    expect(diverged.state).toMatchObject({ status: 'failed', error: 'diverged', frameCount: 1 });
  });

  it('keeps each recording’s frames in a store its host gives it, at the store’s pace', async () => {
    let lanes = 0;
    let closed = 0;
    let release!: () => void;
    const stores: Series.Store[] = [];
    const store = (): Series.Store => {
      const kept = memoryStore();
      const made: Series.Store = {
        put: (values) => (lanes++, kept.put(values)),
        get: vi.fn(kept.get),
        get ready() {
          return lanes < 1 ? Promise.resolve() : new Promise<void>((done) => (release = done));
        },
        close: () => (closed++, kept.close()),
      };
      stores.push(made);
      return made;
    };
    const model = sampleModel();
    const recording = new Player(blocks, { store }).record(model, 2);
    await vi.waitFor(() => expect(recording.state.frameCount).toBe(1));
    expect(recording.state.status).toBe('recording');
    release();
    await ended(recording);
    expect(lanes).toBe(2);
    const read = await recording.series('bus')!.read(0, window);
    expect([...read.values]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stores[0]!.get).toHaveBeenCalled();
    recording.close();
    recording.close();
    expect(closed).toBe(1);
    await expect(recording.series('bus')!.read(0, window)).rejects.toThrow('closed');
  });

  it('keeps the last committed frame when a store rejects part of an append', async () => {
    const stored = memoryStore();
    let writes = 0;
    const recording = new Player(
      [
        block([0], { bus: [1, 2, 3], gen: [4, 5] }),
        block([1], { bus: [10, 20, 30], gen: [40, 50] }),
      ],
      {
        store: () => ({
          ...stored,
          put(values) {
            if (++writes === 4) throw new Error('disk full');
            return stored.put(values);
          },
        }),
      },
    ).record(sampleModel(), 2);
    await ended(recording);
    expect(recording.state).toMatchObject({ status: 'failed', error: 'disk full', frameCount: 1 });
    for (const id of ['bus', 'gen']) expect(recording.series(id)!.state.frameCount).toBe(1);
    expect([...recording.series('bus')!.state.ranges!]).toEqual([1, 3]);
    expect([...recording.series('gen')!.state.ranges!]).toEqual([4, 5]);
    recording.close();
  });

  it('refuses a concurrency below one', () => {
    class Idle extends Engine {
      constructor(concurrency: number) {
        super({ concurrency });
      }
      protected parse(input: unknown): unknown {
        return input;
      }
      protected execute(): Promise<void> {
        return Promise.resolve();
      }
    }
    expect(() => new Idle(0)).toThrow(RangeError);
    expect(new Idle(Infinity).concurrency).toBe(Infinity);
  });

  it('records any model it is given, each recording of the model it was given', async () => {
    const engine = new Player(blocks);
    const [first, second] = [sampleModel(), sampleModel()];
    const recording = engine.record(first, 2, { id: 'fault', label: 'Fault' });
    const other = engine.record(second, 1);
    expect(recording).toMatchObject({ id: 'fault', label: 'Fault', classes: ['bus', 'gen'] });
    expect(recording.model).toBe(first);
    expect(other.model).toBe(second);
    expect(other.state).toMatchObject({ status: 'waiting', ahead: 0 });
    await Promise.all([ended(recording), ended(other)]);
    expect(recording.state).toMatchObject({ status: 'complete', frameCount: 2 });
    expect(other.state).toMatchObject({ status: 'complete', frameCount: 1 });
    expect(() => engine.record(first, 'many')).toThrow(/how many blocks/);
  });
});
