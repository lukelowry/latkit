import type { Index, Queryable } from '@latkit/model';
import type { kit, RGBA } from '@latkit/gpu';
import type { DiagramData, DiagramHit, Point, Shape, VertexData, EdgeData } from './data.js';
export type Reader =
  Pick<kit.Preparation, 'query' | 'fields' | 'scale' | 'signal' | 'at'> | kit.NativeReader;
export type Rect = readonly [number, number, number, number];
export interface Label {
  text: string;
  width: number;
  height: number;
  ascent: number;
  runs: readonly kit.TextRun[];
}
/** A reference field wiring its vertex to a drawn net. */
export interface Port {
  name: string;
  /** The net type it references. */
  to: string;
  direction?: 'in' | 'out';
  label: Label;
  side: 'left' | 'right' | 'top' | 'bottom';
  order: number;
  marker: 'directional' | 'circle' | 'diamond';
  connected: boolean;
  color: RGBA;
  status?: RGBA;
  position: Point;
  normal: Point;
}
export interface Vertex {
  hit: Exclude<DiagramHit, { kind: 'group' }>;
  index: Index;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  header: number;
  pinned: boolean;
  shape: Shape;
  radius: number;
  visible: boolean;
  sourceVisible: boolean;
  color: RGBA;
  status?: RGBA;
  shade: number;
  label: Label;
  ports: Port[];
  options: VertexData;
  group?: string;
}
/** One vertex an edge joins: through a port for a net, or directly for a row's own end. */
export interface End {
  vertex: number;
  port: string | null;
  direction?: 'in' | 'out';
}
export interface Edge {
  hit: Exclude<DiagramHit, { kind: 'group' }>;
  ends: End[];
  visible: boolean;
  color: RGBA;
  width: number;
  flow: number;
  shade: number;
  label: Label;
  options: EdgeData;
  paths: readonly (readonly Point[])[];
  offsets: readonly number[];
  labelBounds: readonly Rect[];
  arrows: readonly { point: Point; direction: Point }[];
  junctions: readonly Point[];
  anchor: Point;
  bounds: Rect;
}
export interface GroupBox {
  id: string;
  label: Label;
  bounds: Rect;
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
  portSizePx?: number;
  ends: number;
  versions: ReadonlyMap<Queryable, string>;
}
export const emptyLabel: Label = { text: '', width: 0, height: 0, ascent: 0, runs: [] };
export function rect(vertex: Vertex): Rect {
  return [vertex.x, vertex.y, vertex.x + vertex.width, vertex.y + vertex.height];
}
export function positions(
  vertices: readonly Vertex[],
  only?: ReadonlySet<number>,
): Readonly<Record<string, kit.FieldValues>> {
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
        } satisfies kit.FieldValues,
      ];
    }),
  );
}
