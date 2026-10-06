import { failure, type Work } from '@latkit/model';
import type { LayoutOptions, LayoutPart, LayoutStrategy } from './place.js';

/** Ranks along the flow, ordered to cross less, each vertex in line with its sources' ports. */
export function layered(layout: Required<LayoutOptions>, work: Work): LayoutStrategy {
  return { arrange: (part) => ranked(part, layout, work) };
}
type Box = readonly [number, number, number, number];
const intersects = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
async function ranked(
  part: LayoutPart,
  layout: Required<LayoutOptions>,
  work: Work,
): Promise<Float64Array> {
  const { graph, input, vertices, edges } = part,
    n = vertices.length,
    grid = input.grid ?? 0,
    sizes = input.sizes,
    width = (i: number) => sizes?.[vertices[i] * 2] ?? 0,
    height = (i: number) => sizes?.[vertices[i] * 2 + 1] ?? 0,
    xs = new Float64Array(n),
    ys = new Float64Array(n),
    fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = input.pinned[vertices[i] * 2],
      y = input.pinned[vertices[i] * 2 + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs[i] = x;
      ys[i] = y;
      fixed[i] = 1;
    }
  }
  // Flow runs from each of an edge's outputs to each of its other ends, or from its first end when
  // no end is directed. One whose ends are all inputs flows from outside the part: it orders none.
  const { offsets, items } = graph.ends,
    directions = input.directions,
    links: { a: number; b: number; from: number; to: number }[] = [],
    roots = new Int32Array(edges.length).fill(-1);
  edges.forEach((e, k) => {
    const s = offsets[e],
      t = offsets[e + 1];
    let outs = 0,
      ins = 0;
    for (let j = s; j < t; j++) {
      const d = directions?.[j] ?? 0;
      if (d > 0) outs++;
      else if (d < 0) ins++;
    }
    const source = (j: number) => (outs ? directions![j] > 0 : !ins && j === s);
    for (let j = s; j < t; j++) {
      if (!source(j)) continue;
      const a = part.indexOf(items[j]);
      if (roots[k] < 0) roots[k] = a;
      for (let r = s; r < t; r++) {
        const b = part.indexOf(items[r]);
        if (r !== j && !source(r) && a !== b && a >= 0 && b >= 0)
          links.push({ a, b, from: j, to: r });
      }
    }
  });
  const next = Array.from({ length: n }, () => [] as number[]),
    back = Array.from({ length: n }, () => [] as number[]);
  for (const { a, b } of links) {
    next[a].push(b);
    back[b].push(a);
  }
  for (const list of next) list.sort((a, b) => a - b);
  // Iterative DFS classifies feedback edges without collapsing an entire cycle into one column.
  // Topology remains intact; only ranking ignores back edges.
  const color = new Uint8Array(n),
    forward = Array.from({ length: n }, () => [] as number[]);
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => Number(back[a].length > 0) - Number(back[b].length > 0) || a - b,
  );
  for (const root of order)
    if (!color[root]) {
      const stack: [number, number][] = [[root, 0]];
      color[root] = 1;
      while (stack.length) {
        await work.step();
        const top = stack[stack.length - 1],
          a = top[0];
        if (top[1] === next[a].length) {
          color[a] = 2;
          stack.pop();
          continue;
        }
        const b = next[a][top[1]++];
        if (color[b] === 1) continue;
        forward[a].push(b);
        if (!color[b]) {
          color[b] = 1;
          stack.push([b, 0]);
        }
      }
    }
  const degree = new Uint32Array(n),
    rank = new Uint32Array(n);
  for (const list of forward) for (const b of list) degree[b]++;
  const queue = order.filter((i) => !degree[i]);
  for (let i = 0; i < queue.length; i++)
    for (const b of forward[queue[i]]) {
      rank[b] = Math.max(rank[b], rank[queue[i]] + 1);
      if (!--degree[b]) queue.push(b);
    }
  const ranks = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const list = ranks.get(rank[i]) ?? [];
    list.push(i);
    ranks.set(rank[i], list);
  }
  const ordered = [...ranks].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
  const slots = new Float64Array(n);
  const score = (i: number, neighbors: readonly number[]) => {
    if (!neighbors.length) return slots[i];
    return neighbors.reduce((sum, other) => sum + slots[other], 0) / neighbors.length;
  };
  // Bounded alternating barycenter sweeps reduce crossings.
  for (let sweep = 0; sweep < layout.sweeps; sweep++) {
    await work.step();
    for (const list of ordered)
      list.forEach((i, position) => {
        slots[i] = position;
      });
    for (const list of sweep % 2 ? [...ordered].reverse() : ordered) {
      const scores = new Map(list.map((i) => [i, score(i, (sweep % 2 ? next : back)[i])]));
      list.sort((a, b) => scores.get(a)! - scores.get(b)! || a - b);
      list.forEach((i, position) => {
        slots[i] = position;
      });
    }
  }
  const vertical = layout.direction === 'down' || layout.direction === 'up',
    reverse = layout.direction === 'left' || layout.direction === 'up',
    half = layout.vertexGap / 2,
    snap = (v: number) => (grid > 0 ? Math.round(v / grid) * grid : v),
    box = (i: number): Box => [
      xs[i] - half,
      ys[i] - half,
      xs[i] + width(i) + half,
      ys[i] + height(i) + half,
    ];
  // Placed boxes in a uniform grid of their own, for the collision escape below; its cells span a
  // few boxes in the data's own units.
  let largest = 0;
  for (let i = 0; i < n; i++) largest = Math.max(largest, width(i), height(i));
  const placedBoxes: Box[] = [],
    cells = new Map<number, number[]>(),
    cell = Math.max(layout.vertexGap * 8, largest * 2) || 1;
  const cellsOf = (b: Box, visit: (key: number) => void) => {
    for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++)
      for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++)
        visit((x + 0x2000000) * 0x4000000 + (y + 0x2000000));
  };
  const occupy = (b: Box) => {
    const id = placedBoxes.push(b) - 1;
    cellsOf(b, (key) => {
      const bucket = cells.get(key);
      if (bucket) bucket.push(id);
      else cells.set(key, [id]);
    });
  };
  const hits = (b: Box) => {
    const found = new Set<number>();
    cellsOf(b, (key) => {
      for (const id of cells.get(key) ?? []) if (intersects(placedBoxes[id], b)) found.add(id);
    });
    return [...found];
  };
  for (let i = 0; i < n; i++) if (fixed[i]) occupy(box(i));
  // Where an end meets its vertex across the flow, so wires between ports can run straight.
  const across = (i: number, end: number) => {
    const offset = input.ports?.[end * 2 + (vertical ? 0 : 1)];
    return offset !== undefined && Number.isFinite(offset)
      ? offset
      : (vertical ? width(i) : height(i)) / 2;
  };
  const incoming = Array.from({ length: n }, () => [] as (typeof links)[number][]);
  for (const link of links) incoming[link.b].push(link);
  const placed = Uint8Array.from(fixed),
    labelGaps = new Float64Array(n);
  edges.forEach((e, k) => {
    if (roots[k] >= 0)
      labelGaps[roots[k]] = Math.max(
        labelGaps[roots[k]],
        (input.labelRooms?.[e * 2 + (vertical ? 1 : 0)] ?? 0) + grid * 3,
      );
  });
  let major = 0;
  for (const list of ordered) {
    await work.step();
    // A rank holding pinned vertices starts where they stand, so new vertices join them.
    let start = reverse ? -Infinity : Infinity;
    for (const i of list)
      if (fixed[i]) {
        const at = vertical ? ys[i] : xs[i];
        start = reverse
          ? Math.max(start, at + (vertical ? height(i) : width(i)))
          : Math.min(start, at);
      }
    if (Number.isFinite(start)) major = reverse ? -start : start;
    let minor = 0,
      max = 0;
    for (const i of list) {
      const along = vertical ? height(i) : width(i),
        span = vertical ? width(i) : height(i);
      max = Math.max(max, along);
      if (fixed[i]) continue;
      const a = reverse ? -major - along : major;
      // Where each placed source would have this vertex sit for their ports to line up.
      const wanted = incoming[i]
        .filter((link) => placed[link.a])
        .map(
          (link) =>
            (vertical ? xs[link.a] : ys[link.a]) + across(link.a, link.from) - across(i, link.to),
        )
        .sort((p, q) => p - q);
      let b = Math.max(minor, wanted.length ? wanted[(wanted.length - 1) >> 1] : minor);
      xs[i] = vertical ? b : a;
      ys[i] = vertical ? a : b;
      // Deterministic local collision escape; jump beyond obstacles, never scan huge coordinates.
      for (let attempt = 0; attempt <= n; attempt++) {
        const found = hits(box(i));
        if (!found.length) break;
        b = Math.max(...found.map((j) => placedBoxes[j][vertical ? 2 : 3])) + layout.vertexGap;
        xs[i] = vertical ? b : a;
        ys[i] = vertical ? a : b;
        if (attempt === n) throw failure('resource-limit', 'Layout collision budget exceeded');
      }
      xs[i] = snap(xs[i]);
      ys[i] = snap(ys[i]);
      occupy(box(i));
      placed[i] = 1;
      minor = b + span + layout.vertexGap;
    }
    const labelGap = list.reduce((gap, i) => Math.max(gap, labelGaps[i]), 0);
    major += max + Math.max(layout.rankGap, labelGap);
  }
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = xs[i];
    out[i * 2 + 1] = ys[i];
  }
  return out;
}
