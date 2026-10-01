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
}
export interface LayoutGraph {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly (readonly [number, number])[];
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
}
export function layoutOptions(value: LayoutOptions = {}): Required<LayoutOptions> {
  const result = {
    algorithm: value.algorithm ?? 'layered',
    direction: value.direction ?? 'right',
    nodeGap: value.nodeGap ?? 24,
    rankGap: value.rankGap ?? 64,
  };
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
        })),
        edges: pairs,
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
  for (const [a, b] of pairs) {
    next[a].push(b);
    back[b].push(a);
  }
  // Iterative Kosaraju: cycles form one rank unit without recursion limits.
  const seen = new Uint8Array(n),
    order: number[] = [];
  for (let root = 0; root < n; root++)
    if (!seen[root]) {
      const stack: [number, number][] = [[root, 0]];
      seen[root] = 1;
      while (stack.length) {
        if ((stack.length & 1023) === 0) await work.step();
        const top = stack[stack.length - 1];
        if (top[1] < next[top[0]].length) {
          const v = next[top[0]][top[1]++];
          if (!seen[v]) {
            seen[v] = 1;
            stack.push([v, 0]);
          }
        } else {
          order.push(top[0]);
          stack.pop();
        }
      }
    }
  const component = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = order.length - 1; i >= 0; i--)
    if (component[order[i]] < 0) {
      const stack = [order[i]];
      component[order[i]] = count;
      while (stack.length) {
        if ((stack.length & 1023) === 0) await work.step();
        const v = stack.pop()!;
        for (const w of back[v])
          if (component[w] < 0) {
            component[w] = count;
            stack.push(w);
          }
      }
      count++;
    }
  const graph = Array.from({ length: count }, () => new Set<number>()),
    degree = new Uint32Array(count),
    rank = new Uint32Array(count);
  for (const [a, b] of pairs)
    if (component[a] !== component[b] && !graph[component[a]].has(component[b])) {
      graph[component[a]].add(component[b]);
      degree[component[b]]++;
    }
  const queue: number[] = [];
  degree.forEach((v, i) => {
    if (!v) queue.push(i);
  });
  for (let i = 0; i < queue.length; i++)
    for (const v of graph[queue[i]]) {
      rank[v] = Math.max(rank[v], rank[queue[i]] + 1);
      if (!--degree[v]) queue.push(v);
    }
  const levels = new Map<number, number[]>();
  nodes.forEach((_, i) => {
    const r = rank[component[i]],
      list = levels.get(r) ?? [];
    list.push(i);
    levels.set(r, list);
  });
  const vertical = config.direction === 'down' || config.direction === 'up',
    reverse = config.direction === 'left' || config.direction === 'up';
  const index = new SpatialIndex();
  for (const node of nodes) if (node.pinned) index.add(expand(rect(node), config.nodeGap / 2));
  let major = 0;
  for (const [, list] of [...levels].sort((a, b) => a[0] - b[0])) {
    await work.step();
    list.sort((a, b) => {
      const x = JSON.stringify([nodes[a].group ?? '', nodes[a].index.type, nodes[a].hit.id]),
        y = JSON.stringify([nodes[b].group ?? '', nodes[b].index.type, nodes[b].hit.id]);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    let minor = 0,
      max = 0;
    for (const i of list) {
      const node = nodes[i],
        along = vertical ? node.height : node.width,
        across = vertical ? node.width : node.height;
      max = Math.max(max, along);
      if (node.pinned) continue;
      const a = reverse ? -major - along : major;
      let b = minor;
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
      minor = b + across + config.nodeGap;
    }
    major += max + config.rankGap;
  }
}
