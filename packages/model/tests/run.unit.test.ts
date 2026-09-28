import { describe, expect, it, vi } from 'vitest';

import { createModel, openModel, type RunUpdate } from '../src/index.js';
import { sampleData, sampleLoader } from './fixture.js';

/** Frames at `time`, buses recording Vm over their three elements. */
const frames = (time: number[], values: number[]): RunUpdate => ({
  type: 'frames',
  time: Float64Array.from(time),
  values: { bus: Float32Array.from(values) },
});

/** A model whose engine yields `updates` and records what it is asked. */
function runnable(updates: RunUpdate[], seen: { signal?: AbortSignal; command?: string } = {}) {
  return createModel({
    ...sampleData(),
    ...sampleLoader(),
    async *run(command: string, signal: AbortSignal) {
      seen.command = command;
      seen.signal = signal;
      for (const update of updates) {
        await Promise.resolve();
        if (signal.aborted) return;
        yield update;
      }
    },
  });
}

async function drain(run: AsyncIterable<RunUpdate>): Promise<RunUpdate['type'][]> {
  const types: RunUpdate['type'][] = [];
  for await (const update of run) types.push(update.type);
  return types;
}

describe('model.run', () => {
  it('fills the recording it returns as frames arrive, and seals it at the end', async () => {
    const seen: { command?: string } = {};
    const model = runnable(
      [{ type: 'running' }, frames([0, 1], [1, 2, 3, 4, 5, 6]), { type: 'done' }],
      seen,
    );
    const run = model.run!('study', { id: 'fault', span: [0, 20] });
    expect(run.recording).toMatchObject({ id: 'fault', span: [0, 20], classes: ['bus', 'gen'] });
    expect(run.recording.state.live).toBe(true);
    const counts: number[] = [];
    for await (const update of run) {
      counts.push(run.recording.state.frameCount);
      if (update.type === 'done') expect(run.recording.state.live).toBe(true);
    }
    expect(seen.command).toBe('study');
    expect(counts).toEqual([0, 2, 2]);
    expect(run.recording.state).toMatchObject({ frameCount: 2, live: false });
  });

  it('starts nothing until iterated, and iterates once', async () => {
    const seen: { command?: string } = {};
    const model = runnable([{ type: 'done' }], seen);
    const run = model.run!('study', { id: 'fault' });
    expect(seen.command).toBeUndefined();
    expect(await drain(run)).toEqual(['done']);
    await expect(drain(run)).rejects.toThrow('a run iterates once');
  });

  it('stops the engine and seals the recording when the loop leaves early', async () => {
    const seen: { signal?: AbortSignal } = {};
    const model = runnable(
      [{ type: 'running' }, { type: 'log', level: 'info', message: 'x' }],
      seen,
    );
    const run = model.run!('study', { id: 'fault' });
    for await (const update of run) if (update.type === 'running') break;
    expect(seen.signal!.aborted).toBe(true);
    expect(run.recording.state.live).toBe(false);
  });

  it('ends a run its signal aborted as cancelled when the engine says nothing more', async () => {
    const controller = new AbortController();
    const model = runnable([{ type: 'running' }, { type: 'running' }]);
    const run = model.run!('study', { id: 'fault', signal: controller.signal });
    const types: RunUpdate['type'][] = [];
    for await (const update of run) {
      types.push(update.type);
      controller.abort();
    }
    expect(types).toEqual(['running', 'cancelled']);
    expect(run.recording.state.live).toBe(false);
  });

  it('refuses an engine that ends without saying how', async () => {
    const model = runnable([{ type: 'running' }]);
    await expect(drain(model.run!('study', { id: 'fault' }))).rejects.toThrow(
      'the run ended without a done, cancelled, or failed update',
    );
  });

  it('stops at the end an engine reports, and throws a block that does not fit', async () => {
    const model = runnable([{ type: 'failed', message: 'diverged' }, { type: 'running' }]);
    expect(await drain(model.run!('study', { id: 'fault' }))).toEqual(['failed']);
    const broken = runnable([frames([0], [1, 2])]);
    await expect(drain(broken.run!('study', { id: 'fault' }))).rejects.toThrow(RangeError);
  });

  it('checks the header before anything runs', () => {
    const model = runnable([{ type: 'done' }]);
    expect(() => model.run!('study', { id: '' })).toThrow('recording id must be non-empty');
  });

  it('has no run without an engine', () => {
    const model = createModel({ ...sampleData(), ...sampleLoader() });
    expect(model.run).toBeUndefined();
    expect(model.source().run).toBeUndefined();
    expect(() => createModel({ ...sampleData(), ...sampleLoader(), run: 1 as never })).toThrow(
      'model run must be a function',
    );
  });
});

describe('a source with an engine', () => {
  it('carries the raw engine, and an opened model runs on it', async () => {
    const engine = vi.fn(async function* (_command: string, signal: AbortSignal) {
      await Promise.resolve();
      if (!signal.aborted) yield { type: 'done' } as const;
    });
    const model = createModel({ ...sampleData(), ...sampleLoader(), run: engine });
    const source = model.source();
    expect(await drain(source.run!('raw'))).toEqual(['done']);

    const opened = await openModel(source);
    const run = opened.run!('study', { id: 'opened' });
    expect(await drain(run)).toEqual(['done']);
    expect(engine.mock.calls.map(([command]) => command)).toEqual(['raw', 'study']);
    expect(run.recording.classes).toEqual(['bus', 'gen']);
  });
});
