import { beforeAll, describe, expect, it } from 'vitest';
import { setTimeout } from 'node:timers/promises';
import { harness, modes, prepareWorker, until } from './scale/harness.js';
import { verifyRows, verifySamples, inputAt } from '../../model/tests/scale/verify.js';
import type { Command, FieldSelection, NumericColumn, QueryHeader, RowsBlock } from '@latkit/model';
import { reached } from './fixture.js';
const query = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const fields: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
const simulate = (frames: number, factor = 2): Command => ({
  routine: 'simulate',
  values: { frames, factor },
});
beforeAll(async () => {
  await prepareWorker();
}, 30_000);
describe.each(modes)('large model over %s', (mode) => {
  it('checks every cell of a million-row owned scan within the requested byte bound', async () => {
    const rows = 1_000_003,
      run = await harness(mode, rows);
    try {
      const scan = await verifyRows(run.model, rows, {
        buffers: 'owned',
        maxBlockBytes: 32 * 1024,
      });
      expect(scan.blocks).toBeGreaterThan(250);
      expect(scan.maxBlockBytes).toBeLessThanOrEqual(32 * 1024);
      expect(scan.maxBackingBytes).toBeLessThanOrEqual(32 * 1024);
      const stats = await run.metrics();
      expect(stats.generatedBytes).toBe(rows * 8);
      expect(stats.ownedCopiedBytes).toBe(rows * 8);
      expect(stats.activeReads).toBe(0);
      expect(stats.openedReads).toBe(stats.releasedReads);
      expect(stats.acquisitions).toBe(0);
    } finally {
      await run.close();
    }
  }, 30_000);
  it('matches an independent oracle for sparse identities, filtered sorting and aggregation', async () => {
    const rows = 100_003,
      run = await harness(mode, rows);
    try {
      const selected = [rows - 1, 3, 65537, 0, 8192];
      await verifyRows(
        run.model,
        selected.length,
        {},
        { ...query, ids: true, rows: { kind: 'ids', ids: selected.map((row) => 'n' + row) } },
        (i) => selected[i],
      );
      const expected = Array.from({ length: rows }, (_, i) => i)
        .filter((row) => inputAt(row) >= 490)
        .sort((a, b) => inputAt(b) - inputAt(a) || a - b)
        .slice(11, 811);
      const filtered = {
        ...query,
        where: [{ field: 'value', operator: 'greaterThanOrEqual', value: 490 }],
        orderBy: [{ field: 'value', direction: 'descending' }],
        offset: 11,
        limit: 800,
        count: true,
      } as const;
      await verifyRows(run.model, expected.length, {}, filtered, (i) => expected[i]);
      for await (const block of run.model.query({
        kind: 'aggregate',
        from: 'Node',
        select: ['value'],
        measures: ['min', 'max'],
      }))
        if (block.kind !== 'schema')
          expect(block.values.value).toEqual({ count: rows, min: -504, max: 504 });
      const empty = run.model.query({
        ...query,
        where: [{ field: 'value', operator: 'equal', value: 9999 }],
        count: true,
      });
      const emptyBlocks = [];
      for await (const block of empty) emptyBlocks.push(block);
      expect(emptyBlocks).toHaveLength(2);
      expect(emptyBlocks[1]).toMatchObject({ total: 0 });
      const emptyData = emptyBlocks[1] as RowsBlock;
      expect(
        emptyData.rows.kind === 'range' ? emptyData.rows.count : emptyData.rows.values.length,
      ).toBe(0);
    } finally {
      await run.close();
    }
  }, 30_000);
  it('applies backpressure and interrupts a blocked pull without retaining the scan', async () => {
    const run = await harness(mode, 1_000_003);
    try {
      const iterator = run.model.query(query)[Symbol.asyncIterator]();
      await iterator.next();
      expect((await run.metrics()).generatedBytes).toBe(0);
      await iterator.next();
      const before = await run.metrics();
      await setTimeout(20);
      expect((await run.metrics()).blocks).toBe(before.blocks);
      expect(before.generatedBytes).toBeLessThanOrEqual(8192 * 8);
      await run.pause(true);
      const blocked = expect(iterator.next()).rejects.toMatchObject({ code: 'aborted' });
      await until(run, (stats) => stats.waitingReads === 1);
      await iterator.return?.();
      await blocked;
      expect((await run.metrics()).activeReads).toBe(0);
      await run.pause(false);
      await verifyRows(run.model, 3, {}, { ...query, limit: 3 });
    } finally {
      await run.close();
    }
  }, 30_000);
  it('runs a command into two monitors beside an open scan, then frees their frames', async () => {
    const rows = 100_003,
      run = await harness(mode, rows);
    try {
      const iterator = run.model.query(query)[Symbol.asyncIterator]();
      const first = (await iterator.next()).value as QueryHeader;
      const a = await run.model.monitor(fields),
        b = await run.model.monitor(fields);
      expect(await run.model.run(simulate(3))).toEqual({ frames: 3 });
      const block = (await iterator.next()).value as RowsBlock;
      expect(block.version).toBe(first.version);
      expect((block.columns.value as NumericColumn).values[0]).toBe(-504);
      await iterator.return?.();
      expect(a.status).toBe('complete');
      expect(a.progress).toBe(1);
      await verifySamples(a, rows, 3);
      await verifySamples(b, rows, 3);
      expect((await run.metrics()).frameBytes).toBe(3 * (rows * 8 + 8));
      await a.close();
      expect((await run.metrics()).frameBytes).toBe(3 * (rows * 8 + 8));
      await b.close();
      expect(await run.metrics()).toMatchObject({ acquisitions: 0, activeReads: 0, frameBytes: 0 });
    } finally {
      await run.close();
    }
  }, 30_000);
  it('starts a monitor over for each command and keeps issued views', async () => {
    const rows = 100_003,
      run = await harness(mode, rows);
    try {
      const recording = await run.model.monitor(fields);
      await run.model.run(simulate(2));
      const held = recording
        .query({
          kind: 'samples',
          from: 'Node',
          select: ['output'],
          window: { kind: 'at', value: 1 },
        })
        [Symbol.asyncIterator]();
      await held.next();
      const next = await held.next();
      if (next.done || next.value.kind !== 'samples') throw new Error('samples');
      const values = next.value.columns.output.values;
      await held.return?.();
      await run.model.run(simulate(3, 3));
      expect(recording.frames).toBe(3);
      expect((await run.metrics()).frameBytes).toBe(3 * (rows * 8 + 8));
      await verifySamples(recording, rows, 3, 0, 3);
      await recording.close();
      expect(values[0]).toBe(inputAt(0) * 2 + 1);
      expect((await run.metrics()).frameBytes).toBe(0);
    } finally {
      await run.close();
    }
  }, 30_000);
  it('multiplexes four large queries under a 32 KiB connection budget', async () => {
    const run = await harness(mode, 100_003, 8192, {
      limits: { maxInFlightBytes: 32768, maxMetadataBytes: 4096 },
    });
    try {
      const scans = await Promise.all(
        Array.from({ length: 4 }, () => verifyRows(run.model, 100_003, { maxBlockBytes: 4096 })),
      );
      expect(scans.every((scan) => scan.maxBlockBytes <= 4096)).toBe(true);
      const metrics = await run.metrics();
      expect(metrics.peakReads).toBeGreaterThan(1);
      expect(metrics.peakReads).toBeLessThanOrEqual(4);
      expect(metrics.activeReads).toBe(0);
      if (mode === 'framed' || mode === 'socket')
        expect(run.socket.maxFrameBytes).toBeLessThanOrEqual(32768);
    } finally {
      await run.close();
    }
  }, 30_000);
  it('cancels a large running command and leaves the model usable', async () => {
    const run = await harness(mode, 1_000_003);
    try {
      const recording = await run.model.monitor(fields);
      await run.pause(true);
      const controller = new AbortController();
      const result = run.model.run(simulate(100), { signal: controller.signal });
      const cancelled = expect(result).rejects.toMatchObject({ code: 'aborted' });
      await until(run, (stats) => stats.waitingCommands === 1);
      controller.abort();
      await cancelled;
      await reached(recording, 'cancelled');
      expect(recording.frames).toBe(0);
      await run.pause(false);
      await verifyRows(run.model, 1, {}, { ...query, limit: 1 });
      await recording.close();
      expect(await run.metrics()).toMatchObject({ acquisitions: 0, activeReads: 0, frameBytes: 0 });
    } finally {
      await run.close();
    }
  }, 30_000);
  it('releases blocked reads, commands and monitors when the connection closes', async () => {
    const run = await harness(mode, 1_000_003);
    try {
      await run.model.monitor(fields);
      const iterator = run.model.query(query)[Symbol.asyncIterator]();
      await iterator.next();
      await run.pause(true);
      const pulling = iterator.next();
      const readStopped = expect(pulling).rejects.toBeDefined();
      const work = run.model.run(simulate(10));
      const workStopped = expect(work).rejects.toBeDefined();
      await until(run, (stats) => stats.waitingReads === 1 && stats.waitingCommands === 1);
      await run.close();
      await readStopped;
      await workStopped;
      expect(await run.metrics()).toMatchObject({
        activeReads: 0,
        waitingReads: 0,
        waitingCommands: 0,
        acquisitions: 0,
        frameBytes: 0,
      });
    } finally {
      await run.close();
    }
  }, 30_000);
  it('retains a native frame past the next command and its monitor', async () => {
    const rows = 1_000_003,
      run = await harness(mode, rows);
    try {
      const recording = await run.model.monitor(fields);
      await run.model.run(simulate(1));
      const before = await run.metrics();
      const source = await recording.retain({
        window: { kind: 'frames', offset: 0, count: 1 },
        maxBytes: 32 * 1024 * 1024,
      });
      const nested = await source.retain();
      const after = await run.metrics();
      expect(after.blocks).toBe(before.blocks);
      expect(after.ownedCopiedBytes).toBe(before.ownedCopiedBytes);
      expect(after.frameBytes).toBe(rows * 8 + 8);
      await run.model.run(simulate(2));
      expect((await run.metrics()).frameBytes).toBe(3 * (rows * 8 + 8));
      await recording.close();
      expect((await run.metrics()).frameBytes).toBe(rows * 8 + 8);
      await source.close();
      expect((await run.metrics()).frameBytes).toBe(rows * 8 + 8);
      await verifySamples(nested, rows, 1);
      await nested.close();
      expect(await run.metrics()).toMatchObject({ acquisitions: 0, activeReads: 0, frameBytes: 0 });
    } finally {
      await run.close();
    }
  }, 30_000);
});
