import { expect, it, vi } from 'vitest';
import { createNativeReader } from '@latkit/gpu';
import { arrange, layoutOptions, place } from '../src/layout.js';
import { readScene } from '../src/read.js';
import { geometry, orthogonal, contains, boundary } from '../src/geometry.js';
import { options, limits } from '../src/config.js';
import { data, Source, measure } from './fixture.js';
import { Picking } from '../src/picking.js';
async function scene(source = new Source(), position = false) {
  const reader = createNativeReader();
  try {
    const result = await readScene(data(source, position), reader, options(), limits(), measure);
    await place(result, layoutOptions(), 8, reader.signal);
    await geometry(result, options(), limits(), reader.signal);
    reader.check();
    return result;
  } finally {
    reader.destroy();
  }
}
it('arranges native rows deterministically without GPU or DOM', async () => {
  const source = new Source(12),
    input = { data: data(source), measureText: measure };
  const a = await arrange(input),
    b = await arrange(input);
  expect(a).toEqual(b);
  expect(a.Task.index).toEqual(source.index('Task'));
  expect(a.Task.values.kind).toBe('vector');
  const result = await scene(source);
  for (let i = 0; i < result.nodes.length; i++)
    for (let j = i + 1; j < result.nodes.length; j++) {
      const a = result.nodes[i],
        b = result.nodes[j];
      expect(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
      ).toBe(true);
    }
});
it('assembles split hyperedges with block-local port dictionaries', async () => {
  const source = new Source(5);
  source.split = 1;
  source.ends = [
    [
      { node: 0, port: 'output', role: 'source' },
      ...Array.from({ length: 4 }, (_, i) => ({ node: i + 1, port: 'input', role: 'target' })),
    ],
  ];
  const result = await scene(source);
  expect(result.edges[0].endpoints).toHaveLength(5);
  expect(result.edges[0].endpoints.map((e) => e.ordinal)).toEqual([0, 1, 2, 3, 4]);
  expect(result.edges[0].endpoints.slice(1).every((e) => e.port === 'input')).toBe(true);
  expect(result.edges[0].arrows).toHaveLength(4);
});
it('rejects incomplete endpoint sequences', async () => {
  const source = new Source();
  source.malformed = true;
  await expect(scene(source)).rejects.toMatchObject({ code: 'invalid-input' });
});
it('honors sparse row selections and returns physical row identities', async () => {
  const source = new Source(),
    d = data(source);
  const result = await arrange({
    data: {
      ...d,
      components: { Task: { rows: { kind: 'ids', ids: ['n3', 'n1'] }, labels: { field: 'name' } } },
    },
    measureText: measure,
  });
  expect(result.Task.rows).toEqual({ kind: 'indices', values: Uint32Array.of(3, 1) });
});
it('handles cycles and self-loops', async () => {
  const source = new Source(3);
  source.ends.push(
    [
      { node: 2, port: 'output', role: 'source' },
      { node: 0, port: 'input', role: 'target' },
    ],
    [
      { node: 1, port: 'output', role: 'source' },
      { node: 1, port: 'input', role: 'target' },
    ],
  );
  const result = await scene(source);
  expect(result.edges.every((e) => e.paths.length > 0)).toBe(true);
});
it('routes around obstacles', () => {
  const path = orthogonal([0, 0], [200, 0], [[80, -30, 120, 30]], 16, new AbortController().signal);
  expect(path.length).toBeGreaterThan(2);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
    if (a[1] === b[1] && Math.min(a[0], b[0]) < 120 && Math.max(a[0], b[0]) > 80)
      expect(Math.abs(a[1])).toBeGreaterThanOrEqual(30);
  }
});
it('uses identical geometry for shape boundaries and picking', async () => {
  const result = await scene(new Source(1));
  const node = result.nodes[0];
  node.shape = 'diamond';
  expect(contains(node, [node.x, node.y])).toBe(false);
  expect(boundary(node, [node.x + node.width * 2, node.y + node.height / 2])).toEqual([
    node.x + node.width,
    node.y + node.height / 2,
  ]);
  const picking = new Picking(result, 1e6),
    camera = {
      center: [node.x + node.width / 2, node.y + node.height / 2] as const,
      scale: [1, 1] as const,
      yDirection: 'down' as const,
    };
  expect(
    picking.hit([200, 150], camera, { width: 400, height: 300, pixelRatio: 2 }, 8).items[0].id,
  ).toBe('n0');
});
it('supports headless custom layout and routing strategies', async () => {
  const source = new Source(2),
    d = data(source);
  const result = await arrange({
    data: d,
    measureText: measure,
    layout: {
      algorithm: { arrange: (graph) => graph.nodes.map((_, i) => [i * 500, 123] as const) },
    },
  });
  expect(result.Task.values.kind === 'vector' && [...result.Task.values.values.values]).toEqual([
    0, 123, 500, 123,
  ]);
});
it('bounds memory and honors cancellation', async () => {
  await expect(
    arrange({ data: data(new Source(10)), measureText: measure, limits: { components: 2 } }),
  ).rejects.toThrow(/components/);
  const controller = new AbortController();
  controller.abort();
  await expect(
    arrange({ data: data(), measureText: measure, signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
});
it('keeps explicit positions and sizes', async () => {
  const source = new Source(3);
  const result = await scene(source, true);
  expect(result.nodes.map((n) => [n.x, n.y])).toEqual([
    [0, 0],
    [240, 0],
    [480, 0],
  ]);
});
it('collapses groups into external endpoint proxies', async () => {
  const source = new Source(3),
    reader = createNativeReader();
  try {
    const d = {
      ...data(source, true),
      groups: {
        box: {
          label: 'Pair',
          collapsed: true,
          components: { Task: { kind: 'ids' as const, ids: ['n0', 'n1'] } },
        },
      },
    };
    const result = await readScene(d, reader, options(), limits(), measure);
    await place(result, layoutOptions(), 8, reader.signal);
    await geometry(result, options(), limits(), reader.signal);
    expect(result.nodes.map((n) => n.visible)).toEqual([false, false, true]);
    expect(result.edges[0].paths).toHaveLength(0);
    expect(result.edges[1].paths.length).toBeGreaterThan(0);
    expect(result.groups[0].bounds[2] - result.groups[0].bounds[0]).toBeLessThan(200);
  } finally {
    reader.destroy();
  }
});

it('keeps labels apart when connections share a source port', async () => {
  const source = new Source(4);
  source.ends.push([
    { node: 0, port: 'output', role: 'source' },
    { node: 3, port: 'input', role: 'target' },
  ]);
  const result = await scene(source);
  for (let i = 0; i < result.edges.length; i++)
    for (let j = i + 1; j < result.edges.length; j++) {
      const a = result.edges[i],
        b = result.edges[j];
      if (!a.paths.length || !b.paths.length) continue;
      const ax = a.anchor[0] + 4,
        ay = a.anchor[1] - a.label.height - 4,
        bx = b.anchor[0] + 4,
        by = b.anchor[1] - b.label.height - 4;
      expect(
        ax + a.label.width <= bx ||
          bx + b.label.width <= ax ||
          ay + a.label.height <= by ||
          by + b.label.height <= ay,
      ).toBe(true);
    }
});
it('prepares a thousand-component graph with bounded geometry and queries', async () => {
  const source = new Source(1000),
    result = await scene(source);
  expect(result.nodes.length).toBe(1000);
  expect(result.edges.length).toBe(999);
  expect(result.bytes).toBeLessThan(8 * 1024 ** 2);
  expect(source.queries).toBeLessThan(12);
});
it('cancels a large arrangement between CPU slices', async () => {
  const source = new Source(10000),
    controller = new AbortController();
  const promise = arrange({ data: data(source), measureText: measure, signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
});

it('enforces one preparation deadline across native reads and custom layout', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    await expect(
      arrange({
        data: data(new Source()),
        measureText: measure,
        limits: { prepareMs: 10 },
        layout: {
          algorithm: {
            arrange: (graph) => {
              now.mockReturnValue(11);
              return graph.nodes.map((_, i) => [i * 200, 0] as const);
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'resource-limit' });
  } finally {
    now.mockRestore();
  }
});
