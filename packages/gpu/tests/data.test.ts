import { expect, it } from 'vitest';
import { createGpu } from '../src/index.js';
import { Source } from './fixtures/source.js';
import { fakeDevice } from './fixtures/device.js';
import { draw } from './fixtures/render.js';
import { type Data, type NumericColumn, type RowsBlock } from '@latkit/model';
const query = { kind: 'rows', from: 'node', select: ['value'] } as const;
async function collect(source: AsyncIterable<RowsBlock>) {
  const values: RowsBlock[] = [];
  for await (const block of source) values.push(block);
  return values;
}
it('coalesces equivalent local computations and reuses their completed results', async () => {
  const source = new Source(1000, { blockRows: 100 }).data,
    gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    const [a, b] = await Promise.all([
      collect(frame.reader.read(source, query)),
      collect(frame.reader.read(source, query)),
    ]);
    expect(a).toHaveLength(10);
    expect(b).toEqual(a);
  });
  const queries = gpu.stats().queries;
  await draw(gpu, async (frame) => {
    expect(await collect(frame.reader.read(source, query))).toHaveLength(10);
  });
  expect(gpu.stats().queries).toBe(queries);
  expect(gpu.stats().queryHits).toBeGreaterThan(0);
  gpu.destroy();
});
it('processes data larger than its cache within the CPU budget', async () => {
  const source = new Source(100000, { blockRows: 256 }).data,
    budget = 256 * 1024,
    gpu = await createGpu({
      device: fakeDevice().device,
      budget: { cpuBytes: budget, stagingBytes: 65536 },
      maxBlockBytes: 8192,
    });
  let count = 0;
  await draw(gpu, async (frame) => {
    for await (const block of frame.reader.read(source, query)) count += block.columns.value.length;
  });
  expect(count).toBe(100000);
  expect(gpu.stats().peakCpuBytes).toBeLessThanOrEqual(budget);
  gpu.trim();
  expect(gpu.stats().cpuBytes).toBe(0);
  gpu.destroy();
});
it('does not share cached reads between distinct data of the same shape', async () => {
  const a = new Source(4),
    b = new Source(4);
  b.values = Float32Array.of(40, 41, 42, 43);
  const gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    const first = await collect(frame.reader.read(a.data, query)),
      second = await collect(frame.reader.read(b.data, query));
    expect((first[0].columns.value as NumericColumn).values[0]).toBe(0);
    expect((second[0].columns.value as NumericColumn).values[0]).toBe(40);
  });
  gpu.destroy();
});
it('an application replacement does not change an in-progress data value', async () => {
  const app = new Source(8, { blockRows: 2 }),
    original = app.data,
    gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    const iterator = frame.reader.read(original, query)[Symbol.asyncIterator]();
    const first = await iterator.next();
    app.values = Float32Array.from({ length: 8 }, () => 99);
    app.publish();
    expect(app.data).not.toBe(original);
    let sum = 0;
    for (let next = first; !next.done; next = await iterator.next())
      for (const value of (next.value.columns.value as NumericColumn).values) sum += value;
    expect(sum).toBe(28);
  });
  gpu.destroy();
});
it('ordinary data values remain usable after GPU teardown', async () => {
  const data: Data = new Source(8).data,
    gpu = await createGpu({ device: fakeDevice().device });
  const reads = gpu.reader.open();
  try {
    await collect(reads.read(data, query));
  } finally {
    reads.close();
  }
  gpu.destroy();
  expect(Object.keys(data).sort()).toEqual(['schema', 'tables']);
  expect((data.tables.node.fields.value.at(0)!.column as NumericColumn).values[0]).toBe(0);
});
it('cancels a local reader without affecting another reader of the same data', async () => {
  const data = new Source(1000, { blockRows: 100 }).data,
    gpu = await createGpu({ device: fakeDevice().device });
  const stop = new AbortController(),
    first = gpu.reader.open({ signal: stop.signal }),
    second = gpu.reader.open();
  try {
    const a = first.read(data, query)[Symbol.asyncIterator](),
      b = second.read(data, query)[Symbol.asyncIterator]();
    await a.next();
    const head = await b.next();
    stop.abort();
    await expect(a.next()).rejects.toBeDefined();
    let count = 0;
    for (let next = head; !next.done; next = await b.next())
      count += next.value.columns.value.length;
    expect(count).toBe(1000);
  } finally {
    first.close();
    second.close();
  }
  gpu.destroy();
});
