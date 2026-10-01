import { describe, expect, it } from 'vitest';
import type { Command, FieldSelection, Update } from '../src/index.js';
import { blockBuffers } from '../src/index.js';
import { ScaleModel } from './scale/model.js';
import { verifyRows, verifySamples } from './scale/verify.js';
const rows = 1_000_003;
const query = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const output: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
const simulate = (frames: number, factor = 2): Command => ({
  routine: 'simulate',
  values: { frames, factor },
});
describe('large paged native implementation', () => {
  it('streams a million rows without an eager identity array or copies of borrowed columns', async () => {
    const model = new ScaleModel(rows);
    expect(model.stats.generatedBytes).toBe(0);
    const scan = await verifyRows(model, rows);
    expect(scan.blocks).toBeGreaterThan(100);
    expect(scan.maxBlockBytes).toBeLessThanOrEqual(256 * 1024);
    expect(model.stats.generatedBytes).toBe(rows * 8);
    expect(model.stats.ownedCopiedBytes).toBe(0);
    expect(model.stats.activeReads).toBe(0);
    await model.close();
  });
  it('produces independently transferable owned blocks with no aliases into native storage', async () => {
    const model = new ScaleModel(rows);
    const iterator = model
      .query(query, { buffers: 'owned', maxBlockBytes: 16384 })
      [Symbol.asyncIterator]();
    await iterator.next();
    const first = await iterator.next();
    if (first.done || first.value.kind !== 'rows') throw new Error('rows');
    const buffers = blockBuffers(first.value);
    const sum = buffers.reduce((n, b) => n + b.byteLength, 0);
    expect(sum).toBeLessThanOrEqual(16384);
    structuredClone(first.value, { transfer: buffers as ArrayBuffer[] });
    const next = await iterator.next();
    expect(next.done).toBe(false);
    await iterator.return?.();
    await verifyRows(model, 3, {}, { ...query, limit: 3 });
    await model.close();
  });
  it('streams one command to every monitor from shared output buffers', async () => {
    const model = new ScaleModel(100_003);
    const first = await model.monitor(output),
      second = await model.monitor(output);
    expect(await model.run(simulate(3))).toEqual({ frames: 3 });
    expect(model.stats.frameBytes).toBe(3 * (100_003 * 8 + 8));
    expect(first.progress).toBe(1);
    await verifySamples(first, 100_003, 3);
    await verifySamples(second, 100_003, 3);
    await model.close();
    await verifySamples(first, 100_003, 3);
    await first.close();
    expect(model.stats.frameBytes).toBe(3 * (100_003 * 8 + 8));
    await second.close();
    expect(model.stats.frameBytes).toBe(0);
  });
  it('runs commands one at a time, each starting its monitors over', async () => {
    const model = new ScaleModel(10_003);
    const monitor = await model.monitor(output);
    const updates: Update[] = [];
    monitor.on('change', (update) => updates.push(update));
    const earlier = model.run(simulate(2, 1));
    const later = model.run(simulate(3));
    await Promise.all([earlier, later]);
    expect(updates.filter((update) => update.kind === 'replace')).toHaveLength(2);
    expect(
      updates.flatMap((update) => (update.kind === 'append' ? [update.frames.offset] : [])),
    ).toEqual([0, 1, 0, 1, 2]);
    await verifySamples(monitor, 10_003, 3);
    await model.close();
  });
  it('cancels a queued command without waiting for the one ahead', async () => {
    const model = new ScaleModel(10_003);
    const monitor = await model.monitor(output);
    model.pause(true);
    const ahead = model.run(simulate(1));
    const controller = new AbortController();
    const queued = model.run(simulate(1), { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'aborted' });
    expect(monitor.status).toBe('running');
    model.pause(false);
    await ahead;
    expect(monitor.status).toBe('complete');
    await model.close();
  });
});

it('closing a native model releases an iterator suspended between pulls', async () => {
  const model = new ScaleModel(1_000_003);
  const iterator = model.query(query)[Symbol.asyncIterator]();
  await iterator.next();
  expect(model.stats.activeReads).toBe(1);
  await model.close();
  expect(model.stats.activeReads).toBe(0);
  expect((await iterator.next()).done).toBe(true);
});
