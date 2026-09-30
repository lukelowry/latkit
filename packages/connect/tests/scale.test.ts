import { beforeAll, describe, expect, it } from 'vitest';
import { setTimeout } from 'node:timers/promises';
import { harness, modes, prepareWorker, until } from './scale/harness.js';
import { verifyRows, verifySamples, inputAt } from '../../model_new/tests/scale/verify.js';
import type { NumericColumn, QueryHeader, RowsBlock } from '@latkit/model-new';
const query = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const fields = [{ from: 'Node', select: ['output'] }];
beforeAll(async () => {
  await prepareWorker();
}, 30_000);
describe.each(modes)('large model over %s', (mode) => {
  it('checks every cell of a million-row owned scan within the requested byte bound', async () => {
    const rows = 1_000_003,
      run = await harness(mode, rows);
    try {
      const document = await run.service.open();
      const scan = await verifyRows(document, rows, { buffers: 'owned', maxBlockBytes: 32 * 1024 });
      expect(scan.blocks).toBeGreaterThan(250);
      expect(scan.maxBlockBytes).toBeLessThanOrEqual(32 * 1024);
      expect(scan.maxBackingBytes).toBeLessThanOrEqual(32 * 1024);
      const stats = await run.metrics();
      expect(stats.generatedBytes).toBe(rows * 8);
      expect(stats.ownedCopiedBytes).toBe(rows * 8);
      expect(stats.activeReads).toBe(0);
      expect(stats.openedReads).toBe(stats.releasedReads);
      await document.close();
      expect((await run.metrics()).acquisitions).toBe(0);
    } finally {
      await run.close();
    }
  }, 30_000);
  it('matches an independent oracle for sparse identities, filtered sorting and aggregation', async () => {
    const rows = 100_003,
      run = await harness(mode, rows);
    try {
      const document = await run.service.open();
      const selected = [rows - 1, 3, 65537, 0, 8192];
      await verifyRows(
        document,
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
      await verifyRows(document, expected.length, {}, filtered, (i) => expected[i]);
      for await (const block of document.query({
        kind: 'aggregate',
        from: 'Node',
        select: ['value'],
        measures: ['min', 'max'],
      }))
        if (block.kind !== 'schema')
          expect(block.values.value).toEqual({ count: rows, min: -504, max: 504 });
      const empty = document.query({
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
      await document.close();
    } finally {
      await run.close();
    }
  }, 30_000);
  it('applies backpressure and interrupts a blocked pull without retaining the scan', async () => {
    const run = await harness(mode, 1_000_003);
    try {
      const document = await run.service.open();
      const iterator = document.query(query)[Symbol.asyncIterator]();
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
      await verifyRows(document, 3, {}, { ...query, limit: 3 });
      await document.close();
    } finally {
      await run.close();
    }
  }, 30_000);
  it('keeps reads and isolated commands pinned while a second acquisition edits shared inputs', async () => {
    const rows = 100_003,
      run = await harness(mode, rows);
    try {
      const document = await run.service.open(),
        other = await run.service.document(document.id);
      const model = await run.service.model(document.id),
        independent = await run.service.model(document.id);
      const iterator = document.query(query)[Symbol.asyncIterator]();
      const first = (await iterator.next()).value as QueryHeader;
      const recording = await model.monitor!({
        scope: { kind: 'command', id: 'pinned' },
        fields,
        retain: { kind: 'all', bytes: 4_000_000, onLimit: 'fail' },
      });
      await run.pause(true);
      const completed = model.call!(
        { routine: 'simulate', values: { frames: 3, factor: 2 } },
        { id: 'pinned' },
      );
      await recording.ready;
      const pinnedVersion = recording.documentVersion;
      await other.edit!([{ kind: 'set', id: 'n0', values: { value: 42 } }]);
      await run.pause(false);
      await completed;
      expect(pinnedVersion).toBe(first.version);
      expect(other.version).not.toBe(first.version);
      const block = (await iterator.next()).value as RowsBlock;
      expect(block.version).toBe(first.version);
      expect((block.columns.value as NumericColumn).values[0]).toBe(-504);
      await iterator.return?.();
      await verifySamples(recording, rows, 3);
      await independent.reset();
      expect(document.version).toBe(other.version);
      await verifyRows(other, 1, {}, { ...query, limit: 1 }, undefined, () => 42);
      await model.close();
      await independent.close();
      await document.close();
      await other.close();
      expect(await run.metrics()).toMatchObject({
        models: 0,
        acquisitions: 0,
        activeReads: 0,
        frameBytes: 0,
      });
    } finally {
      await run.close();
    }
  }, 30_000);
  it('bounds rolling capture, rejects expired frames and preserves issued views after close', async () => {
    const rows = 100_003,
      run = await harness(mode, rows);
    try {
      const document = await run.service.open(),
        model = await run.service.model(document.id);
      const recording = await model.monitor!({
        scope: { kind: 'command', id: 'rolling' },
        fields,
        retain: { kind: 'rolling', frames: 2, bytes: 2 * (rows * 8 + 8), onLimit: 'fail' },
      });
      await model.call!(
        { routine: 'simulate', values: { frames: 6, factor: 2 } },
        { id: 'rolling' },
      );
      expect(recording.firstFrame).toBe(4);
      expect(recording.frameCount).toBe(6);
      expect((await run.metrics()).peakFrameBytes).toBeLessThanOrEqual(2 * (rows * 8 + 8));
      const expired = recording
        .query({
          kind: 'samples',
          from: 'Node',
          select: ['output'],
          window: { kind: 'frames', offset: 0, count: 1 },
        })
        [Symbol.asyncIterator]();
      await expired.next();
      await expect(expired.next()).rejects.toMatchObject({ code: 'expired' });
      await verifySamples(recording, rows, 2, 4);
      const held = recording
        .query({
          kind: 'samples',
          from: 'Node',
          select: ['output'],
          window: { kind: 'at', value: 5 },
        })
        [Symbol.asyncIterator]();
      await held.next();
      const next = await held.next();
      if (next.done || next.value.kind !== 'samples') throw new Error('samples');
      const values = next.value.columns.output.values;
      await held.return?.();
      await model.close();
      await document.close();
      expect(values[0]).toBe(inputAt(0) * 2 + 5);
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
      const document = await run.service.open();
      const scans = await Promise.all(
        Array.from({ length: 4 }, () => verifyRows(document, 100_003, { maxBlockBytes: 4096 })),
      );
      expect(scans.every((scan) => scan.maxBlockBytes <= 4096)).toBe(true);
      const metrics = await run.metrics();
      expect(metrics.peakReads).toBeGreaterThan(1);
      expect(metrics.peakReads).toBeLessThanOrEqual(4);
      expect(metrics.activeReads).toBe(0);
      if (mode === 'framed' || mode === 'socket')
        expect(run.socket.maxFrameBytes).toBeLessThanOrEqual(32768);
      await document.close();
    } finally {
      await run.close();
    }
  }, 30_000);
  it('cancels a large running command and leaves the model usable', async () => {
    const run = await harness(mode, 1_000_003);
    try {
      const document = await run.service.open(),
        model = await run.service.model(document.id);
      const recording = await model.monitor!({
        scope: { kind: 'command', id: 'cancel' },
        fields,
        retain: { kind: 'all', bytes: 64 * 1024 * 1024, onLimit: 'fail' },
      });
      await run.pause(true);
      const controller = new AbortController();
      const result = model.call!(
        { routine: 'simulate', values: { frames: 100, factor: 2 } },
        { id: 'cancel', signal: controller.signal },
      );
      const cancelled = expect(result).rejects.toMatchObject({ code: 'aborted' });
      await recording.ready;
      await until(run, (stats) => stats.waitingCommands === 1);
      controller.abort();
      await cancelled;
      await recording.done;
      expect(recording.frameCount).toBe(0);
      await run.pause(false);
      await model.reset();
      await verifyRows(document, 1, {}, { ...query, limit: 1 });
      await document.close();
      await model.close();
      expect(await run.metrics()).toMatchObject({
        models: 0,
        acquisitions: 0,
        activeReads: 0,
        frameBytes: 0,
      });
    } finally {
      await run.close();
    }
  }, 30_000);
  it('releases blocked reads, commands and captures when the connection closes', async () => {
    const run = await harness(mode, 1_000_003);
    try {
      const document = await run.service.open(),
        model = await run.service.model(document.id);
      const recording = await model.monitor!({
        scope: { kind: 'command', id: 'shutdown' },
        fields,
        retain: { kind: 'all', bytes: 64 * 1024 * 1024, onLimit: 'fail' },
      });
      const iterator = document.query(query)[Symbol.asyncIterator]();
      await iterator.next();
      await run.pause(true);
      const pulling = iterator.next();
      const readStopped = expect(pulling).rejects.toBeDefined();
      const work = model.call!(
        { routine: 'simulate', values: { frames: 10, factor: 2 } },
        { id: 'shutdown' },
      );
      const workStopped = expect(work).rejects.toBeDefined();
      void recording.done.catch(() => undefined);
      await recording.ready;
      await until(run, (stats) => stats.waitingReads === 1 && stats.waitingCommands === 1);
      await run.close();
      await readStopped;
      await workStopped;
      expect(await run.metrics()).toMatchObject({
        activeReads: 0,
        waitingReads: 0,
        waitingCommands: 0,
        models: 0,
        acquisitions: 0,
        frameBytes: 0,
      });
    } finally {
      await run.close();
    }
  }, 30_000);
  it('keeps large live capture separate from isolated output and stops before document changes', async () => {
    const rows = 100_003,
      run = await harness(mode, rows);
    try {
      const document = await run.service.open(),
        model = await run.service.model(document.id);
      const recording = await model.monitor!({
        scope: { kind: 'live' },
        fields,
        retain: { kind: 'all', bytes: 3 * (rows * 8 + 8), onLimit: 'fail' },
      });
      await recording.ready;
      await model.call!({ routine: 'advance', values: { frames: 2, factor: 3 } });
      await model.call!({ routine: 'simulate', values: { frames: 2, factor: 99 } });
      expect(recording.frameCount).toBe(2);
      await verifySamples(recording, rows, 2, 0, 3);
      await document.edit!([{ kind: 'set', id: 'n0', values: { value: 7 } }]);
      expect(await recording.done).toMatchObject({ reason: 'document-changed' });
      const later = await model.monitor!({
        scope: { kind: 'live' },
        fields,
        retain: { kind: 'all', bytes: rows * 8 + 8, onLimit: 'fail' },
      });
      await model.call!({ routine: 'advance', values: { frames: 1, factor: 3 } });
      expect(later.range).toEqual([2, 2]);
      for await (const block of later.query({
        kind: 'samples',
        from: 'Node',
        select: ['output'],
        rows: { kind: 'range', offset: 0, count: 1 },
        window: { kind: 'at', value: 2 },
      }))
        if (block.kind !== 'schema') expect(block.columns.output.values[0]).toBe(23);
      await model.close();
      await document.close();
      expect((await run.metrics()).frameBytes).toBe(0);
    } finally {
      await run.close();
    }
  }, 30_000);
});
