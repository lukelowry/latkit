import { expect, it, vi } from 'vitest';
import { Work, createReader } from '@latkit/model';
import type { Gpu } from '@latkit/gpu';
import { arrange, layoutOptions, place, rootEnd } from '../src/layout.js';
import { readScene } from '../src/read.js';
import { geometry, contains, boundary, labelBox } from '../src/geometry.js';
import { resolveStyle, resolveLimits } from '../src/config.js';
import { data, edge as edgeOf, port, Source, layoutText } from './fixture.js';
/** Arrangement only reads and measures text. */
const gpu = { reader: createReader(), layoutText } as unknown as Gpu;
import { Routing } from '../src/route.js';
import { rect, itemAt, itemSlots } from '../src/scene.js';
import { Picking } from '../src/picking.js';
async function scene(source = new Source(), position = false) {
  const reader = gpu.reader.open();
  try {
    const result = await readScene(
      data(source, position),
      reader,
      resolveStyle(),
      resolveLimits(),
      layoutText,
    );
    await place(result, layoutOptions(), resolveStyle(), new Work(reader.signal));
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
  expect(a.Task.x.index).toEqual(source.index('Task'));
  expect(a.Task.y.values.kind).toBe('numeric');
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
it('numbers vertices, ports, edges, and groups in disjoint scene slots', async () => {
  const result = await scene();
  const slots = itemSlots(result);
  expect(new Set(slots.values()).size).toBe(result.slots.count);
  for (let i = 0; i < result.slots.count; i++) expect(itemAt(result, i)).not.toBeNull();
  result.vertices.forEach((vertex, i) => {
    expect(itemAt(result, i)).toBe(vertex.hit);
    vertex.ports.forEach((port, j) =>
      expect(itemAt(result, vertex.portSlot + j)).toMatchObject({
        kind: 'port',
        row: vertex.row,
        port: port.name,
      }),
    );
  });
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
  expect(result.edges[0].arrows).toHaveLength(0);
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
      layoutText,
    );
    await place(result, layoutOptions(), resolveStyle(), new Work(reader.signal));
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
  expect(result.Task.x.rows).toEqual({ kind: 'indices', values: Uint32Array.of(3, 1) });
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
it('routes around obstacles', async () => {
  const result = await scene(new Source(1), true),
    [x0, y0, x1, y1] = rect(result.vertices[0]),
    y = (y0 + y1) / 2;
  const path = new Routing(result, resolveStyle(), new AbortController().signal).between(
    [x0 - 60, y],
    [x1 + 60, y],
  );
  expect(path.length).toBeGreaterThan(2);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
    if (a[1] === b[1] && Math.min(a[0], b[0]) < x1 && Math.max(a[0], b[0]) > x0)
      expect(a[1] <= y0 || a[1] >= y1).toBe(true);
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
  expect(
    picking.hit([200, 150], camera, { width: 400, height: 300, pixelRatio: 2 }, 8)[0],
  ).toMatchObject({ kind: 'vertex', row: 0 });
});
it('arranges each part with a custom strategy, then packs the parts', async () => {
  const source = new Source(2),
    d = data(source);
  const result = await arrange(gpu, {
    ...d,
    layout: {
      algorithm: { arrange: (part) => part.vertices.map((_, i) => [i * 500, 123] as const) },
    },
  });
  const lane = (axis: 'x' | 'y') => {
    const values = result.Task[axis].values;
    return values.kind === 'numeric' ? [...values.values] : [];
  };
  // The strategy places within its part; packing puts the part at the origin.
  expect([lane('x'), lane('y')]).toEqual([
    [0, 500],
    [3, 3],
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
    const result = await readScene(d, reader, resolveStyle(), resolveLimits(), layoutText);
    await place(result, layoutOptions(), resolveStyle(), new Work(reader.signal));
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
      const ax = a.labels[0][0],
        ay = a.labels[0][1],
        bx = b.labels[0][0],
        by = b.labels[0][1];
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
it('passes ports, hyperedges, labels, and groups as vertices to a custom layout', async () => {
  const source = new Source(3);
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      { vertex: 1, port: 'input' },
      { vertex: 2, port: 'input' },
    ],
  ];
  const parts: import('../src/layout.js').LayoutGraph[] = [];
  const algorithm = {
    arrange: vi.fn((part: import('../src/layout.js').LayoutGraph) => {
      parts.push(part);
      return part.vertices.map((_, i) => [i * 240, 0] as const);
    }),
  };
  await arrange(gpu, {
    ...data(source),
    groups: { pair: { vertices: { Task: { kind: 'ids', ids: ['n0', 'n1'] } } } },
    layout: { algorithm },
  });
  // The group's inside is one part, wired port to port; outside, the group is one vertex.
  const [inside, outside] = parts;
  expect(inside.vertices.map((vertex) => vertex.item)).toMatchObject([
    { kind: 'vertex', row: 0 },
    { kind: 'vertex', row: 1 },
  ]);
  expect(inside.vertices[0].ports.find((port) => port.name === 'output')?.offset[0]).toBe(
    inside.vertices[0].size[0],
  );
  expect(inside.edges[0].ends).toEqual([
    { vertex: 0, port: 'output', direction: 'out' },
    { vertex: 1, port: 'input', direction: 'in' },
  ]);
  expect(inside.edges[0].labelSize[0]).toBeGreaterThan(0);
  expect(outside.vertices.map((vertex) => vertex.item)).toMatchObject([
    { kind: 'vertex', row: 2 },
    { kind: 'group', id: 'pair' },
  ]);
  expect(outside.vertices[1].ports).toEqual([]);
  // The net's three ends meet the group once for its two members.
  expect(outside.edges[0].ends).toEqual([
    { vertex: 1, port: null, direction: 'out' },
    { vertex: 1, port: null, direction: 'in' },
    { vertex: 0, port: 'input', direction: 'in' },
  ]);
  expect(algorithm.arrange).toHaveBeenCalledTimes(2);
});
it('orients flow toward targets even when a wire runs left', async () => {
  const source = new Source(2);
  source.xy = Float64Array.of(400, 0, 0, 160);
  const result = await scene(source, true),
    edge = result.edges[0];
  const port = result.vertices[0].ports.find((port) => port.name === 'output')!;
  const start = port.position.map((v, i) => v + (port.normal[i] * resolveStyle().portSize) / 2);
  const first = edge.paths[edge.offsets.indexOf(0)];
  expect(first[0]).toEqual(start);
  expect(edge.paths.some((path) => path.some((p, i) => i > 0 && path[i - 1][0] > p[0]))).toBe(true);
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
    resolveStyle(),
  );
  expect(gesture.start.from).toEqual(port(source, 'n0', 'output'));
  expect(gesture.start.replaces).toEqual({
    edge: edgeOf(source, 'e0'),
    end: port(source, 'n1', 'input'),
  });
  expect(gesture.accepts(port(source, 'n2', 'input'))).toBe(false);
  expect(gesture.accepts(port(source, 'n3', 'input'))).toBe(true);
  expect(gesture.accepts(port(source, 'n3', 'output'))).toBe(false);
  // The preview leaves its port where a routed wire does.
  const preview = gesture.preview([400, 200], null, new AbortController().signal),
    out = result.vertices[0].ports.find((port) => port.name === 'output')!;
  expect(preview[0]).toEqual(
    out.position.map((v, i) => v + (out.normal[i] * resolveStyle().portSize) / 2),
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
  expect(picking.nearest([200, 150], camera, viewport, 8, true, () => {}, 1.5)?.kind).toBe('port');
  expect(picking.hit([200, 150], camera, viewport, 8, false)[0].kind).not.toBe('port');
});
it('rejects unknown limits', async () => {
  await expect(
    arrange(gpu, { ...data(), limits: { prepareMs: 10 } as never }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  expect(resolveLimits({ layoutMs: 5 }).layoutMs).toBe(5);
});
it('arranges headlessly with channels bound to fields', async () => {
  const source = new Source(3),
    d = data(source);
  const result = await arrange(gpu, {
    ...d,
    vertices: { Task: { labels: 'name', color: 'weight', ports: { input: { color: 'weight' } } } },
  });
  expect(result.Task.y.rows).toEqual({ kind: 'indices', values: Uint32Array.of(0, 1, 2) });
});
it('picks edge labels using their rendered bounds', async () => {
  const result = await scene(),
    edge = result.edges[0],
    box = labelBox(edge, edge.labels[0]);
  const picking = new Picking(result, resolveLimits().pickingBytes);
  const hit = picking.hit(
    [50, 50],
    { center: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], scale: [1, 1], yDirection: 'down' },
    { width: 100, height: 100, pixelRatio: 1 },
    0,
  );
  expect(hit.some((item) => item.kind === 'edge' && item.row === edge.hit.row)).toBe(true);
});
