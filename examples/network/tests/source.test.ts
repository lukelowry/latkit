import { expect, it } from 'vitest';
import {
  blockByteLength,
  validateBlock,
  validateSchema,
  type Query,
  read as readData,
  rowAt,
  rowCount,
  type Data,
  type QueryOptions,
  type QueryBlock,
} from '@latkit/model';
import { TOPOLOGIES } from '../src/topologies.js';

async function read(source: Data, query: Query, options?: QueryOptions): Promise<QueryBlock[]> {
  const schema = source.schema;
  expect(validateSchema(schema)).toEqual([]);
  const blocks: QueryBlock[] = [];
  for await (const block of readData(source, query, options)) {
    expect(validateBlock(schema, query, block, options)).toEqual([]);
    blocks.push(block);
  }
  return blocks;
}
it('generates valid native fields and wiring for every example, including 100k', async () => {
  for (const topology of TOPOLOGIES) {
    const source = topology.build();
    const count = (blocks: QueryBlock[]) =>
      blocks.reduce(
        (sum, b) => sum + (b.kind === 'rows' && b.rows.kind === 'range' ? b.rows.count : 0),
        0,
      );
    const buses = await read(source.data, {
      kind: 'rows',
      from: 'Bus',
      select: Object.keys(source.tables.Bus!.columns),
    });
    expect(count(buses)).toBe(source.tables.Bus!.count);
    const lines = await read(source.data, { kind: 'rows', from: 'Line', select: ['from', 'to'] });
    expect(count(lines)).toBe(source.tables.Line!.count);
    for (const block of lines)
      if (block.kind === 'rows')
        for (const end of ['from', 'to'])
          expect(block.columns[end]).toMatchObject({
            kind: 'reference',
            index: { source: source.source, type: 'Bus' },
          });
    if (source.tables.Line!.columns.bends)
      await read(source.data, { kind: 'rows', from: 'Line', select: ['bends'] });
  }
});
it('preserves requested physical identities and implements filtering, sorting, count and paging', async () => {
  const source = TOPOLOGIES[1]!.build();
  const selected = await read(source.data, {
    kind: 'rows',
    from: 'Bus',
    rows: { kind: 'ids', ids: ['Bus:5', 'Bus:1'] },
    select: ['position'],
    ids: true,
  });
  expect(
    selected.flatMap((b) =>
      b.kind === 'rows' ? Array.from({ length: rowCount(b.rows) }, (_, i) => rowAt(b.rows, i)) : [],
    ),
  ).toEqual([5, 1]);
  const filtered = await read(source.data, {
    kind: 'rows',
    from: 'Bus',
    select: ['load'],
    where: [{ field: 'load', operator: 'greaterThan', value: 0.5 }],
    orderBy: [{ field: 'load', direction: 'descending' }],
    offset: 2,
    limit: 4,
    count: true,
  });
  const values = filtered.flatMap((b) =>
    b.kind === 'rows' && b.columns.load?.kind === 'numeric'
      ? Array.from(b.columns.load.values)
      : [],
  );
  expect(values).toHaveLength(4);
  expect(values.every((v, i) => v > 0.5 && (!i || v <= values[i - 1]!))).toBe(true);
  const empty = await read(source.data, {
    kind: 'rows',
    from: 'Bus',
    select: [],
    where: [{ field: 'load', operator: 'greaterThan', value: 2 }],
    count: true,
  });
  expect(empty).toMatchObject([{ kind: 'rows', total: 0, rows: { count: 0 } }]);
  await expect(
    read(source.data, {
      kind: 'rows',
      from: 'Bus',
      select: [],
      rows: { kind: 'ids', ids: ['Bus:4294967296'] },
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
});
it('bounds native blocks and grants independent ownership only when requested', async () => {
  const source = TOPOLOGIES[0]!.build();
  for (const buffers of ['borrowed', 'owned'] as const) {
    const blocks = await read(
      source.data,
      { kind: 'rows', from: 'Bus', select: ['load'] },
      { buffers, maxBlockBytes: 700 },
    );
    expect(blocks.every((b) => blockByteLength(b) <= 700)).toBe(true);
    const first = blocks[0]!;
    if (first.kind !== 'rows' || first.columns.load?.kind !== 'numeric')
      throw new Error('Missing numeric data');
    const original = source.tables.Bus!.columns.load;
    if (original?.kind !== 'numeric') throw new Error('Missing original column');
    if (buffers === 'borrowed')
      expect(first.columns.load.values.buffer).toBe(original.values.buffer);
    else {
      const before = original.values[0];
      first.columns.load.values[0] = -5;
      expect(original.values[0]).toBe(before);
    }
  }
  await read(
    source.data,
    { kind: 'rows', from: 'Line', select: ['from', 'to'] },
    { buffers: 'owned', maxBlockBytes: 1200 },
  );
  await read(
    source.data,
    { kind: 'rows', from: 'Line', select: ['bends'] },
    { buffers: 'owned', maxBlockBytes: 700 },
  );
});
it('supports local cancellation without changing application data', async () => {
  const source = TOPOLOGIES[1]!.build(),
    value = source.data,
    stop = new AbortController();
  stop.abort();
  await expect(
    read(value, { kind: 'rows', from: 'Bus', select: ['load'] }, { signal: stop.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(
    (await read(value, { kind: 'rows', from: 'Bus', select: ['load'] })).length,
  ).toBeGreaterThan(0);
});
