import { expect, it } from 'vitest';
import { blockByteLength, validateBlock, validateSchema, textAt } from '@latkit/model';
import type { Query, Queryable } from '@latkit/model';
import type { Gpu } from '@latkit/gpu';
import { arrange } from '@latkit/diagram';
import { GraphSource } from '../src/source.js';
import {
  plugged,
  ports,
  preset,
  schema,
  types,
  History,
  connectGraph,
  deleteItems,
} from '../src/graph.js';
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
it('supplies conforming native rows and wiring for every scene', async () => {
  expect(validateSchema(schema)).toEqual([]);
  for (const which of ['loop', 'groups', 'shapes', 'scale'] as const) {
    const source = new GraphSource(preset(which));
    for (const type of types)
      await collect(source, {
        kind: 'rows',
        from: type,
        select: ['name', 'position', 'signal', 'status', 'visible', ...Object.keys(ports[type])],
        ids: true,
      });
    await collect(source, { kind: 'rows', from: 'Signal', select: ['name', 'signal'], ids: true });
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
it('plugs an input into the wire its output drives, keeps fan-out, and supports history', () => {
  const graph = preset('loop'),
    history = new History(graph);
  const next = connectGraph(graph, {
    from: { type: 'Process', id: 'actuator', port: 'out' },
    to: { kind: 'vertex', type: 'Output', id: 'response', port: 'in' },
    position: [0, 0],
    point: [0, 0],
  });
  history.commit(next);
  const drive = graph.wires.find((wire) => wire.name === 'Drive')!;
  expect(next.blocks.find((block) => block.id === 'response')!.ports.in).toBe(drive.id);
  expect(plugged(next, drive.id)).toHaveLength(3);
  expect(history.undo()).toBe(graph);
  expect(history.redo()).toBe(next);
  const removed = deleteItems(graph, ['sensor']),
    measured = removed.wires.find((wire) => wire.name === 'Measured')!;
  expect(plugged(removed, measured.id)).toHaveLength(2);
  // Feedback lost its driver: the wire goes, and the controller port is unplugged.
  expect(removed.wires.some((wire) => wire.name === 'Feedback')).toBe(false);
  expect(removed.blocks.find((block) => block.id === 'controller')!.ports.feedback).toBeNull();
});
it('wires an input to a new driving block, or plugs it into an existing wire', async () => {
  const graph = preset('shapes');
  const gesture = {
    from: { type: 'Control', id: 'diamond', port: 'feedback' },
    position: [700, 0] as const,
    point: [700, 0] as const,
  };
  const free = connectGraph(graph, { ...gesture, to: null }, true);
  const added = free.wires.at(-1)!;
  expect(free.wires).toHaveLength(graph.wires.length + 1);
  expect(plugged(free, added.id)).toEqual([
    { id: 'diamond', port: 'feedback' },
    { id: free.blocks.at(-1)!.id, port: 'out' },
  ]);
  const join = {
    ...gesture,
    to: { kind: 'edge' as const, type: 'Signal', id: graph.wires[0].id },
  };
  const joined = connectGraph(graph, join);
  expect(plugged(joined, graph.wires[0].id)).toContainEqual({ id: 'diamond', port: 'feedback' });
  expect(plugged(connectGraph(joined, join), graph.wires[0].id)).toHaveLength(3);
  for (const changed of [free, joined]) {
    const source = new GraphSource(changed);
    await collect(source, { kind: 'rows', from: 'Control', select: ['feedback'] });
    await source.close();
  }
});
it('arranges through the new public headless API', async () => {
  const source = new GraphSource(preset('loop'));
  // Arrangement only measures text.
  const gpu = {
    measureText: (input: { text: string }) =>
      Promise.resolve({ advance: input.text.length * 0.6, ascent: 0.8, descent: 0.2 }),
  } as unknown as Gpu;
  const result = await arrange(
    gpu,
    data(
      source,
      {
        shape: 'rounded',
        route: 'orthogonal',
        appearance: 'wire',
        palette: 'neutral',
        light: false,
        density: 'comfortable',
        titlePosition: 'header',
        overflow: 'wrap',
        flow: false,
        arrows: true,
        status: true,
        labels: true,
      },
      true,
    ),
  );
  expect(Object.keys(result)).toEqual(
    expect.arrayContaining(['Process', 'Control', 'Input', 'Output']),
  );
  await source.close();
});

it('requires explicit creation on empty drop and disconnects a replaced branch without deleting siblings', () => {
  const graph = preset('loop');
  const free = {
    from: { type: 'Process', id: 'plant', port: 'out' },
    to: null,
    position: [0, 0] as const,
    point: [0, 0] as const,
  };
  expect(connectGraph(graph, free)).toBe(graph);
  const branch = graph.wires.find((wire) => wire.name === 'Measured')!;
  const next = connectGraph(graph, {
    ...free,
    replaces: {
      edge: { type: 'Signal', id: branch.id },
      end: { type: 'Output', id: 'response', port: 'in' },
    },
  });
  expect(plugged(next, branch.id)).toEqual([
    { id: 'plant', port: 'out' },
    { id: 'sensor', port: 'in' },
  ]);
  expect(next.blocks.find((block) => block.id === 'response')!.ports.in).toBeNull();
});
