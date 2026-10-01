import { describe, expect, it } from 'vitest';
import {
  blockByteLength,
  validateBlock,
  validateSchema,
  type Queryable,
  type SamplesQuery,
} from '@latkit/model';
import { Telemetry } from './source.js';
const query: SamplesQuery = {
  kind: 'samples',
  from: 'sensor',
  select: ['x', 'y'],
  window: { kind: 'range', between: [0, 10] },
};
async function collectBlocks<T>(blocks: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const block of blocks) result.push(block);
  return result;
}
async function collect(source: Queryable, request = query, options = {}) {
  return collectBlocks(source.query(request, options));
}
describe('native example telemetry', () => {
  it('publishes valid native blocks and shares immutable borrowed frame backing', async () => {
    const source = new Telemetry(['x', 'y'], 3, 0.1);
    const frame = Float64Array.of(1, 2, 3, 4, 5, 6);
    source.append(frame);
    expect(validateSchema(await source.describe())).toEqual([]);
    const result = await collect(source);
    expect(result[0]?.kind).toBe('schema');
    for (const block of result.slice(1)) {
      if (block.kind !== 'samples') throw new Error('Expected samples');
      expect(validateBlock(await source.describe(), query, block)).toEqual([]);
      expect(block.columns.x!.values.buffer).toBe(frame.buffer);
      expect([...block.columns.y!.values]).toEqual([4, 5, 6]);
    }
  });
  it('pins query versions on first pull and retains backing across parent close', async () => {
    const source = new Telemetry(['x', 'y'], 1, 1);
    source.append(Float64Array.of(1, 2));
    const read = source.query(query)[Symbol.asyncIterator]();
    const header = await read.next();
    if (header.done) throw new Error('Expected schema');
    expect(header.value.version).toBe('1');
    const retained = await source.retain();
    source.append(Float64Array.of(3, 4));
    const sample = await read.next();
    if (sample.done || sample.value.kind !== 'samples') throw new Error('Expected samples');
    expect(sample.value.firstFrame).toBe(0);
    expect((await read.next()).done).toBe(true);
    await source.close();
    expect((await collect(retained)).length).toBe(2);
    expect(retained.version).toBe('1');
    await retained.close();
  });
  it('honors byte bounds, sparse order, and independent owned allocations', async () => {
    const source = new Telemetry(['x', 'y'], 3, 1);
    const frame = Float64Array.of(1, 2, 3, 4, 5, 6);
    source.append(frame);
    const results = await collect(
      source,
      { ...query, rows: { kind: 'indices', index: source.index, values: Uint32Array.of(2, 0) } },
      { maxBlockBytes: 360, buffers: 'owned' },
    );
    const blocks = results.filter((block) => block.kind === 'samples');
    expect(blocks.map((block) => block.columns.x!.values[0])).toEqual([3, 1]);
    for (const block of blocks) {
      expect(blockByteLength(block)).toBeLessThanOrEqual(360);
      expect(block.columns.x!.values.buffer).not.toBe(frame.buffer);
      expect(block.columns.x!.values.buffer).not.toBe(block.columns.y!.values.buffer);
    }
    blocks[0]!.columns.x!.values[0] = 99;
    expect(frame[2]).toBe(3);
  });
  it('batches long histories while keeping append and exact reads small', async () => {
    const source = new Telemetry(['x', 'y'], 192, 0.1);
    for (let f = 0; f < 900; f++) source.append(new Float64Array(384).fill(f));
    const request = { ...query, window: { kind: 'frames' as const, offset: 0, count: 900 } };
    const blocks = (await collect(source, request)).filter((block) => block.kind === 'samples');
    expect(blocks.length).toBe(15);
    expect(blocks.reduce((n, block) => n + block.coordinates.length, 0)).toBe(900);
    for (const block of blocks) {
      expect(validateBlock(source.schema, request, block)).toEqual([]);
      expect(blockByteLength(block)).toBeLessThanOrEqual(source.schema.limits.maxBlockBytes);
      expect(block.columns.x!.values[0]).toBe(block.firstFrame);
    }
  });
  it('rejects invalid rows, future frames, retain overflow and cancelled reads', async () => {
    const source = new Telemetry(['x', 'y'], 1, 1);
    source.append(Float64Array.of(1, 2));
    await expect(
      collect(source, { ...query, rows: { kind: 'ids', ids: ['-1'] } }),
    ).rejects.toThrow();
    await expect(
      collect(source, { ...query, window: { kind: 'frames', offset: 1, count: 1 } }),
    ).rejects.toThrow();
    await expect(source.retain({ maxBytes: 1 })).rejects.toThrow();
    const stop = new AbortController();
    stop.abort();
    await expect(collect(source, query, { signal: stop.signal })).rejects.toThrow();
  });
});
