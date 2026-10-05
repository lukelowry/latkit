import { expect, it, vi } from 'vitest';
import { Work } from '@latkit/model';
import { Graph, layoutOptions, place, type LayoutInput } from '../src/kit.js';
import type { LayoutOptions } from '../src/index.js';

/** A graph from edges as vertex lists. */
function graph(count: number, edges: readonly (readonly number[])[]): Graph {
  const offsets = new Uint32Array(edges.length + 1);
  edges.forEach((e, i) => (offsets[i + 1] = offsets[i] + e.length));
  return new Graph(count, { offsets, items: Uint32Array.from(edges.flat()) });
}
/** A w × h lattice, as a meshed grid is. */
function lattice(w: number, h: number): Graph {
  const edges: number[][] = [];
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      if (c + 1 < w) edges.push([r * w + c, r * w + c + 1]);
      if (r + 1 < h) edges.push([r * w + c, (r + 1) * w + c]);
    }
  return graph(w * h, edges);
}
const free = (count: number) => new Float64Array(count * 2).fill(NaN);
const input = (pinned: Float64Array, extra: Partial<LayoutInput> = {}): LayoutInput => ({
  pinned,
  item: (vertex) => ({ kind: 'group', id: String(vertex) }),
  ...extra,
});
const options = (layout: LayoutOptions = {}) =>
  layoutOptions(layout, { algorithm: 'stress', vertexGap: 1, rankGap: 3 });
const run = (g: Graph, i: LayoutInput, layout?: LayoutOptions) =>
  place(g, i, options(layout), new Work(new AbortController().signal));
/** Each edge's length. */
function lengths(g: Graph, at: Float64Array): number[] {
  const out: number[] = [];
  for (let e = 0; e < g.edgeCount; e++) {
    const [a, b] = g.endsOf(e);
    out.push(Math.hypot(at[a * 2] - at[b * 2], at[a * 2 + 1] - at[b * 2 + 1]));
  }
  return out;
}

it('indexes each vertex edges and finds parts in order of their first vertex', () => {
  // Two parts, an isolated vertex, and an edge without ends.
  const g = graph(6, [[0, 1], [1, 2], [], [4, 3]]);
  expect([...g.edgesOf(1)]).toEqual([0, 1]);
  expect([...g.endsOf(3)]).toEqual([4, 3]);
  const { count, vertices, edges, of } = g.parts;
  expect(count).toBe(3);
  expect([...of]).toEqual([0, 0, 0, 1, 1, 2]);
  expect([...vertices.items.subarray(vertices.offsets[1], vertices.offsets[2])]).toEqual([3, 4]);
  expect([...edges.items.subarray(edges.offsets[0], edges.offsets[1])]).toEqual([0, 1]);
  expect(edges.offsets[3] - edges.offsets[2]).toBe(0);
  expect(g.bytes).toBeGreaterThan(0);
});

it('keeps a mesh even under stress: edges near their length, no vertex on another', async () => {
  const g = lattice(30, 30),
    at = await run(g, input(free(900)));
  expect([...at].every(Number.isFinite)).toBe(true);
  const sorted = lengths(g, at).sort((a, b) => a - b);
  expect(sorted[sorted.length >> 1]).toBeGreaterThan(0.7);
  expect(sorted[sorted.length >> 1]).toBeLessThan(1.4);
  let nearest = Infinity;
  for (let a = 0; a < 900; a++)
    for (let b = a + 1; b < 900; b++)
      nearest = Math.min(nearest, Math.hypot(at[a * 2] - at[b * 2], at[a * 2 + 1] - at[b * 2 + 1]));
  expect(nearest).toBeGreaterThan(0.3);
  // The same graph arranges the same way every time.
  expect([...(await run(g, input(free(900))))]).toEqual([...at]);
});

it('spreads a large net around its first end instead of joining every pair', async () => {
  const g = graph(2001, [Array.from({ length: 2001 }, (_, i) => i)]),
    at = await run(g, input(free(2001)));
  expect([...at].every(Number.isFinite)).toBe(true);
  const reach = Array.from({ length: 2000 }, (_, i) =>
    Math.hypot(at[(i + 1) * 2] - at[0], at[(i + 1) * 2 + 1] - at[1]),
  ).sort((a, b) => a - b);
  expect(reach[1000]).toBeGreaterThan(0.5);
  expect(reach[1000]).toBeLessThan(4);
});

it('places free vertices among pinned ones, and leaves the pinned where they are', async () => {
  // A path from a pin at 0 to a pin at 10.
  const g = graph(
      11,
      Array.from({ length: 10 }, (_, i) => [i, i + 1]),
    ),
    pinned = free(11);
  pinned.set([0, 0], 0);
  pinned.set([10, 0], 20);
  const at = await run(g, input(pinned));
  expect([at[0], at[1], at[20], at[21]]).toEqual([0, 0, 10, 0]);
  for (let i = 1; i < 10; i++) {
    expect(at[i * 2]).toBeGreaterThan(at[(i - 1) * 2]);
    expect(Math.abs(at[i * 2 + 1])).toBeLessThan(2);
  }
});

it('packs parts nothing pins in rows below the pinned ones', async () => {
  // A pinned pair, then three loose pairs and a lone vertex.
  const g = graph(9, [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]),
    pinned = free(9);
  pinned.set([0, 0, 1, 0], 0);
  const at = await run(g, input(pinned));
  for (let v = 2; v < 9; v++) expect(at[v * 2 + 1]).toBeGreaterThanOrEqual(3);
  const wide = await run(g, input(free(9)), { aspect: 100 });
  // One row: every part's top at the same height.
  expect(
    new Set([2, 4, 6, 8].map((v) => Math.min(wide[v * 2 + 1], wide[(v - 1) * 2 + 1]))).size,
  ).toBe(1);
});

it('flows layered parts along their direction, sources before targets', async () => {
  const g = graph(4, [
      [0, 1],
      [1, 2],
      [2, 3],
    ]),
    directions = Int8Array.from([1, -1, 1, -1, 1, -1]),
    sizes = new Float32Array(8).fill(10),
    right = await run(g, input(free(4), { directions, sizes }), { algorithm: 'layered' }),
    down = await run(g, input(free(4), { directions, sizes }), {
      algorithm: 'layered',
      direction: 'down',
    });
  for (let i = 1; i < 4; i++) {
    expect(right[i * 2]).toBeGreaterThan(right[(i - 1) * 2] + 10);
    expect(down[i * 2 + 1]).toBeGreaterThan(down[(i - 1) * 2 + 1] + 10);
  }
});

it('orders nothing by an edge whose ends are all inputs, whose flow comes from outside', async () => {
  const g = graph(3, [[0, 1, 2]]),
    sizes = new Float32Array(6).fill(10),
    at = await run(g, input(free(3), { sizes, directions: Int8Array.from([-1, -1, -1]) }), {
      algorithm: 'layered',
    });
  expect(new Set([at[0], at[2], at[4]]).size).toBe(1);
});

it('calls a strategy of your own once for each part of more than one vertex', async () => {
  const g = graph(7, [
      [0, 1],
      [1, 2],
      [3, 4],
    ]),
    arrange = vi.fn((part: { vertices: Uint32Array }) =>
      Array.from(part.vertices).flatMap((_, i) => [i, 0]),
    );
  await run(g, input(free(7)), { algorithm: { arrange } });
  expect(arrange.mock.calls.map(([part]) => [...part.vertices])).toEqual([
    [0, 1, 2],
    [3, 4],
  ]);
  for (const result of [
    [0, 0],
    [NaN, 0, 0, 0, 0, 0],
  ])
    await expect(
      run(graph(3, [[0, 1, 2]]), input(free(3)), { algorithm: { arrange: () => result } }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
});

it('rejects invalid layout options', () => {
  for (const layout of [
    'stress',
    { aspect: 0 },
    { vertexGap: -1 },
    { sweeps: 13 },
    { direction: 'sideways' },
    { algorithm: 'manual' },
  ])
    expect(() => options(layout as LayoutOptions)).toThrow();
});
