import { expect, it } from 'vitest';
import {
  blockByteLength,
  validateBlock,
  validateSchema,
  type Query,
  type Queryable,
  type QueryOptions,
  type QueryBlock,
} from '@latkit/model';
import { TOPOLOGIES } from '../src/topologies.js';

async function read(
  source: Queryable,
  query: Query,
  options?: QueryOptions,
): Promise<QueryBlock[]> {
  const schema = await source.describe();
  expect(validateSchema(schema)).toEqual([]);
  const blocks: QueryBlock[] = [];
  let headers = 0;
  for await (const block of source.query(query, options)) {
    if (block.kind === 'schema') {
      headers++;
      continue;
    }
    expect(headers).toBe(1);
    expect(validateBlock(schema, query, block, options)).toEqual([]);
    blocks.push(block);
  }
  expect(headers).toBe(1);
  return blocks;
}
it('generates valid native fields and complete endpoints for every example, including 100k', async () => {
  for (const topology of TOPOLOGIES) {
    const source = topology.build();
    const nodes = await read(source, {
      kind: 'rows',
      from: 'node',
      select: Object.keys(source.tables.node!.columns),
    });
    expect(
      nodes.reduce(
        (sum, b) => sum + (b.kind === 'rows' && b.rows.kind === 'range' ? b.rows.count : 0),
        0,
      ),
    ).toBe(source.tables.node!.count);
    const edges = await read(source, { kind: 'endpoints', from: 'line' });
    expect(
      edges.reduce((sum, b) => sum + (b.kind === 'endpoints' ? b.connections.length : 0), 0),
    ).toBe(source.tables.line!.count);
    expect(
      edges.reduce((sum, b) => sum + (b.kind === 'endpoints' ? b.componentRow.length : 0), 0),
    ).toBe(source.tables.line!.count * 2);
    if (source.tables.line!.columns.bends)
      await read(source, { kind: 'rows', from: 'line', select: ['bends'] });
    await source.close();
  }
});
it('preserves requested physical identities and implements filtering, sorting, count and paging', async () => {
  const source = TOPOLOGIES[1]!.build();
  const selected = await read(source, {
    kind: 'rows',
    from: 'node',
    rows: { kind: 'ids', ids: ['node:5', 'node:1'] },
    select: ['position'],
    ids: true,
  });
  expect(
    selected.map((b) =>
      b.kind === 'rows' && b.rows.kind === 'range' ? [b.rows.offset, b.position] : null,
    ),
  ).toEqual([
    [5, 0],
    [1, 1],
  ]);
  const filtered = await read(source, {
    kind: 'rows',
    from: 'node',
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
  const empty = await read(source, {
    kind: 'rows',
    from: 'node',
    select: [],
    where: [{ field: 'load', operator: 'greaterThan', value: 2 }],
    count: true,
  });
  expect(empty).toMatchObject([{ kind: 'rows', total: 0, rows: { count: 0 } }]);
  await expect(
    read(source, {
      kind: 'rows',
      from: 'node',
      select: [],
      rows: { kind: 'ids', ids: ['node:4294967296'] },
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
});
it('bounds native blocks and grants independent ownership only when requested', async () => {
  const source = TOPOLOGIES[0]!.build();
  for (const buffers of ['borrowed', 'owned'] as const) {
    const blocks = await read(
      source,
      { kind: 'rows', from: 'node', select: ['load'] },
      { buffers, maxBlockBytes: 700 },
    );
    expect(blocks.every((b) => blockByteLength(b) <= 700)).toBe(true);
    const first = blocks[0]!;
    if (first.kind !== 'rows' || first.columns.load?.kind !== 'numeric')
      throw new Error('Missing numeric data');
    const original = source.tables.node!.columns.load;
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
    source,
    { kind: 'endpoints', from: 'line' },
    { buffers: 'owned', maxBlockBytes: 1200 },
  );
  await read(
    source,
    { kind: 'rows', from: 'line', select: ['bends'] },
    { buffers: 'owned', maxBlockBytes: 700 },
  );
});
it('retained acquisitions survive closing their origin and enforce admission', async () => {
  const source = TOPOLOGIES[1]!.build();
  await expect(source.retain({ maxBytes: 1 })).rejects.toMatchObject({ code: 'resource-limit' });
  const retained = await source.retain();
  const query = { kind: 'rows' as const, from: 'node', select: ['load'] };
  const pending = source.query(query)[Symbol.asyncIterator]();
  await pending.next();
  await source.close();
  await expect(pending.next()).rejects.toMatchObject({ code: 'closed' });
  expect((await read(retained, query)).length).toBeGreaterThan(0);
  const controller = new AbortController();
  controller.abort();
  await expect(read(retained, query, { signal: controller.signal })).rejects.toThrow();
  await retained.close();
});
