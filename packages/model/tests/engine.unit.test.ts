import { describe, expect, it, vi } from 'vitest';

import { Engine, type Model } from '../src/index.js';
import { block, ended, Player, sampleModel } from './fixture.js';

/** A recorder that notes every call, as a transport's forwarding one would. */
function noting(
  signal = new AbortController().signal,
): Engine.Recorder & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    signal,
    ready: Promise.resolve(),
    declare: (extent) => void calls.push(`declare:${String(extent.expectedFrames)}`),
    wait: (ahead) => void calls.push(`wait:${ahead}`),
    start: () => void calls.push('start'),
    append: (time) => void calls.push(`append:${time.length}`),
    log: (_level, message) => void calls.push(`log:${message}`),
  };
}

const blocks = [block([0], { bus: [1, 2, 3] }), block([1], { bus: [4, 5, 6] })];

describe('engine', () => {
  it('records into a recorder of the caller’s own, parsing the input first', async () => {
    const model = sampleModel();
    const engine = new Player(blocks);
    const recorder = noting();
    await engine.record(model, 2, recorder);
    expect(recorder.calls).toEqual([
      'start',
      'declare:2',
      'append:1',
      'append:1',
      'log:appended 2',
    ]);
    expect(() => engine.record(model, -1, noting())).toThrow(/how many blocks/);
  });

  it('runs as many as its concurrency allows and queues the rest, telling each its place', async () => {
    const model = sampleModel();
    const engine = new Player(blocks, { concurrency: 2 });
    const recorders = [noting(), noting(), noting(), noting()];
    const done = recorders.map((recorder) => engine.record(model, 2, recorder));
    expect(recorders.map((recorder) => recorder.calls[0])).toEqual([
      'start',
      'start',
      'wait:0',
      'wait:1',
    ]);
    await Promise.all(done);
    expect(recorders[3]!.calls.slice(0, 3)).toEqual(['wait:1', 'wait:0', 'start']);
    expect(engine.concurrency).toBe(2);
  });

  it('lets a recording leave the queue when its signal aborts, rejecting with why', async () => {
    const model = sampleModel();
    const engine = new Player(blocks);
    const first = engine.record(model, 2, noting());
    const leaving = new AbortController();
    const second = engine.record(model, 2, noting(leaving.signal));
    const third = noting();
    const last = engine.record(model, 1, third);
    expect(third.calls).toEqual(['wait:1']);
    leaving.abort(new Error('left'));
    expect(third.calls).toEqual(['wait:1', 'wait:0']);
    await expect(second).rejects.toThrow('left');
    await first;
    await last;
    expect(third.calls[2]).toBe('start');
    await expect(engine.record(model, 1, noting(AbortSignal.abort()))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects with what its execute throws, at once or later, and frees its turn', async () => {
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
    await expect(engine.record(model, null, noting())).rejects.toThrow('at once');
    await expect(engine.record(model, null, noting())).rejects.toThrow('at once');
    const failing = new Player(blocks, { failure: 'diverged' });
    await expect(failing.record(model, 1, noting())).rejects.toThrow('diverged');
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

  it('is what a model records with, attached at any time', async () => {
    const model: Model = sampleModel();
    const engine = new Player(blocks);
    const record = vi.spyOn(engine, 'record');
    model.engine = engine;
    const recording = model.record(2, { id: 'fault', label: 'Fault' });
    expect(record).toHaveBeenCalledOnce();
    expect(recording).toMatchObject({ id: 'fault', label: 'Fault', classes: ['bus', 'gen'] });
    await ended(recording);
    expect(recording.state).toMatchObject({ status: 'complete', frameCount: 2 });
    model.engine = null;
    expect(() => model.record(2)).toThrow(/no engine/);
  });
});
