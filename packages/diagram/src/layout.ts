import { Work, failure, type FieldValues, type RequestOptions } from '@latkit/model';
import { kit, type Gpu } from '@latkit/gpu';
import { expandedData, type Point } from './data.js';
import type { DiagramConfig } from './diagram.js';
import { data as checkedData, resolveLimits, resolveStyle, positive, VIEW_DEFAULTS } from './config.js';
import { readScene } from './read.js';
import { positions, rect, expand, intersects, type Rect, type Scene } from './scene.js';
import { portPositions } from './geometry.js';
export interface LayoutVertex {
  readonly id: string;
  readonly type: string;
  readonly size: Point;
  readonly position?: Point;
  readonly group?: string;
  readonly ports: readonly {
    readonly name: string;
    readonly direction?: 'in' | 'out';
    readonly side: 'left' | 'right' | 'top' | 'bottom';
  }[];
}
export interface LayoutGraph {
  readonly vertices: readonly LayoutVertex[];
  /** Each edge as vertex pairs, from its source end to each other end. */
  readonly pairs: readonly (readonly [number, number])[];
  /** Edges with their ends' ports and directions, for custom algorithms. */
  readonly edges: readonly {
    readonly id: string;
    readonly type: string;
    readonly ends: readonly {
      readonly vertex: number;
      readonly port: string | null;
      readonly direction?: 'in' | 'out';
    }[];
    readonly labelSize: Point;
  }[];
  readonly groups: readonly {
    readonly id: string;
    readonly parent?: string;
    readonly members: readonly number[];
  }[];
}
export interface LayoutStrategy {
  arrange(
    graph: LayoutGraph,
    context: { readonly signal: AbortSignal },
  ): readonly Point[] | Promise<readonly Point[]>;
}
export interface LayoutOptions {
  readonly algorithm?: 'layered' | 'manual' | LayoutStrategy;
  readonly direction?: 'right' | 'left' | 'down' | 'up';
  readonly vertexGap?: number;
  readonly rankGap?: number;
  /** Crossing-reduction passes, from 0 to 12. Default: 4. */
  readonly sweeps?: number;
}
/** An algorithm name stands for that algorithm with defaults. */
export type Layout = 'layered' | 'manual' | LayoutOptions;
export function layoutOptions(layout: Layout = {}): Required<LayoutOptions> {
  const value = typeof layout === 'string' ? { algorithm: layout } : layout;
  const result = {
    algorithm: value.algorithm ?? 'layered',
    direction: value.direction ?? 'right',
    vertexGap: value.vertexGap ?? 24,
    rankGap: value.rankGap ?? 64,
    sweeps: value.sweeps ?? 4,
  };
  if (!Number.isInteger(result.sweeps) || result.sweeps < 0 || result.sweeps > 12)
    throw failure('invalid-input', 'Layout sweeps must be an integer from 0 to 12');
  positive(result.vertexGap, 'vertexGap', true);
  positive(result.rankGap, 'rankGap', true);
  if (!['right', 'left', 'down', 'up'].includes(result.direction))
    throw failure('invalid-input', 'Invalid layout direction');
  if (typeof result.algorithm === 'string' && !['layered', 'manual'].includes(result.algorithm))
    throw failure('invalid-input', 'Invalid layout algorithm');
  if (typeof result.algorithm === 'object' && typeof result.algorithm.arrange !== 'function')
    throw failure('invalid-input', 'Invalid layout strategy');
  return result;
}
/** Place a diagram's vertices as its layout would, without drawing: positions by vertex type. */
export async function arrange(
  gpu: Gpu,
  config: DiagramConfig,
  options: RequestOptions = {},
): Promise<Readonly<Record<string, FieldValues>>> {
  const data = checkedData(expandedData(config)),
    limits = resolveLimits(config.limits),
    style = resolveStyle(config, kit.resolveViewStyle(config, VIEW_DEFAULTS));
  const reader = gpu.reader.open({ signal: options.signal, at: config.at ?? undefined });
  try {
    const work = new Work(reader.signal, limits.layoutMs);
    const scene = await readScene(
      data,
      reader,
      style,
      limits,
      (input) => gpu.layoutText(input, { signal: reader.signal }),
      work,
    );
    await place(
      scene,
      layoutOptions(config.layout),
      style.gridPitch,
      reader.signal,
      undefined,
      work,
    );
    work.check();
    return positions(scene.vertices);
  } finally {
    reader.close();
  }
}
/** The end flow leaves from: the first output, else the first end. */
export function rootEnd(edge: Scene['edges'][number]): number {
  return Math.max(
    0,
    edge.ends.findIndex((e) => e.direction === 'out'),
  );
}
export async function place(
  scene: Scene,
  config: Required<LayoutOptions>,
  grid: number,
  signal: AbortSignal,
  previous?: Scene,
  work: Work = new Work(signal),
): Promise<void> {
  work.check();
  const { vertices } = scene,
    n = vertices.length;
  const old = new Map(
    previous?.vertices.map((vertex) => [
      JSON.stringify([vertex.index.type, vertex.hit.id]),
      vertex,
    ]),
  );
  for (const vertex of vertices)
    if (!vertex.pinned) {
      const prev = old.get(JSON.stringify([vertex.index.type, vertex.hit.id]));
      if (prev) {
        vertex.x = prev.x;
        vertex.y = prev.y;
        vertex.pinned = true;
      }
    }
  const pairs: [number, number][] = [],
    links: { a: number; b: number; from: string | null; to: string | null }[] = [];
  for (const edge of scene.edges) {
    const root = edge.ends[rootEnd(edge)];
    if (root)
      for (const e of edge.ends)
        if (e.vertex !== root.vertex) {
          pairs.push([root.vertex, e.vertex]);
          links.push({ a: root.vertex, b: e.vertex, from: root.port, to: e.port });
        }
  }
  if (typeof config.algorithm === 'object') {
    const result = await config.algorithm.arrange(
      {
        vertices: vertices.map((vertex) => ({
          id: vertex.hit.id,
          type: vertex.hit.index.type,
          size: [vertex.width, vertex.height],
          position: vertex.pinned ? [vertex.x, vertex.y] : undefined,
          group: vertex.group,
          ports: vertex.ports.map((port) => ({
            name: port.name,
            side: port.side,
            ...(port.direction ? { direction: port.direction } : {}),
          })),
        })),
        pairs,
        edges: scene.edges.map((edge) => ({
          id: edge.hit.id,
          type: edge.hit.index.type,
          ends: edge.ends,
          labelSize: [edge.label.width, edge.label.height],
        })),
        groups: scene.groups.map((group) => ({
          id: group.id,
          parent: group.parent,
          members: group.members,
        })),
      },
      { signal },
    );
    work.check();
    if (result.length !== n || result.some((p) => p.length !== 2 || !p.every(Number.isFinite)))
      throw failure('invalid-input', 'Layout returned invalid positions');
    vertices.forEach((vertex, i) => {
      if (!vertex.pinned) {
        vertex.x = result[i][0];
        vertex.y = result[i][1];
      }
    });
    return;
  }
  if (config.algorithm === 'manual') {
    if (vertices.some((vertex) => !vertex.pinned))
      throw failure('invalid-input', 'Manual layout requires all vertex positions');
    return;
  }
  const next = Array.from({ length: n }, () => [] as number[]),
    back = Array.from({ length: n }, () => [] as number[]);
  for (const [a, b] of pairs)
    if (a !== b) {
      next[a].push(b);
      back[b].push(a);
    }
  const keys = vertices.map((vertex) =>
    JSON.stringify([vertex.group ?? '', vertex.hit.index.type, vertex.hit.id]),
  );
  const compare = (a: number, b: number) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0);
  for (const list of next) list.sort(compare);
  // Iterative DFS classifies feedback edges without collapsing an entire cycle into one column.
  // Topology remains intact; only ranking ignores back edges.
  const color = new Uint8Array(n),
    forward = Array.from({ length: n }, () => [] as number[]);
  const roots = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => Number(back[a].length > 0) - Number(back[b].length > 0) || compare(a, b),
  );
  for (const root of roots)
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
  const queue = roots.filter((i) => !degree[i]);
  for (let i = 0; i < queue.length; i++)
    for (const b of forward[queue[i]]) {
      rank[b] = Math.max(rank[b], rank[queue[i]] + 1);
      if (!--degree[b]) queue.push(b);
    }
  const levels = new Map<number, number[]>();
  vertices.forEach((_, i) => {
    const list = levels.get(rank[i]) ?? [];
    list.push(i);
    levels.set(rank[i], list);
  });
  const ordered = [...levels].sort((a, b) => a[0] - b[0]).map(([, list]) => list.sort(compare));
  const slots = new Float64Array(n);
  const score = (i: number, neighbors: readonly number[]) => {
    if (!neighbors.length) return slots[i];
    return neighbors.reduce((sum, other) => sum + slots[other], 0) / neighbors.length;
  };
  // Bounded alternating barycenter sweeps reduce crossings while retaining group contiguity.
  for (let sweep = 0; sweep < config.sweeps; sweep++) {
    await work.step();
    for (const list of ordered)
      list.forEach((i, position) => {
        slots[i] = position;
      });
    const sequence = sweep % 2 ? [...ordered].reverse() : ordered;
    for (const list of sequence) {
      const scores = new Map(list.map((i) => [i, score(i, (sweep % 2 ? next : back)[i])]));
      list.sort(
        (a, b) =>
          (vertices[a].group ?? '').localeCompare(vertices[b].group ?? '') ||
          scores.get(a)! - scores.get(b)! ||
          compare(a, b),
      );
      list.forEach((i, position) => {
        slots[i] = position;
      });
    }
  }
  const vertical = config.direction === 'down' || config.direction === 'up',
    reverse = config.direction === 'left' || config.direction === 'up';
  // Placed boxes in a uniform grid of their own, for the collision escape below.
  const placedBoxes: Rect[] = [],
    cells = new Map<number, number[]>(),
    cell = 256;
  const cellsOf = (box: Rect, visit: (key: number) => void) => {
    for (let y = Math.floor(box[1] / cell); y <= Math.floor(box[3] / cell); y++)
      for (let x = Math.floor(box[0] / cell); x <= Math.floor(box[2] / cell); x++)
        visit((x + 0x2000000) * 0x4000000 + (y + 0x2000000));
  };
  const occupy = (box: Rect) => {
    const id = placedBoxes.push(box) - 1;
    cellsOf(box, (key) => {
      const bucket = cells.get(key);
      if (bucket) bucket.push(id);
      else cells.set(key, [id]);
    });
  };
  const hits = (box: Rect) => {
    const found = new Set<number>();
    cellsOf(box, (key) => {
      for (const id of cells.get(key) ?? []) if (intersects(placedBoxes[id], box)) found.add(id);
    });
    return [...found];
  };
  for (const vertex of vertices)
    if (vertex.pinned) occupy(expand(rect(vertex), config.vertexGap / 2));
  // Each port's offset from its vertex's corner, so wires between ports can run straight.
  const offsets = vertices.map((vertex) => {
    const { x, y } = vertex;
    vertex.x = vertex.y = 0;
    portPositions(vertex);
    vertex.x = x;
    vertex.y = y;
    return new Map(vertex.ports.map((port) => [port.name, port.position]));
  });
  const across = (i: number, port: string | null) =>
    (port ? offsets[i].get(port)?.[vertical ? 0 : 1] : undefined) ??
    (vertical ? vertices[i].width : vertices[i].height) / 2;
  const incoming = Array.from({ length: n }, () => [] as (typeof links)[number][]);
  for (const link of links) if (link.a !== link.b) incoming[link.b].push(link);
  const placed = new Set<number>();
  const labelGaps = new Float64Array(n);
  for (const edge of scene.edges) {
    const root = edge.ends[rootEnd(edge)];
    if (root)
      labelGaps[root.vertex] = Math.max(
        labelGaps[root.vertex],
        (vertical ? edge.label.height : edge.label.width) + grid * 3,
      );
  }
  let major = 0;
  for (const list of ordered) {
    await work.step();

    let minor = 0,
      max = 0;
    for (const i of list) {
      const vertex = vertices[i],
        along = vertical ? vertex.height : vertex.width,
        span = vertical ? vertex.width : vertex.height;
      max = Math.max(max, along);
      if (vertex.pinned) continue;
      const a = reverse ? -major - along : major;
      // Where each placed source would have this vertex sit for their ports to line up.
      const wanted = incoming[i]
        .filter((link) => placed.has(link.a))
        .map(
          (link) =>
            (vertical ? vertices[link.a].x : vertices[link.a].y) +
            across(link.a, link.from) -
            across(i, link.to),
        )
        .sort((a, b) => a - b);
      const desired = wanted.length ? wanted[(wanted.length - 1) >> 1] : minor;
      let b = Math.max(minor, desired);
      vertex.x = vertical ? b : a;
      vertex.y = vertical ? a : b;
      // Deterministic local collision escape; jump beyond obstacles, never scan huge coordinates.
      for (let attempt = 0; attempt <= vertices.length; attempt++) {
        const found = hits(expand(rect(vertex), config.vertexGap / 2));
        if (!found.length) break;
        b = Math.max(...found.map((j) => placedBoxes[j][vertical ? 2 : 3])) + config.vertexGap;
        vertex.x = vertical ? b : a;
        vertex.y = vertical ? a : b;
        if (attempt === vertices.length)
          throw failure('resource-limit', 'Layout collision budget exceeded');
      }
      vertex.x = Math.round(vertex.x / grid) * grid;
      vertex.y = Math.round(vertex.y / grid) * grid;
      occupy(expand(rect(vertex), config.vertexGap / 2));
      placed.add(i);
      minor = b + span + config.vertexGap;
    }
    const labelGap = list.reduce((gap, i) => Math.max(gap, labelGaps[i]), 0);
    major += max + Math.max(config.rankGap, labelGap);
  }
}
