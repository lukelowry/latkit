import { expect, it, vi } from 'vitest';
import { Work, createReader } from '@latkit/model';
import { kit, type Gpu } from '@latkit/gpu';
import {
  arrange,
  layoutOptions,
  place,
  type LayoutGraph,
  type LayoutOptions,
} from '../src/layout.js';
import { readScene } from '../src/read.js';
import { geometry, labelBox } from '../src/geometry.js';
import { resolveStyle, resolveLimits } from '../src/config.js';
import { rect, union, type Rect, type Scene } from '../src/scene.js';
import type { DiagramData, Group } from '../src/data.js';
import { clusters, data, layoutText, unplace, Source } from './fixture.js';
/** Arrangement only reads and measures text. */
const gpu = { reader: createReader(), layoutText } as unknown as Gpu;
const style = resolveStyle();
/** A diagram and the layout that places it. */
type Built = DiagramData & { readonly layout?: LayoutOptions };
/** Read, place, and route a diagram as a view would, after `previous` when given. */
async function build(d: Built, previous?: Scene): Promise<Scene> {
  const reader = gpu.reader.open();
  try {
    const work = new Work(reader.signal),
      scene = await readScene(d, reader, style, resolveLimits(), layoutText, work);
    await place(scene, layoutOptions(d.layout), style, work, previous);
    await geometry(scene, style, resolveLimits(), reader.signal, previous, work);
    return scene;
  } finally {
    reader.close();
  }
}
const grouped = (groups: Record<string, Group>, d: DiagramData = data()): Built => ({
  ...d,
  groups,
});
const ids = (...rows: number[]) => ({
  Task: { kind: 'ids' as const, ids: rows.map((r) => 'n' + r) },
});
const width = (r: Rect) => r[2] - r[0],
  height = (r: Rect) => r[3] - r[1];
/** Whether an axis-aligned segment passes through a box's inside, a unit in from its edges. */
function crosses(a: readonly number[], b: readonly number[], box: Rect): boolean {
  const [x0, y0, x1, y1] = [box[0] + 1, box[1] + 1, box[2] - 1, box[3] - 1];
  if (a[0] === b[0])
    return a[0] > x0 && a[0] < x1 && Math.max(a[1], b[1]) > y0 && Math.min(a[1], b[1]) < y1;
  return a[1] > y0 && a[1] < y1 && Math.max(a[0], b[0]) > x0 && Math.min(a[0], b[0]) < x1;
}
const overlap = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
/**
 * What every laid out and routed scene holds: no block over another, parts that hold each vertex
 * and edge once, wires that keep out of blocks they do not end at, labels off blocks, and group
 * frames about their members and no others.
 */
function clean(scene: Scene): void {
  const shown = scene.vertices.map((vertex, i) => ({ vertex, i })).filter((v) => v.vertex.visible),
    boxes = shown.map(({ vertex }) => rect(vertex));
  const order = shown.map((_, k) => k).sort((a, b) => boxes[a][0] - boxes[b][0]);
  for (let p = 0; p < order.length; p++)
    for (let q = p + 1; q < order.length && boxes[order[q]][0] < boxes[order[p]][2]; q++)
      expect(overlap(boxes[order[p]], boxes[order[q]]), 'blocks overlap').toBe(false);
  const partOf = new Int32Array(scene.vertices.length).fill(-1);
  scene.parts.forEach((part, k) =>
    part.vertices.forEach((v) => {
      expect(partOf[v], 'a vertex in two parts').toBe(-1);
      partOf[v] = k;
    }),
  );
  expect(
    [...partOf].every((k) => k >= 0),
    'a vertex in no part',
  ).toBe(true);
  scene.edges.forEach((edge, e) => {
    const parts = new Set(edge.ends.map((end) => partOf[end.vertex]));
    expect(parts.size, 'an edge across parts').toBeLessThanOrEqual(1);
    for (const k of parts) expect(scene.parts[k].edges).toContain(e);
  });
  if (!boxes.length) return;
  const index = kit.BoxIndex.of(boxes.length, union(boxes), (k, box) => box.set(boxes[k]));
  for (const edge of scene.edges) {
    const own = new Set(edge.ends.map((end) => end.vertex));
    // A straight wire takes the shortest way, through whatever is there.
    if (edge.options.route !== 'straight')
      for (const path of edge.paths)
        for (let k = 1; k < path.length; k++) {
          const a = path[k - 1],
            b = path[k];
          index.some(
            [
              Math.min(a[0], b[0]),
              Math.min(a[1], b[1]),
              Math.max(a[0], b[0]),
              Math.max(a[1], b[1]),
            ],
            (j) => {
              if (!own.has(shown[j].i))
                expect(crosses(a, b, boxes[j]), 'a wire through a block').toBe(false);
            },
          );
        }
    for (const at of edge.labels) {
      index.some(labelBox(edge, at), (j) => {
        expect(overlap(labelBox(edge, at), boxes[j]), 'a label over a block').toBe(false);
      });
      for (const group of scene.groups) {
        const b = group.bounds;
        if (group.collapsed || b[0] === b[2]) continue;
        expect(
          overlap(labelBox(edge, at), [b[0], b[1], b[2], b[1] + group.header]),
          'a label over a group title',
        ).toBe(false);
      }
    }
  }
  for (const group of scene.groups) {
    if (group.bounds[0] === group.bounds[2]) continue;
    const b = group.bounds;
    shown.forEach(({ i }, k) => {
      const within = !!scene.vertices[i].group && inside(scene, scene.vertices[i].group!, group.id);
      if (within)
        expect(
          boxes[k][0] >= b[0] && boxes[k][1] >= b[1] && boxes[k][2] <= b[2] && boxes[k][3] <= b[3],
          'a member outside its group',
        ).toBe(true);
      else expect(overlap(boxes[k], b), 'a block inside a group it is not in').toBe(false);
    });
  }
}
/** Whether a group lies within another, at any depth. */
function inside(scene: Scene, id: string, outer: string): boolean {
  const groups = new Map(scene.groups.map((g) => [g.id, g]));
  for (let g: string | undefined = id; g; g = groups.get(g)?.parent) if (g === outer) return true;
  return false;
}
/** Each part's box: its vertices' union. */
const partBoxes = (scene: Scene) =>
  scene.parts.map((part) => union(part.vertices.map((v) => rect(scene.vertices[v]))));

const fanOut = () => {
  const source = new Source(9);
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      ...Array.from({ length: 8 }, (_, i) => ({ vertex: i + 1, port: 'input' as const })),
    ],
  ];
  return source;
};
const tangled = () => {
  const source = new Source(6);
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
    [
      { vertex: 2, port: 'output' },
      { vertex: 0, port: 'input' },
    ],
    // A net back into its own vertex, and one with a single end.
    [
      { vertex: 3, port: 'output' },
      { vertex: 4, port: 'input' },
    ],
    [{ vertex: 4, port: 'output' }],
    [
      { vertex: 5, port: 'output' },
      { vertex: 5, port: 'input' },
    ],
  ];
  return source;
};
/** Cycles of one to six tasks, two of each. */
const mixed = () => {
  const source = new Source(42);
  source.ends = [];
  let first = 0;
  for (const size of [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6]) {
    for (let k = 0; k < size; k++)
      source.ends.push([
        { vertex: first + k, port: 'output' },
        { vertex: first + ((k + 1) % size), port: 'input' },
      ]);
    first += size;
  }
  return source;
};
const isolated = (count: number) => {
  const source = new Source(count);
  source.ends = [];
  return source;
};

it.each<[string, () => Built]>([
  ['an empty diagram', () => data(new Source(0))],
  ['one vertex', () => data(isolated(1))],
  ['isolated vertices', () => data(isolated(60))],
  ['a chain', () => data(new Source(12))],
  ['a fan-out net', () => data(fanOut())],
  ['cycles, self-loops, and a net with one end', () => data(tangled())],
  ['many parts, as in a grid case', () => data(clusters(60))],
  ['parts of one vertex wired to itself', () => data(clusters(12, 1))],
  ['parts of every size', () => data(mixed())],
  ['a downward layout', () => ({ ...data(clusters(10)), layout: { direction: 'down' } })],
  ['a leftward layout', () => ({ ...data(new Source(8)), layout: { direction: 'left' } })],
  ['an upward layout', () => ({ ...data(fanOut()), layout: { direction: 'up' } })],
  [
    'tags',
    () => {
      const d = data(clusters(6));
      return { ...d, edges: { Dependency: { ...d.edges!.Dependency, appearance: 'tag' } } };
    },
  ],
  [
    'straight wires',
    () => {
      const d = data(clusters(6));
      return { ...d, edges: { Dependency: { ...d.edges!.Dependency, route: 'straight' } } };
    },
  ],
  ['a group', () => grouped({ pair: { label: 'Pair', vertices: ids(1, 2) } })],
  [
    'nested groups across parts',
    () =>
      grouped(
        {
          outer: { label: 'Outer', vertices: ids(0) },
          inner: { label: 'Inner', parent: 'outer', vertices: ids(4, 5) },
          apart: { label: 'Apart', vertices: ids(8, 9, 10, 11) },
        },
        data(clusters(4)),
      ),
  ],
  [
    'a collapsed group',
    () =>
      grouped(
        { shut: { label: 'Shut', collapsed: true, vertices: ids(0, 1, 2) } },
        data(clusters(3)),
      ),
  ],
  ['an empty group', () => grouped({ none: { label: 'None', vertices: {} } })],
  [
    'pinned and loose parts',
    () => data(unplace(clusters(6), [8, 9, 10, 11, 12, 13, 14, 15]), true),
  ],
  [
    'vertices pinned on top of one another',
    () => {
      const source = clusters(2);
      source.xy.fill(0);
      source.update();
      return data(unplace(source, [4, 5, 6, 7]), true);
    },
  ],
])('lays out and routes %s cleanly', async (_, make) => {
  const d = make(),
    scene = await build(d);
  // Pinned vertices may overlap where their data puts them; only placed ones must not.
  if (!scene.vertices.some((vertex) => vertex.placed)) clean(scene);
  else {
    const loose = scene.vertices.filter((vertex) => !vertex.placed);
    for (const a of loose)
      for (const b of scene.vertices)
        if (a !== b) expect(overlap(rect(a), rect(b)), 'a placed block over another').toBe(false);
  }
  // The same diagram arranges the same way every time.
  expect((await build(d)).vertices.map((v) => [v.x, v.y])).toEqual(
    scene.vertices.map((v) => [v.x, v.y]),
  );
});

it('packs a grid case into rows of like parts, with every wire inside its part', async () => {
  const scene = await build(data(clusters(334)));
  clean(scene);
  expect(scene.parts).toHaveLength(334);
  const [x0, y0, x1, y1] = scene.bounds,
    aspect = (x1 - x0) / (y1 - y0);
  expect(aspect).toBeGreaterThan(16 / 9 / 2);
  expect(aspect).toBeLessThan((16 / 9) * 2);
  // Blocks fill a fair share of the drawing, rather than a strip of long wires.
  const area = scene.vertices.reduce((sum, v) => sum + v.width * v.height, 0);
  expect(area / ((x1 - x0) * (y1 - y0))).toBeGreaterThan(0.15);
  const boxes = partBoxes(scene);
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++)
      expect(overlap(boxes[a], boxes[b]), 'parts overlap').toBe(false);
  scene.parts.forEach((part, k) => {
    const near = [boxes[k][0] - 64, boxes[k][1] - 64, boxes[k][2] + 64, boxes[k][3] + 64];
    for (const e of part.edges) {
      const b = scene.edges[e].bounds;
      expect(b[0] >= near[0] && b[1] >= near[1] && b[2] <= near[2] && b[3] <= near[3]).toBe(true);
    }
  });
  // Equal parts line up in a grid, in read order.
  const rows = new Set(boxes.map((box) => box[1]));
  expect(rows.size).toBeGreaterThan(5);
  expect(boxes[1][0]).toBeGreaterThan(boxes[0][0]);
});

it('packs isolated vertices into rows near the aspect, which the layout sets', async () => {
  const square = await build({ ...data(isolated(100)), layout: { aspect: 1 } }),
    wide = await build({ ...data(isolated(100)), layout: { aspect: 4 } });
  const ratio = (s: Scene) => width(s.bounds) / height(s.bounds);
  expect(ratio(square)).toBeGreaterThan(0.5);
  expect(ratio(square)).toBeLessThan(2);
  expect(ratio(wide)).toBeGreaterThan(ratio(square) * 2);
  clean(square);
  clean(wide);
});

it('packs the tallest parts first, then parts in read order', async () => {
  const source = new Source(7);
  // A chain of two, a lone vertex, and a fan of four whose inputs stack in one rank.
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      { vertex: 1, port: 'input' },
    ],
    [
      { vertex: 3, port: 'output' },
      { vertex: 4, port: 'input' },
      { vertex: 5, port: 'input' },
      { vertex: 6, port: 'input' },
    ],
  ];
  const scene = await build({ ...data(source), layout: { aspect: 100 } }),
    tops = scene.parts.map((part) => part.vertices[0]),
    lefts = partBoxes(scene).map((box) => box[0]);
  expect(tops).toEqual([0, 2, 3]);
  // One row: the fan first, then the chain and the lone vertex in read order.
  expect(lefts[2]).toBeLessThan(lefts[0]);
  expect(lefts[0]).toBeLessThan(lefts[1]);
});

it('keeps pinned parts where they are and packs loose ones below them', async () => {
  const source = unplace(clusters(4), [8, 9, 10, 11, 12, 13, 14, 15]),
    scene = await build(data(source, true));
  const pinned = scene.vertices.filter((v) => v.placed);
  pinned.forEach((v, i) => expect([v.x, v.y]).toEqual([source.xy[i * 2], source.xy[i * 2 + 1]]));
  const bottom = Math.max(...pinned.map((v) => v.y + v.height));
  for (const v of scene.vertices.filter((v) => !v.placed))
    expect(v.y).toBeGreaterThanOrEqual(bottom + layoutOptions().rankGap - 8);
});

it('places a new vertex beside the pinned one that drives it', async () => {
  const source = unplace(new Source(3), [2]);
  source.xy.set([0, 0, 240, 0]);
  source.update();
  const scene = await build(data(source, true)),
    [, b, c] = scene.vertices;
  expect(c.x).toBeGreaterThanOrEqual(b.x + b.width);
  expect(c.x).toBeLessThan(b.x + b.width + 200);
  expect(Math.abs(c.y - b.y)).toBeLessThan(b.height);
});

it('keeps what the previous scene drew and places only what is new', async () => {
  const before = await build(data(clusters(3))),
    after = await build(data(clusters(4)), before);
  before.vertices.forEach((v, i) =>
    expect([after.vertices[i].x, after.vertices[i].y]).toEqual([v.x, v.y]),
  );
  const bottom = Math.max(...before.vertices.map((v) => v.y + v.height));
  for (const v of after.vertices.slice(12)) expect(v.y).toBeGreaterThan(bottom);
  clean(after);
});

it('arranges a group inside first and moves it as one vertex', async () => {
  const scene = await build(
    grouped(
      {
        apart: { label: 'Apart', vertices: ids(0, 1, 6, 7) },
        inner: { label: 'Inner', parent: 'apart', vertices: ids(4) },
      },
      data(clusters(4, 2)),
    ),
  );
  clean(scene);
  const apart = scene.groups.find((g) => g.id === 'apart')!,
    inner = scene.groups.find((g) => g.id === 'inner')!;
  // The inner group sits inside the outer one, and the outer one holds two parts packed apart.
  expect(inner.bounds[0]).toBeGreaterThan(apart.bounds[0]);
  expect(inner.bounds[2]).toBeLessThan(apart.bounds[2]);
  expect(scene.parts).toHaveLength(2);
});

it('stacks groups a net from outside reaches alike in one rank', async () => {
  // A dispatcher feeds three units inside a station, and each unit's plant feeds a meter.
  const source = new Source(8);
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      { vertex: 1, port: 'input' },
      { vertex: 3, port: 'input' },
      { vertex: 5, port: 'input' },
    ],
    ...[1, 3, 5].map((c) => [
      { vertex: c, port: 'output' as const },
      { vertex: c + 1, port: 'input' as const },
    ]),
    [
      { vertex: 2, port: 'output' },
      { vertex: 4, port: 'output' },
      { vertex: 6, port: 'output' },
      { vertex: 7, port: 'input' },
    ],
  ];
  const scene = await build(
    grouped(
      {
        station: { label: 'Station', vertices: {} },
        one: { label: 'Unit 1', parent: 'station', vertices: ids(1, 2) },
        two: { label: 'Unit 2', parent: 'station', vertices: ids(3, 4) },
        three: { label: 'Unit 3', parent: 'station', vertices: ids(5, 6) },
      },
      data(source),
    ),
  );
  clean(scene);
  const [one, two, three] = ['one', 'two', 'three'].map(
    (id) => scene.groups.find((g) => g.id === id)!.bounds,
  );
  expect(new Set([one[0], two[0], three[0]]).size).toBe(1);
  expect(two[1]).toBeGreaterThan(one[3]);
  expect(three[1]).toBeGreaterThan(two[3]);
});

it('calls a custom strategy once per part, with pinned vertices where they are', async () => {
  const source = unplace(clusters(3), [4, 5, 6, 7, 8, 9, 10, 11]),
    parts: LayoutGraph[] = [];
  const algorithm = {
    arrange: vi.fn((part: LayoutGraph) => {
      parts.push(part);
      return part.vertices.map((vertex, i) => vertex.position ?? ([i * 200, 0] as const));
    }),
  };
  // The pinned part needs no arranging.
  await arrange(gpu, { ...data(source, true), layout: { algorithm } });
  expect(parts.map((part) => part.vertices.length)).toEqual([4, 4]);
  expect(parts.every((part) => part.vertices.every((vertex) => !vertex.position))).toBe(true);
  const invalid: (readonly (readonly [number, number])[])[] = [
    [[0, 0]],
    [
      [NaN, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  ];
  for (const result of invalid)
    await expect(
      arrange(gpu, { ...data(clusters(1)), layout: { algorithm: { arrange: () => result } } }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
});

it('rejects invalid layout options', async () => {
  for (const layout of [
    'manual',
    { aspect: 0 },
    { aspect: -1 },
    { aspect: Infinity },
    { sweeps: 13 },
    { direction: 'sideways' },
    { algorithm: 'manual' },
    { rankGap: -1 },
  ])
    expect(() => layoutOptions(layout as LayoutOptions)).toThrow();
});

it('routes again only the parts that changed, matching rows by identity', async () => {
  // Three parts, a row each, far apart; the first vertex moves up and away from the rest.
  const source = clusters(3);
  source.xy.forEach(
    (_, i) => (source.xy[i] = i % 2 ? Math.floor(i / 8) * 600 : ((i >> 1) % 4) * 240),
  );
  source.update();
  const before = await build(data(source, true));
  source.xy[1] = -300;
  source.update();
  const after = await build(data(source, true), before);
  clean(after);
  const [moved, ...still] = after.parts;
  for (const part of still)
    for (const e of part.edges) {
      expect(after.edges[e].paths).toBe(before.edges[e].paths);
      expect(after.edges[e].labels).toBe(before.edges[e].labels);
    }
  // In the part that moved, a wire away from the moved vertex keeps its route.
  const away = moved.edges.find((e) => !after.edges[e].ends.some((end) => end.vertex === 0))!;
  expect(after.edges[away].route).toBe(before.edges[away].route);
  expect(after.edges[moved.edges[0]].paths).not.toBe(before.edges[moved.edges[0]].paths);
  // A row selected first shifts every index, and rows keep their routes by identity.
  const all = data(source, true),
    selected = (rows: number[]) => ({
      ...all,
      vertices: { Task: { ...all.vertices.Task, rows: ids(...rows).Task } },
    });
  const fewer = await build(selected([4, 5, 6, 7])),
    more = await build(selected([0, 4, 5, 6, 7]), fewer);
  const routes = (s: Scene) => new Set(s.edges.map((edge) => edge.route).filter(Boolean));
  expect([...routes(fewer)].every((route) => routes(more).has(route))).toBe(true);
});

it('routes collapsed groups afresh, to their frames', async () => {
  const d = grouped({ shut: { label: 'Shut', vertices: ids(0, 1) } }, data(clusters(2), true)),
    open = await build(d),
    shut = await build(
      grouped({ shut: { label: 'Shut', collapsed: true, vertices: ids(0, 1) } }, d),
      open,
    );
  const frame = shut.groups[0].bounds,
    wire = shut.edges.find(
      (edge) => edge.ends.some((end) => end.vertex === 1) && edge.paths.length,
    )!;
  expect(wire.route).not.toBe(open.edges[shut.edges.indexOf(wire)].route);
  expect(
    wire.paths
      .flat()
      .some((p) => p[0] >= frame[0] && p[0] <= frame[2] && p[1] >= frame[1] && p[1] <= frame[3]),
  ).toBe(true);
});
