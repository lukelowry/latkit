import { Work } from './work.js';
import type { RequestOptions } from '@latkit/model';
import { createNativeReader, GpuError } from '@latkit/gpu';
import type { FieldValues, TextInput, TextMetrics } from '@latkit/gpu';
import type { DiagramData, Point } from './data.js';
import type { Limits, Options } from './options.js';
import {
  data as checkedData,
  options as checkedOptions,
  limits as checkedLimits,
  sources,
  positive,
} from './config.js';
import { readScene } from './read.js';
import { positions, rect, type Scene } from './scene.js';
import { SpatialIndex, expand, intersects } from './spatial.js';
export interface LayoutNode {
  readonly id: string;
  readonly type: string;
  readonly size: Point;
  readonly position?: Point;
  readonly group?: string;
  readonly ports: readonly {
    readonly name: string;
    readonly direction: 'in' | 'out' | 'both';
    readonly side: 'left' | 'right' | 'top' | 'bottom';
  }[];
}
export interface LayoutGraph {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly (readonly [number, number])[];
  /** Native hyperedges retain endpoint roles and ports for custom algorithms. */
  readonly connections: readonly {
    readonly id: string;
    readonly type: string;
    readonly endpoints: readonly {
      readonly node: number;
      readonly port: string | null;
      readonly role: string;
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
  readonly nodeGap?: number;
  readonly rankGap?: number;
  /** Crossing-reduction passes, from 0 to 12. Default: 4. */
  readonly sweeps?: number;
}
export function layoutOptions(value: LayoutOptions = {}): Required<LayoutOptions> {
  const result = {
    algorithm: value.algorithm ?? 'layered',
    direction: value.direction ?? 'right',
    nodeGap: value.nodeGap ?? 24,
    rankGap: value.rankGap ?? 64,
    sweeps: value.sweeps ?? 4,
  };
  if (!Number.isInteger(result.sweeps) || result.sweeps < 0 || result.sweeps > 12)
    throw new GpuError('invalid-input', 'Layout sweeps must be an integer from 0 to 12');
  positive(result.nodeGap, 'nodeGap', true);
  positive(result.rankGap, 'rankGap', true);
  if (!['right', 'left', 'down', 'up'].includes(result.direction))
    throw new GpuError('invalid-input', 'Invalid layout direction');
  if (typeof result.algorithm === 'string' && !['layered', 'manual'].includes(result.algorithm))
    throw new GpuError('invalid-input', 'Invalid layout algorithm');
  if (typeof result.algorithm === 'object' && typeof result.algorithm.arrange !== 'function')
    throw new GpuError('invalid-input', 'Invalid layout strategy');
  return result;
}
export interface ArrangeOptions extends RequestOptions {
  readonly data: DiagramData;
  readonly options?: Options;
  readonly layout?: LayoutOptions;
  readonly at?: number;
  readonly limits?: Limits;
  readonly measureText: (input: TextInput, options?: RequestOptions) => Promise<TextMetrics>;
}
export async function arrange(
  input: ArrangeOptions,
): Promise<Readonly<Record<string, FieldValues>>> {
  const data = checkedData(input.data),
    limits = checkedLimits(input.limits),
    options = checkedOptions(input.options);
  const reader = createNativeReader({
    signal: input.signal,
    at: input.at,
    maxBytes: limits.geometryBytes,
  });
  try {
    const work = new Work(reader.signal, limits.prepareMs);
    const scene = await readScene(data, reader, options, limits, input.measureText, work);
    await place(
      scene,
      layoutOptions(input.layout),
      options.gridPitch,
      reader.signal,
      undefined,
      work,
    );
    work.check();
    reader.check();
    for (const source of sources(data))
      if (source.version !== scene.versions.get(source))
        throw new GpuError('conflict', 'Layout source changed');
    return positions(scene.nodes);
  } finally {
    reader.destroy();
  }
}
export function rootEndpoint(scene: Scene, edge: Scene['edges'][number]): number {
  const i = edge.endpoints.findIndex(
    (e) =>
      e.direction === 'out' ||
      (e.port &&
        scene.nodes[e.node].ports.find((p) => p.name === e.port)?.definition.direction === 'out'),
  );
  return Math.max(0, i);
}
export async function place(
  scene: Scene,
  config: Required<LayoutOptions>,
  grid: number,
  signal: AbortSignal,
  previous?: Scene,
  work = new Work(signal),
): Promise<void> {
  work.check();
  const { nodes } = scene,
    n = nodes.length;
  const old = new Map(
    previous?.nodes.map((node) => [JSON.stringify([node.index.type, node.hit.id]), node]),
  );
  for (const node of nodes)
    if (!node.pinned) {
      const prev = old.get(JSON.stringify([node.index.type, node.hit.id]));
      if (prev) {
        node.x = prev.x;
        node.y = prev.y;
        node.pinned = true;
      }
    }
  const pairs: [number, number][] = [];
  for (const edge of scene.edges) {
    const root = edge.endpoints[rootEndpoint(scene, edge)];
    if (root)
      for (const e of edge.endpoints) if (e.node !== root.node) pairs.push([root.node, e.node]);
  }
  if (typeof config.algorithm === 'object') {
    const result = await config.algorithm.arrange(
      {
        nodes: nodes.map((node) => ({
          id: node.hit.id,
          type: node.hit.type,
          size: [node.width, node.height],
          position: node.pinned ? [node.x, node.y] : undefined,
          group: node.group,
          ports: node.ports.map((port) => ({
            name: port.name,
            side: port.side,
            direction: port.definition.direction,
          })),
        })),
        edges: pairs,
        connections: scene.edges.map((edge) => ({
          id: edge.hit.id,
          type: edge.hit.type,
          endpoints: edge.endpoints,
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
      throw new GpuError('invalid-input', 'Layout returned invalid positions');
    nodes.forEach((node, i) => {
      if (!node.pinned) {
        node.x = result[i][0];
        node.y = result[i][1];
      }
    });
    return;
  }
  if (config.algorithm === 'manual') {
    if (nodes.some((node) => !node.pinned))
      throw new GpuError('invalid-input', 'Manual layout requires all component positions');
    return;
  }
  const next = Array.from({ length: n }, () => [] as number[]),
    back = Array.from({ length: n }, () => [] as number[]);
  for (const [a, b] of pairs)
    if (a !== b) {
      next[a].push(b);
      back[b].push(a);
    }
  const keys = nodes.map((node) => JSON.stringify([node.group ?? '', node.hit.type, node.hit.id]));
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
  nodes.forEach((_, i) => {
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
          (nodes[a].group ?? '').localeCompare(nodes[b].group ?? '') ||
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
  const index = new SpatialIndex();
  for (const node of nodes) if (node.pinned) index.add(expand(rect(node), config.nodeGap / 2));
  const placed = new Set<number>();
  const labelGaps = new Float64Array(n);
  for (const edge of scene.edges) {
    const root = edge.endpoints[rootEndpoint(scene, edge)];
    if (root)
      labelGaps[root.node] = Math.max(
        labelGaps[root.node],
        (vertical ? edge.label.height : edge.label.width) + grid * 3,
      );
  }
  let major = 0;
  for (const list of ordered) {
    await work.step();

    let minor = 0,
      max = 0;
    for (const i of list) {
      const node = nodes[i],
        along = vertical ? node.height : node.width,
        across = vertical ? node.width : node.height;
      max = Math.max(max, along);
      if (node.pinned) continue;
      const a = reverse ? -major - along : major;
      const incoming = back[i].filter((p) => placed.has(p));
      const desired = incoming.length
        ? incoming.reduce(
            (sum, p) =>
              sum + (vertical ? nodes[p].x + nodes[p].width / 2 : nodes[p].y + nodes[p].height / 2),
            0,
          ) /
            incoming.length -
          across / 2
        : minor;
      let b = Math.max(minor, desired);
      node.x = vertical ? b : a;
      node.y = vertical ? a : b;
      // Deterministic local collision escape; jump beyond obstacles, never scan huge coordinates.
      for (let attempt = 0; attempt <= nodes.length; attempt++) {
        const box = expand(rect(node), config.nodeGap / 2),
          hits = index.query(box).filter((j) => intersects(index.boxes[j], box));
        if (!hits.length) break;
        b = Math.max(...hits.map((j) => index.boxes[j][vertical ? 2 : 3])) + config.nodeGap;
        node.x = vertical ? b : a;
        node.y = vertical ? a : b;
        if (attempt === nodes.length)
          throw new GpuError('resource-limit', 'Layout collision budget exceeded');
      }
      node.x = Math.round(node.x / grid) * grid;
      node.y = Math.round(node.y / grid) * grid;
      index.add(expand(rect(node), config.nodeGap / 2));
      placed.add(i);
      minor = b + across + config.nodeGap;
    }
    const labelGap = list.reduce((gap, i) => Math.max(gap, labelGaps[i]), 0);
    major += max + Math.max(config.rankGap, labelGap);
  }
}
