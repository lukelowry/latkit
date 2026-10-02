import { expect, it, vi } from 'vitest';
import { createReader } from '@latkit/model';
import type { Gpu } from '@latkit/gpu';
import { arrange, layoutOptions, place, rootEnd } from '../src/layout.js';
import { readScene } from '../src/read.js';
import { geometry, orthogonal, contains, boundary } from '../src/geometry.js';
import { resolveStyle, resolveLimits } from '../src/config.js';
import { data, Source, measure } from './fixture.js';
/** Arrangement only reads and measures text. */
const gpu = { reader: createReader(), measureText: measure } as unknown as Gpu;
import { Picking } from '../src/picking.js';
async function scene(source = new Source(), position = false) {
  const reader = gpu.reader.open();
  try {
    const result = await readScene(
      data(source, position),
      reader,
      resolveStyle(),
      resolveLimits(),
      measure,
    );
    await place(result, layoutOptions(), 8, reader.signal);
    await geometry(result, resolveStyle(), resolveLimits(), reader.signal);
    return result;
  } finally {
    reader.close();
  }
}
it('arranges native rows deterministically without GPU or DOM', async () => {
  const source = new Source(12),
    config = data(source);
  const a = await arrange(gpu, config),
    b = await arrange(gpu, config);
  expect(a).toEqual(b);
  expect(a.Task.index).toEqual(source.index('Task'));
  expect(a.Task.values.kind).toBe('vector');
  const result = await scene(source);
  for (let i = 0; i < result.vertices.length; i++)
    for (let j = i + 1; j < result.vertices.length; j++) {
      const a = result.vertices[i],
        b = result.vertices[j];
      expect(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
      ).toBe(true);
    }
});
it('joins every port whose reference names a net', async () => {
  const source = new Source(5);
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      ...Array.from({ length: 4 }, (_, i) => ({ vertex: i + 1, port: 'input' as const })),
    ],
  ];
  const result = await scene(source);
  expect(result.edges[0].ends.map((e) => e.vertex)).toEqual([0, 1, 2, 3, 4]);
  expect(result.edges[0].ends.map((e) => e.direction)).toEqual(['out', 'in', 'in', 'in', 'in']);
  expect(result.edges[0].ends.slice(1).every((e) => e.port === 'input')).toBe(true);
  expect(result.edges[0].arrows).toHaveLength(4);
});
it('draws each row between the vertices its two references name', async () => {
  const source = new Source(3),
    reader = gpu.reader.open();
  try {
    const d = data(source);
    const result = await readScene(
      { ...d, edges: { Dependency: { ...d.edges!.Dependency, ends: ['from', 'to'] } } },
      reader,
      resolveStyle(),
      resolveLimits(),
      measure,
    );
    await place(result, layoutOptions(), 8, reader.signal);
    await geometry(result, resolveStyle(), resolveLimits(), reader.signal);
    expect(result.edges.map((edge) => edge.ends)).toEqual([
      [
        { vertex: 0, port: null, direction: 'out' },
        { vertex: 1, port: null, direction: 'in' },
      ],
      [
        { vertex: 1, port: null, direction: 'out' },
        { vertex: 2, port: null, direction: 'in' },
      ],
    ]);
    // No net is drawn, so no reference field is a port.
    expect(result.vertices.every((vertex) => !vertex.ports.length)).toBe(true);
    expect(result.edges.every((edge) => edge.arrows.length === 1)).toBe(true);
  } finally {
    reader.close();
  }
});
it('rejects ends numbered against another row space than their vertices', async () => {
  const source = new Source(3);
  source.staleEnds = true;
  const d = data(source);
  await expect(
    arrange(gpu, { ...d, edges: { Dependency: { ...d.edges!.Dependency, ends: ['from', 'to'] } } }),
  ).rejects.toMatchObject({ code: 'conflict' });
});
it('rejects ports that are not reference columns', async () => {
  const source = new Source();
  source.malformed = true;
  await expect(scene(source)).rejects.toMatchObject({ code: 'invalid-input' });
});
it('honors sparse row selections and returns physical row identities', async () => {
  const source = new Source(),
    d = data(source);
  const result = await arrange(gpu, {
    ...d,
    vertices: { Task: { rows: { kind: 'ids', ids: ['n3', 'n1'] }, labels: 'name' } },
  });
  expect(result.Task.rows).toEqual({ kind: 'indices', values: Uint32Array.of(3, 1) });
});
it('handles cycles and self-loops', async () => {
  const source = new Source(4);
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      { vertex: 1, port: 'input' },
    ],
    [
      { vertex: 1, port: 'output' },
      { vertex: 2, port: 'input' },
    ],
    [
      { vertex: 2, port: 'output' },
      { vertex: 0, port: 'input' },
    ],
    [
      { vertex: 3, port: 'output' },
      { vertex: 3, port: 'input' },
    ],
  ];
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
  const vertex = result.vertices[0];
  vertex.shape = 'diamond';
  expect(contains(vertex, [vertex.x, vertex.y])).toBe(false);
  expect(boundary(vertex, [vertex.x + vertex.width * 2, vertex.y + vertex.height / 2])).toEqual([
    vertex.x + vertex.width,
    vertex.y + vertex.height / 2,
  ]);
  const picking = new Picking(result, 1e6),
    camera = {
      center: [vertex.x + vertex.width / 2, vertex.y + vertex.height / 2] as const,
      scale: [1, 1] as const,
      yDirection: 'down' as const,
    };
  expect(picking.hit([200, 150], camera, { width: 400, height: 300, pixelRatio: 2 }, 8)[0].id).toBe(
    'n0',
  );
});
it('supports headless custom layout and routing strategies', async () => {
  const source = new Source(2),
    d = data(source);
  const result = await arrange(gpu, {
    ...d,
    layout: {
      algorithm: { arrange: (graph) => graph.vertices.map((_, i) => [i * 500, 123] as const) },
    },
  });
  expect(result.Task.values.kind === 'vector' && [...result.Task.values.values.values]).toEqual([
    0, 123, 500, 123,
  ]);
});
it('bounds memory and honors cancellation', async () => {
  await expect(arrange(gpu, { ...data(new Source(10)), limits: { vertices: 2 } })).rejects.toThrow(
    /vertices/,
  );
  const controller = new AbortController();
  controller.abort();
  await expect(arrange(gpu, data(), { signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
});
it('keeps explicit positions and sizes', async () => {
  const source = new Source(3);
  const result = await scene(source, true);
  expect(result.vertices.map((n) => [n.x, n.y])).toEqual([
    [0, 0],
    [240, 0],
    [480, 0],
  ]);
});
it('collapses groups into proxies for their external ends', async () => {
  const source = new Source(3),
    reader = gpu.reader.open();
  try {
    const d = {
      ...data(source, true),
      groups: {
        box: {
          label: 'Pair',
          collapsed: true,
          vertices: { Task: { kind: 'ids' as const, ids: ['n0', 'n1'] } },
        },
      },
    };
    const result = await readScene(d, reader, resolveStyle(), resolveLimits(), measure);
    await place(result, layoutOptions(), 8, reader.signal);
    await geometry(result, resolveStyle(), resolveLimits(), reader.signal);
    expect(result.vertices.map((n) => n.visible)).toEqual([false, false, true]);
    expect(result.edges[0].paths).toHaveLength(0);
    expect(result.edges[1].paths.length).toBeGreaterThan(0);
    expect(result.groups[0].bounds[2] - result.groups[0].bounds[0]).toBeLessThan(200);
  } finally {
    reader.close();
  }
});

it('keeps labels apart when a net fans out beside other edges', async () => {
  const source = new Source(4);
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      { vertex: 1, port: 'input' },
      { vertex: 3, port: 'input' },
    ],
    [
      { vertex: 1, port: 'output' },
      { vertex: 2, port: 'input' },
    ],
  ];
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
it('prepares a thousand-vertex graph with bounded geometry and queries', async () => {
  const source = new Source(1000),
    result = await scene(source);
  expect(result.vertices.length).toBe(1000);
  expect(result.edges.length).toBe(999);
  expect(result.bytes).toBeLessThan(8 * 1024 ** 2);
  expect(source.queries).toBeLessThan(12);
});
it('cancels a large arrangement between CPU slices', async () => {
  const source = new Source(10000),
    controller = new AbortController();
  const promise = arrange(gpu, data(source), { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
});

it('enforces one preparation deadline across native reads and custom layout', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    await expect(
      arrange(gpu, {
        ...data(new Source()),
        limits: { layoutMs: 10 },
        layout: {
          algorithm: {
            arrange: (graph) => {
              now.mockReturnValue(11);
              return graph.vertices.map((_, i) => [i * 200, 0] as const);
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'resource-limit' });
  } finally {
    now.mockRestore();
  }
});

it('spreads feedback cycles across ranks, rooted at their outputs', async () => {
  const source = new Source(4);
  source.ends.push([
    { vertex: 3, port: 'output' },
    { vertex: 0, port: 'input' },
  ]);
  const result = await scene(source);
  expect(new Set(result.vertices.map((vertex) => vertex.x)).size).toBe(4);
  const feedback = result.edges.at(-1)!;
  expect(feedback.ends.map((end) => end.vertex)).toEqual([0, 3]);
  expect(feedback.ends[rootEnd(feedback)].vertex).toBe(3);
});
it('passes ports, hyperedges, labels and groups to a custom layout', async () => {
  const source = new Source(3);
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      { vertex: 1, port: 'input' },
      { vertex: 2, port: 'input' },
    ],
  ];
  const algorithm = {
    arrange: vi.fn((graph: import('../src/layout.js').LayoutGraph) => {
      expect(graph.vertices[0].ports.map((port) => port.name)).toContain('output');
      expect(graph.edges[0].ends).toHaveLength(3);
      expect(graph.edges[0].labelSize[0]).toBeGreaterThan(0);
      expect(graph.groups[0].members).toHaveLength(2);
      return graph.vertices.map((_, i) => [i * 240, 0] as const);
    }),
  };
  await arrange(gpu, {
    ...data(source),
    groups: { pair: { vertices: { Task: { kind: 'ids', ids: ['n0', 'n1'] } } } },
    layout: { algorithm },
  });
  expect(algorithm.arrange).toHaveBeenCalledOnce();
});
it('orients flow toward targets even when a wire runs left', async () => {
  const source = new Source(2);
  source.xy = Float64Array.of(400, 0, 0, 160);
  const result = await scene(source, true),
    edge = result.edges[0];
  const start = result.vertices[0].ports.find((port) => port.name === 'output')!.position;
  const first = edge.paths[edge.offsets.indexOf(0)];
  expect(first[0]).toEqual(start);
  const left = edge.paths.find((path) => path[0][0] > path[1][0]);
  expect(left).toBeDefined();
  expect(edge.offsets.every((distance) => distance >= 0)).toBe(true);
});
it('reconnects a wired input from the source of its net and rejects duplicate ends', async () => {
  const source = new Source(4);
  source.ends = [
    [
      { vertex: 1, port: 'input' },
      { vertex: 0, port: 'output' },
      { vertex: 2, port: 'input' },
    ],
  ];
  const result = await scene(source, true);
  const { ConnectSession } = await import('../src/connect.js');
  const gesture = new ConnectSession(
    result,
    { ...result.vertices[1].hit, kind: 'port', port: 'input' },
    16,
  );
  expect(gesture.start.from).toEqual({ type: 'Task', id: 'n0', port: 'output' });
  expect(gesture.start.replaces).toEqual({
    edge: { type: 'Dependency', id: 'e0' },
    end: { type: 'Task', id: 'n1', port: 'input' },
  });
  expect(gesture.accepts({ kind: 'port', type: 'Task', id: 'n2', port: 'input' })).toBe(false);
  expect(gesture.accepts({ kind: 'port', type: 'Task', id: 'n3', port: 'input' })).toBe(true);
  expect(gesture.accepts({ kind: 'port', type: 'Task', id: 'n3', port: 'output' })).toBe(false);
  const preview = gesture.preview([400, 200], null, new AbortController().signal);
  expect(preview[0]).toEqual(
    result.vertices[0].ports.find((port) => port.name === 'output')!.position,
  );
});

it('picks nearest first, the topmost item breaking ties', async () => {
  const result = await scene(new Source(2), true),
    port = result.vertices[0].ports.find((p) => p.name === 'output')!.position;
  const picking = new Picking(result, resolveLimits().pickingBytes),
    camera = { center: port, scale: [1, 1] as const, yDirection: 'down' as const },
    viewport = { width: 400, height: 300, pixelRatio: 1 };
  // Inside the vertex, beside its port: the vertex is nearer.
  const beside = picking.hit([192, 150], camera, viewport, 8).map((hit) => hit.kind);
  expect(beside.slice(0, 2)).toEqual(['vertex', 'port']);
  // On the port everything touches; the port draws over its vertex, which draws over the wire.
  const on = picking.hit([200, 150], camera, viewport, 8).map((hit) => hit.kind);
  expect(on[0]).toBe('port');
  expect(on.indexOf('vertex')).toBeLessThan(on.indexOf('edge'));
  expect(picking.nearest([200, 150], camera, viewport, 8, true, () => {})?.kind).toBe('port');
  expect(picking.hit([200, 150], camera, viewport, 8, false)[0].kind).not.toBe('port');
});
it('rejects unknown limits', async () => {
  await expect(
    arrange(gpu, { ...data(), limits: { prepareMs: 10 } as never }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  expect(resolveLimits({ layoutMs: 5 }).layoutMs).toBe(5);
});
it('expands field shorthands for headless arrangement', async () => {
  const source = new Source(3),
    d = data(source);
  const result = await arrange(gpu, {
    ...d,
    vertices: { Task: { labels: 'name', color: 'weight', ports: { input: { color: 'weight' } } } },
  });
  expect(result.Task.rows).toEqual({ kind: 'indices', values: Uint32Array.of(0, 1, 2) });
});
it('picks edge labels using their rendered bounds', async () => {
  const result = await scene(),
    edge = result.edges[0],
    box = edge.labelBounds[0];
  const picking = new Picking(result, resolveLimits().pickingBytes);
  const hit = picking.hit(
    [50, 50],
    { center: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], scale: [1, 1], yDirection: 'down' },
    { width: 100, height: 100, pixelRatio: 1 },
    0,
  );
  expect(hit.some((item) => item.kind === 'edge' && item.id === edge.hit.id)).toBe(true);
});
