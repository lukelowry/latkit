import type { Data, FieldInput, RowSelection } from '@latkit/model';
import type { DataHit, kit, RGBA } from '@latkit/gpu';
export type Point = readonly [x: number, y: number];
export type Shape = 'rectangle' | 'rounded' | 'ellipse' | 'diamond';
export interface Labels {
  readonly field: FieldInput;
  readonly font?: kit.TextFont;
  /** Diagram units, independent of camera zoom. */
  readonly size?: number;
  readonly color?: RGBA;
  readonly maxCount?: number;
  readonly maxWidth?: number;
  readonly overflow?: 'wrap' | 'ellipsis';
}
export interface PortOptions {
  readonly side?: 'left' | 'right' | 'top' | 'bottom';
  readonly order?: number;
  readonly marker?: 'directional' | 'circle' | 'diamond';
  readonly label?: string;
  readonly color?: string | kit.ColorScale | null;
  readonly status?: string | kit.ColorScale | null;
}
export interface VertexOptions {
  readonly rows?: RowSelection;
  readonly position?: kit.Position2D | null;
  readonly size?: FieldInput | null;
  readonly shape?: Shape;
  readonly cornerRadius?: number;
  /** Automatic sizing reserves room around the title. Default: center. */
  readonly labelPosition?: 'header' | 'center';
  /** A field name stands for that field with defaults: `color: 'load'`, `labels: 'name'`. */
  readonly color?: string | kit.ColorScale | null;
  readonly status?: string | kit.ColorScale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: string | Labels | null;
  /** Keyed by reference field. Each field naming a drawn net is a port. */
  readonly ports?: Readonly<Record<string, PortOptions>>;
}
export interface EdgeOptions {
  readonly rows?: RowSelection;
  /**
   * Two reference fields naming the vertices each row joins, such as a dependency's two tasks.
   * Omitted, the type is a net: each row joins the ports whose references name it.
   */
  readonly ends?: readonly [source: string, target: string];
  readonly route?: 'orthogonal' | 'straight' | RouteStrategy;
  readonly appearance?: 'wire' | 'tag';
  readonly color?: string | kit.ColorScale | null;
  /** Widths are CSS pixels; flow is CSS pixels per second. */
  readonly width?: string | kit.Scale | null;
  readonly flow?: string | kit.Scale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: string | Labels | null;
  /** Arrowheads where flow arrives: a row's target end, or a net's input ports. */
  readonly arrows?: boolean;
}
export interface Group {
  readonly label?: string;
  readonly vertices: Readonly<Record<string, RowSelection>>;
  readonly collapsed?: boolean;
  readonly parent?: string;
}
export interface RowRef {
  readonly type: string;
  readonly id: string;
}
export type DiagramItem =
  | (RowRef & { readonly kind: 'vertex' | 'edge' })
  | (RowRef & { readonly kind: 'port'; readonly port: string })
  | { readonly kind: 'group'; readonly id: string };
export type DiagramHit =
  (Exclude<DiagramItem, { kind: 'group' }> & DataHit) | Extract<DiagramItem, { kind: 'group' }>;
export interface RouteEnd {
  readonly position: Point;
  readonly normal: Point;
  readonly direction?: 'in' | 'out';
}
export interface RouteRequest {
  readonly ends: readonly RouteEnd[];
  readonly clearance: number;
  readonly signal: AbortSignal;
  readonly obstacles: readonly (readonly [number, number, number, number])[];
}
export interface RouteStrategy {
  /** Return one path per branch. Coordinates are diagram units. */
  route(request: RouteRequest): readonly (readonly Point[])[];
}
export function itemKey(item: DiagramItem): string {
  return JSON.stringify(
    item.kind === 'group'
      ? ['group', item.id]
      : [item.kind, item.type, item.id, item.kind === 'port' ? item.port : ''],
  );
}

/** Option keys whose string value names a field, in entries and their ports. */
export const FIELD_OPTIONS = ['color', 'status', 'labels', 'width', 'flow'] as const;
type Full<T> = kit.Expanded<T, (typeof FIELD_OPTIONS)[number]>;
export type PortData = Full<PortOptions>;
export type VertexData = Omit<Full<VertexOptions>, 'ports'> & {
  readonly ports?: Readonly<Record<string, PortData>>;
};
export type EdgeData = Full<EdgeOptions>;
/** What the renderer draws, with every shorthand expanded. */
export interface DiagramData {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, VertexData>>;
  readonly edges?: Readonly<Record<string, EdgeData>>;
  readonly groups?: Readonly<Record<string, Group>>;
}
interface Drawn {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly groups?: Readonly<Record<string, Group>>;
}
/** The drawn records of a config whose field shorthands the view already expanded. */
export function diagramData(config: Drawn): DiagramData {
  const { source, vertices, edges, groups } = config as DiagramData;
  return { source, vertices, edges, groups };
}
function expand(entry: object): object {
  const next: Record<string, unknown> = { ...entry };
  for (const key of FIELD_OPTIONS)
    if (typeof next[key] === 'string') next[key] = { field: next[key] };
  if (next.ports) next.ports = expandRecord(next.ports as Readonly<Record<string, object>>);
  return next;
}
function expandRecord(record: Readonly<Record<string, object>> | undefined) {
  return record && Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v)]));
}
/** The drawn records of a config no view normalized, such as one `arrange` takes. */
export function expandedData(config: Drawn): DiagramData {
  return {
    source: config.source,
    vertices: expandRecord(config.vertices) as DiagramData['vertices'],
    edges: expandRecord(config.edges) as DiagramData['edges'],
    groups: config.groups,
  };
}
