import { describe, expect, it } from 'vitest';
import { ScaleService } from './scale/service.js';
import { verifyRows, verifySamples, inputAt } from './scale/verify.js';
import { blockBuffers } from '../src/index.js';
import type { NumericColumn } from '../src/index.js';
const rows = 1_000_003;
const query = { kind: 'rows', from: 'Node', select: ['value'] } as const;
describe('large paged native implementation', () => {
  it('streams a million rows without an eager identity array or copies of borrowed columns', async () => {
    const service = new ScaleService(rows);
    const document = await service.open();
    expect(service.stats.generatedBytes).toBe(0);
    const scan = await verifyRows(document, rows);
    expect(scan.blocks).toBeGreaterThan(100);
    expect(scan.maxBlockBytes).toBeLessThanOrEqual(256 * 1024);
    expect(service.stats.generatedBytes).toBe(rows * 8);
    expect(service.stats.ownedCopiedBytes).toBe(0);
    expect(service.stats.activeReads).toBe(0);
    await document.close();
    expect(service.cores.size).toBe(0);
  });
  it('copies one affected page, keeps active reads pinned, and retains borrowed views after close', async () => {
    const service = new ScaleService(rows, 4096);
    const document = await service.open();
    const iterator = document.query(query)[Symbol.asyncIterator]();
    const header = await iterator.next();
    const first = await iterator.next();
    if (first.done || first.value.kind !== 'rows') throw new Error('Expected rows');
    const held = first.value.columns.value as NumericColumn;
    await document.edit!([
      { kind: 'set', id: 'n0', values: { value: 77 } },
      { kind: 'set', id: 'n1', values: { value: 88 } },
    ]);
    expect(service.stats.editCopiedBytes).toBe(4096 * 8);
    expect(held.values[0]).toBe(-504);
    const next = await iterator.next();
    expect(next.value?.version).toBe(header.value?.version);
    await iterator.return?.();
    await verifyRows(document, rows, {}, query, undefined, (row) =>
      row === 0 ? 77 : row === 1 ? 88 : inputAt(row),
    );
    await document.close();
    expect(held.values[0]).toBe(-504);
  });
  it('produces independently transferable owned blocks with no aliases into native storage', async () => {
    const service = new ScaleService(rows);
    const document = await service.open();
    const iterator = document
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
    await verifyRows(document, 3, {}, { ...query, limit: 3 });
    await document.close();
  });
  it('runs isolated commands on pinned input and shares output buffers between captures', async () => {
    const service = new ScaleService(100_003);
    const document = await service.open(),
      model = await service.model(document.id);
    const config = {
      scope: { kind: 'command', id: 'work' },
      fields: [{ from: 'Node', select: ['output'] }],
      retain: { kind: 'all', bytes: 8_000_000, onLimit: 'fail' },
    } as const;
    const first = await model.monitor!(config),
      second = await model.monitor!(config);
    service.pause(true);
    const call = model.call!(
      { routine: 'simulate', values: { frames: 3, factor: 2 } },
      { id: 'work' },
    );
    await first.ready;
    await document.edit!([{ kind: 'set', id: 'n0', values: { value: 100 } }]);
    service.pause(false);
    await call;
    expect(service.stats.editCopiedBytes).toBe(8192 * 8);
    expect(service.stats.frameBytes).toBe(3 * (100_003 * 8 + 8));
    await verifySamples(first, 100_003, 3);
    await verifySamples(second, 100_003, 3);
    expect((await first.commands({ limit: 5 })).items[0].documentVersion).not.toBe(
      document.version,
    );
    await model.close();
    expect(service.stats.frameBytes).toBe(0);
    await document.close();
  });
});

it('closing a native acquisition releases an iterator suspended between pulls', async () => {
  const service = new ScaleService(1_000_003);
  const document = await service.open();
  const iterator = document.query(query)[Symbol.asyncIterator]();
  await iterator.next();
  expect(service.stats.activeReads).toBe(1);
  await document.close();
  expect(service.stats.activeReads).toBe(0);
  expect((await iterator.next()).done).toBe(true);
});
