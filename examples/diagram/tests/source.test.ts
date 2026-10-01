import { expect, it } from 'vitest';
import { blockByteLength, validateBlock, validateSchema, textAt } from '@latkit/model';
import type { Query, Queryable } from '@latkit/model';
import { arrange } from '@latkit/diagram';
import { GraphSource } from '../src/source.js';
import { preset, schema, History, connectGraph, deleteItems } from '../src/graph.js';
import { data } from '../src/presentation.js';
async function collect(source: Queryable, query: Query, maxBlockBytes = 2048) {
  const result = [];
  for await (const block of source.query(query, { maxBlockBytes })) {
    if (block.kind !== 'schema') {
      expect(validateBlock(schema, query, block, { maxBlockBytes })).toEqual([]);
      expect(blockByteLength(block)).toBeLessThanOrEqual(maxBlockBytes);
      result.push(block);
    }
  }
  return result;
}
it('supplies conforming native rows and endpoint blocks for every scene', async () => {
  expect(validateSchema(schema)).toEqual([]);
  for (const which of ['loop', 'groups', 'shapes', 'scale'] as const) {
    const source = new GraphSource(preset(which));
    for (const type of Object.keys(schema.components))
      await collect(source, {
        kind: 'rows',
        from: type,
        select: ['name', 'position', 'signal', 'status', 'visible'],
        ids: true,
      });
    await collect(source, { kind: 'endpoints', from: 'Signal' });
    await source.close();
  }
});
it('retains independent versions and coherent iterators during replacement', async () => {
  const source = new GraphSource(preset('loop')),
    retained = await source.retain();
  const query = { kind: 'rows' as const, from: 'Process', select: ['name'], ids: true };
  const read = source.query(query)[Symbol.asyncIterator]();
  await read.next();
  source.publish(preset('shapes'));
  const result = await read.next();
  expect(result.value?.kind).toBe('rows');
  if (!result.done && result.value.kind === 'rows')
    expect(textAt(result.value.ids!, 0)).toBe('actuator');
  await read.return?.();
  await source.close();
  expect((await collect(retained, query)).length).toBeGreaterThan(0);
  await retained.close();
});
it('supports filtering, ordering, sparse IDs, counts and cancellation', async () => {
  const source = new GraphSource(preset('loop'));
  const blocks = await collect(source, {
    kind: 'rows',
    from: 'Process',
    select: ['name'],
    ids: true,
    count: true,
    rows: { kind: 'ids', ids: ['sensor', 'plant'] },
    where: [{ field: 'name', operator: 'contains', value: 'n' }],
    orderBy: [{ field: 'name', direction: 'ascending' }],
    limit: 1,
  });
  expect(blocks[0]).toMatchObject({ total: 2 });
  if (blocks[0].kind === 'rows') expect(textAt(blocks[0].ids!, 0)).toBe('plant');
  const controller = new AbortController();
  controller.abort();
  await expect(
    source
      .query({ kind: 'rows', from: 'Process', select: [] }, { signal: controller.signal })
      [Symbol.asyncIterator]()
      .next(),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await source.close();
});
it('applies connection proposals, preserves hyperedges, and supports history', () => {
  const graph = preset('loop'),
    history = new History(graph);
  const next = connectGraph(graph, {
    from: { type: 'Process', id: 'actuator', port: 'out' },
    to: { kind: 'component', type: 'Output', id: 'response', port: 'in' },
    position: [0, 0],
    point: [0, 0],
  });
  history.commit(next);
  expect(history.current.wires.length).toBe(graph.wires.length + 1);
  expect(history.undo()).toBe(graph);
  expect(history.redo()).toBe(next);
  const removed = deleteItems(graph, ['sensor']);
  expect(removed.wires.find((wire) => wire.name === 'Measured')!.ends).toHaveLength(2);
  expect(removed.wires.some((wire) => wire.name === 'Feedback')).toBe(false);
});
it('connects an input to a free endpoint or existing wire with the correct role', async () => {
  const graph = preset('shapes');
  const gesture = {
    from: { type: 'Control', id: 'diamond', port: 'feedback' },
    position: [700, 0] as const,
    point: [700, 0] as const,
  };
  const free = connectGraph(graph, { ...gesture, to: null });
  expect(free.wires.at(-1)?.ends).toEqual([
    { id: 'diamond', port: 'feedback', role: 'target' },
    { id: free.nodes.at(-1)!.id, port: 'out', role: 'source' },
  ]);
  const join = {
    ...gesture,
    to: { kind: 'connection' as const, type: 'Signal', id: graph.wires[0].id },
  };
  const joined = connectGraph(graph, join);
  expect(joined.wires[0].ends.at(-1)).toEqual({
    id: 'diamond',
    port: 'feedback',
    role: 'target',
  });
  expect(connectGraph(joined, join).wires[0].ends).toHaveLength(3);
  for (const changed of [free, joined]) {
    const source = new GraphSource(changed);
    await collect(source, { kind: 'endpoints', from: 'Signal' });
    await source.close();
  }
});
it('arranges through the new public headless API', async () => {
  const source = new GraphSource(preset('loop'));
  const result = await arrange({
    data: data(
      source,
      {
        shape: 'rounded',
        route: 'orthogonal',
        appearance: 'wire',
        palette: 'neutral',
        flow: false,
        arrows: true,
        status: true,
        labels: true,
      },
      true,
    ),
    measureText: (input) =>
      Promise.resolve({ advance: input.text.length * 0.6, ascent: 0.8, descent: 0.2 }),
  });
  expect(Object.keys(result)).toEqual(
    expect.arrayContaining(['Process', 'Control', 'Input', 'Output']),
  );
  await source.close();
});
