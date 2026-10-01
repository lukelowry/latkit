import type { Index, ComponentPort, Queryable } from '@latkit/model';
import type { RGBA, TextRun, FieldValues, Preparation, NativeReader } from '@latkit/gpu';
import type {
  DiagramData,
  DiagramHit,
  Point,
  Shape,
  ComponentOptions,
  ConnectionOptions,
} from './data.js';
export type Reader =
  Pick<Preparation, 'query' | 'fields' | 'scale' | 'signal' | 'at'> | NativeReader;
export type Rect = readonly [number, number, number, number];
export interface Label {
  text: string;
  width: number;
  height: number;
  ascent: number;
  runs: readonly TextRun[];
}
export interface Port {
  name: string;
  side: 'left' | 'right' | 'top' | 'bottom';
  order: number;
  definition: ComponentPort;
  label: Label;
  color: RGBA;
  status?: RGBA;
  position: Point;
  normal: Point;
}
export interface Node {
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
  visible: boolean;
  sourceVisible: boolean;
  color: RGBA;
  status?: RGBA;
  shade: number;
  label: Label;
  ports: Port[];
  options: ComponentOptions;
  group?: string;
}
export interface Endpoint {
  node: number;
  port: string | null;
  role: string;
  ordinal: number;
  direction?: 'in' | 'out' | 'both';
}
export interface Edge {
  hit: Exclude<DiagramHit, { kind: 'group' }>;
  endpoints: Endpoint[];
  visible: boolean;
  color: RGBA;
  width: number;
  flow: number;
  shade: number;
  label: Label;
  options: ConnectionOptions;
  paths: readonly (readonly Point[])[];
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
  nodes: Node[];
  edges: Edge[];
  groups: GroupBox[];
  bounds: Rect;
  bytes: number;
  routeBytes: number;
  routeClearance?: number;
  endpoints: number;
  versions: ReadonlyMap<Queryable, string>;
}
export const emptyLabel: Label = { text: '', width: 0, height: 0, ascent: 0, runs: [] };
export function rect(node: Node): Rect {
  return [node.x, node.y, node.x + node.width, node.y + node.height];
}
export function positions(
  nodes: readonly Node[],
  only?: ReadonlySet<number>,
): Readonly<Record<string, FieldValues>> {
  const grouped = new Map<string, Node[]>();
  nodes.forEach((node, i) => {
    if (!only || only.has(i)) {
      const type = node.index.type;
      const entries = grouped.get(type) ?? [];
      entries.push(node);
      grouped.set(type, entries);
    }
  });
  return Object.fromEntries(
    [...grouped].map(([type, entries]) => {
      const values = Float64Array.from(entries.flatMap((node) => [node.x, node.y]));
      return [
        type,
        {
          index: entries[0].index,
          rows: { kind: 'indices', values: Uint32Array.from(entries, (node) => node.row) },
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
