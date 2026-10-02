import { expect, it } from 'vitest';
import {
  appendData,
  appendedPages,
  blockBuffers,
  copyBuffers,
  createData,
  locateSample,
  read,
  resolveRows,
  samplePages,
  textColumn,
  type Data,
  type SampleBatch,
  type Schema,
} from '../src/index.js';
import { Sequence } from '../src/sequence.js';
const index = { source: 'pages', type: 'node', version: 'rows' };
const rows = { kind: 'range', offset: 0, count: 2 } as const;
const schema: Schema = {
  limits: { maxBlockBytes: 65536 },
  axis: { name: 'time' },
  types: {
    node: {
      fields: { a: { type: 'float32', sampled: true }, b: { type: 'float32', sampled: true } },
    },
  },
};
function batch(
  frame: number,
  time: number,
  field = 'a',
  axis: { readonly kind: 'range'; readonly offset: number; readonly count: number } = rows,
): SampleBatch {
  return {
    kind: 'samples',
    index,
    rows: axis,
    firstFrame: frame,
    coordinates: Float64Array.of(time),
    columns: {
      [field]: {
        kind: 'numeric',
        offset: 0,
        length: axis.count,
        rowStride: 1,
        frameStride: axis.count,
        values: new Float32Array(axis.count).fill(frame),
      },
    },
  };
}
it('preserves snapshots and duplicate-coordinate lookup through thousands of appends and frame gaps', async () => {
  let data = createData(schema, '0', [batch(0, 0)]);
  const versions: Data[] = [data];
  for (let i = 1; i < 2048; i++) {
    data = appendData(data, String(i), [batch(i * 3, Math.floor(i / 4))]);
    if (i % 127 === 0) versions.push(data);
  }
  const pages = data.tables.node.fields.a;
  expect(pages.length).toBe(2048);
  expect(pages.at(-1)).toBe([...pages].at(-1));
  for (let coordinate = 0; coordinate < 512; coordinate += 7)
    expect(locateSample(pages, coordinate)?.frame).toBe((coordinate * 4 + 3) * 3);
  for (const old of versions) {
    const prefix = old.tables.node.fields.a;
    expect([...appendedPages(prefix, pages)!]).toHaveLength(pages.length - prefix.length);
    expect(locateSample(prefix, 1e6)?.frame).toBe((prefix.length - 1) * 3);
    expect(pages.at(prefix.length - 1)).toBe(prefix.at(-1));
    expect(appendedPages(pages, prefix)).toBeUndefined();
  }
  const copied = copyBuffers(data);
  expect(appendedPages(pages, copied.tables.node.fields.a)).toBeUndefined();
  const originals = new Set(blockBuffers(data));
  expect(blockBuffers(copied).some((buffer) => originals.has(buffer))).toBe(false);
  expect(locateSample(copied.tables.node.fields.a, 511)?.frame).toBe(6141);
  const blocks = [];
  for await (const block of read(data, { kind: 'rows', from: 'node', select: ['a'], at: 511 }))
    if (block.kind === 'rows') blocks.push(block);
  expect(blocks).toHaveLength(1);
  expect([...samplePages(pages, { kind: 'at', value: 511 })]).toEqual([pages.at(-1)]);
  expect(() => samplePages(pages, { kind: 'frames', offset: 1, count: 3 })).toThrow(/gap/);
  expect(() => samplePages(pages, { kind: 'at', value: NaN })).toThrow();
  expect([...samplePages(pages, { kind: 'frames', offset: 0, count: 0 })]).toEqual([]);
});
it('resolves independent sample coverage and stable ID ordering without gathering values', () => {
  const source = createData(schema, 'a', [
    { kind: 'rows', index, rows, ids: textColumn(['left', 'right']), columns: {} },
    batch(0, 0),
    batch(1, 1, 'a', { ...rows, offset: 1, count: 1 }),
    batch(8, 0, 'b'),
  ]);
  const selection = { kind: 'ids', ids: ['right', 'left'] } as const;
  const first = resolveRows(source, { from: 'node', select: ['a', 'b'], rows: selection, at: 0 })!;
  const next = appendData(source, 'b', [batch(9, 2, 'b')]);
  expect(
    resolveRows(next, { from: 'node', select: ['a', 'b'], rows: selection, at: 0 })?.rows,
  ).toBe(first.rows);
  expect(resolveRows(source, { from: 'node', select: ['a', 'b'], at: 1 })?.rows).toEqual({
    kind: 'range',
    offset: 1,
    count: 1,
  });
  expect(resolveRows(source, { from: 'node', select: ['a'], at: -1 })).toBeUndefined();
  expect(() =>
    resolveRows(source, { from: 'node', select: ['a'], rows: selection, at: 1 }),
  ).toThrow(/outside/);
  expect(() => resolveRows(source, { from: 'node', select: ['a'] })).toThrow();
});
it('searches and slices irregular persistent batches like a flat sequence without changing earlier values', () => {
  let sequence = Sequence.empty<number>();
  const flat: number[] = [],
    snapshots: { value: Sequence<number>; length: number }[] = [];
  for (let i = 0; i < 2000; i++) {
    const batch = Array.from({ length: ((i * 31) % 17) + 1 }, (_, j) => flat.length + j);
    sequence = sequence.append(batch);
    flat.push(...batch);
    if (i % 137 === 0) snapshots.push({ value: sequence, length: flat.length });
  }
  expect([...sequence]).toEqual(flat);
  for (let i = 0; i < flat.length; i += 101) {
    expect(sequence.at(i)).toBe(i);
    expect(sequence.lowerBound((value) => value >= i)).toBe(i);
    expect([...sequence.range(i, i + 13)]).toEqual(flat.slice(i, i + 13));
  }
  for (const old of snapshots) {
    expect(sequence.startsWith(old.value)).toBe(true);
    expect([...old.value]).toEqual(flat.slice(0, old.length));
    expect(old.value.startsWith(sequence)).toBe(false);
  }
  expect(sequence.startsWith(Sequence.empty<number>().append([0, -1]))).toBe(false);
});

it('reads, appends, and copies indexed data across independent package copies', async () => {
  const packaged = await import('../dist/index.js');
  for (const [producer, consumer] of [
    [{ createData, appendData }, packaged],
    [packaged, { appendData, appendedPages, copyBuffers, locateSample, read }],
  ] as const) {
    const original = producer.createData(schema, 'first', [batch(0, 0)]);
    const next = consumer.appendData(original, 'next', [batch(1, 1)]);
    const pages = next.tables.node.fields.a;
    expect(consumer.locateSample(pages, 1)?.frame).toBe(1);
    expect([...consumer.appendedPages(original.tables.node.fields.a, pages)!]).toHaveLength(1);
    const copied = consumer.copyBuffers(next);
    expect(consumer.locateSample(copied.tables.node.fields.a, 1)?.frame).toBe(1);
    expect([...copied.tables.node.fields.a]).toHaveLength(2);
    const blocks = [];
    for await (const block of consumer.read(next, {
      kind: 'rows',
      from: 'node',
      select: ['a'],
      at: 1,
    }))
      if (block.kind === 'rows') blocks.push(block);
    expect(blocks).toHaveLength(1);
  }
});
