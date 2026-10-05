import type { FieldValues, Index } from '@latkit/model';
import type { Point, TextLayout } from '@latkit/gpu';
import type { DiagramData, DiagramItem, SceneItem, Shape, VertexData, EdgeData } from './data.js';
import { itemKey } from './data.js';
import type { Obstacles, Route } from './route.js';
export type Rect = readonly [number, number, number, number];
/** A reference field wiring its vertex to a drawn net. */
export interface Port {
  name: string;
  /** The net type it references. */
  to: string;
  direction?: 'in' | 'out';
  label: TextLayout;
  side: 'left' | 'right' | 'top' | 'bottom';
  order: number;
  marker: 'directional' | 'circle' | 'diamond';
  connected: boolean;
  /** Where the port meets its vertex's edge, and the way out of it. */
  position: Point;
  normal: Point;
}
export interface Vertex {
  hit: SceneItem;
  index: Index;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The title band's height; zero for a centered title. */
  header: number;
  pinned: boolean;
  shape: Shape;
  radius: number;
  visible: boolean;
  sourceVisible: boolean;
  label: TextLayout;
  ports: Port[];
  /** The slot of the first port; the others follow in order. */
  portSlot: number;
  options: VertexData;
  group?: string;
}
/** One vertex an edge joins: through a port for a net, or directly for a row's own end. */
export interface End {
  vertex: number;
  port: string | null;
  direction?: 'in' | 'out';
}
export interface Arrow {
  readonly point: Point;
  readonly direction: Point;
}
/** An edge's wire: polylines from its root, the distance along at each start, and its marks. */
export interface Wire {
  readonly paths: readonly (readonly Point[])[];
  readonly offsets: readonly number[];
  readonly junctions: readonly Point[];
  readonly arrows: readonly Arrow[];
  readonly bounds: Rect;
}
export interface Edge extends Wire {
  hit: SceneItem;
  ends: End[];
  visible: boolean;
  label: TextLayout;
  options: EdgeData;
  paths: readonly (readonly Point[])[];
  offsets: readonly number[];
  junctions: readonly Point[];
  arrows: readonly Arrow[];
  bounds: Rect;
  /** The route before tracks set it apart from other nets: what an unchanged edge keeps. */
  route: Route | null;
  /** Where its label draws, its top-left; empty without one. */
  labels: readonly Point[];
}
export interface GroupBox {
  id: string;
  label: TextLayout;
  bounds: Rect;
  /** The title band's height. */
  header: number;
  collapsed: boolean;
  members: readonly number[];
  parent?: string;
}
export interface Scene {
  data: DiagramData;
  vertices: Vertex[];
  edges: Edge[];
  groups: GroupBox[];
  bounds: Rect;
  bytes: number;
  routeBytes: number;
  routeClearance?: number;
  portSize?: number;
  ends: number;
  /** First slot of each kind: vertices from zero, then every port, edges, and groups. */
  slots: { ports: number; edges: number; groups: number; count: number };
  /** Where each type's rows start among its kind, in read order; a vertex type's first port slot. */
  types: {
    vertices: Map<string, { first: number; ports: number; names: readonly string[] }>;
    edges: Map<string, { first: number }>;
  };
  /** What the routes avoid, once routed. */
  obstacles?: Obstacles;
  /** Each item's slot by its key, built on first use. */
  keys?: Map<string, number>;
}
export const emptyLabel: TextLayout = Object.freeze({
  runs: [],
  width: 0,
  height: 0,
  ascent: 0,
  descent: 0,
});
export function rect(vertex: Vertex): Rect {
  return [vertex.x, vertex.y, vertex.x + vertex.width, vertex.y + vertex.height];
}
/** A stable point on the longest segment, for locate and reveal. */
export function edgeAnchor(edge: Edge): Point {
  let point: Point = [0, 0],
    longest = -1;
  for (const path of edge.paths)
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1],
        b = path[i],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length > longest) {
        point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        longest = length;
      }
    }
  return point;
}
export function intersects(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
export function union(rectangles: Iterable<Rect>): Rect {
  let x = Infinity,
    y = Infinity,
    r = -Infinity,
    b = -Infinity;
  for (const q of rectangles) {
    x = Math.min(x, q[0]);
    y = Math.min(y, q[1]);
    r = Math.max(r, q[2]);
    b = Math.max(b, q[3]);
  }
  return x <= r ? [x, y, r, b] : [0, 0, 0, 0];
}
export function expand(r: Rect, n: number): Rect {
  return [r[0] - n, r[1] - n, r[2] + n, r[3] + n];
}
/** The item a slot draws. */
export function itemAt(scene: Scene, slot: number): DiagramItem | null {
  const { slots, vertices } = scene;
  if (slot < slots.ports) return vertices[slot]?.hit ?? null;
  if (slot < slots.edges) {
    // Ports are numbered in vertex order, so a binary search finds the vertex.
    let lo = 0,
      hi = vertices.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (vertices[mid].portSlot <= slot) lo = mid;
      else hi = mid - 1;
    }
    const vertex = vertices[lo],
      port = vertex?.ports[slot - vertex.portSlot];
    return port ? { ...vertex.hit, kind: 'port', port: port.name } : null;
  }
  if (slot < slots.groups) return scene.edges[slot - slots.edges]?.hit ?? null;
  const group = scene.groups[slot - slots.groups];
  return group ? { kind: 'group', id: group.id } : null;
}
/** The shared lookup at API boundaries; geometry uses the scene's numeric slots directly. */
export function itemSlots(scene: Scene): ReadonlyMap<string, number> {
  if (!scene.keys) {
    const keys = new Map<string, number>();
    scene.vertices.forEach((vertex, slot) => {
      keys.set(itemKey(vertex.hit), slot);
      vertex.ports.forEach((port, i) =>
        keys.set(itemKey({ ...vertex.hit, kind: 'port', port: port.name }), vertex.portSlot + i),
      );
    });
    scene.edges.forEach((edge, i) => keys.set(itemKey(edge.hit), scene.slots.edges + i));
    scene.groups.forEach((group, i) =>
      keys.set(itemKey({ kind: 'group', id: group.id }), scene.slots.groups + i),
    );
    scene.keys = keys;
  }
  return scene.keys;
}
export function positions(
  vertices: readonly Vertex[],
  only?: ReadonlySet<number>,
): Readonly<Record<string, FieldValues>> {
  const grouped = new Map<string, Vertex[]>();
  vertices.forEach((vertex, i) => {
    if (!only || only.has(i)) {
      const type = vertex.index.type;
      const entries = grouped.get(type) ?? [];
      entries.push(vertex);
      grouped.set(type, entries);
    }
  });
  return Object.fromEntries(
    [...grouped].map(([type, entries]) => {
      const values = Float64Array.from(entries.flatMap((vertex) => [vertex.x, vertex.y]));
      return [
        type,
        {
          index: entries[0].index,
          rows: { kind: 'indices', values: Uint32Array.from(entries, (vertex) => vertex.row) },
          values: {
            kind: 'vector',
            offset: 0,
            length: entries.length,
            size: 2,
            values: { kind: 'numeric', offset: 0, length: values.length, values },
          },
        } satisfies FieldValues,
      ];
    }),
  );
}
