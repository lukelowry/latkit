import type { Data, RowSelection } from '@latkit/model';
import type { kit, RGBA } from '@latkit/gpu';
export type Point = readonly [x: number, y: number];
export type Shape = 'rectangle' | 'rounded' | 'ellipse' | 'diamond';
export interface Labels {
  readonly field: kit.FieldInput;
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
  readonly size?: kit.FieldInput | null;
  readonly shape?: Shape;
  readonly cornerRadius?: number;
  /** Automatic sizing reserves room around the title. Default: center. */
  readonly labelPosition?: 'header' | 'center';
  /** A field name stands for that field with defaults: `color: 'load'`, `labels: 'name'`. */
  readonly color?: string | kit.ColorScale | null;
  readonly status?: string | kit.ColorScale | null;
  readonly visible?: kit.FieldInput | null;
  readonly shade?: kit.FieldInput | null;
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
  readonly visible?: kit.FieldInput | null;
  readonly shade?: kit.FieldInput | null;
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
  (Exclude<DiagramItem, { kind: 'group' }> & kit.DataHit) | Extract<DiagramItem, { kind: 'group' }>;
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

type Shorthand = 'color' | 'status' | 'labels' | 'width' | 'flow';
type Full<T> = {
  readonly [K in keyof T]: K extends Shorthand ? Exclude<T[K], string> : T[K];
};
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
const expanded = new WeakMap<object, object>();
/** Expand shorthands, keeping each unchanged entry's identity so caches keyed on it survive. */
function full<T extends object>(options: T): T {
  let found = expanded.get(options);
  if (!found) {
    const result: Record<string, unknown> = { ...(options as Record<string, unknown>) };
    for (const key of ['color', 'status', 'width', 'flow', 'labels'])
      if (typeof result[key] === 'string') result[key] = { field: result[key] };
    if (result.ports)
      result.ports = Object.fromEntries(
        Object.entries(result.ports as Record<string, object>).map(([k, v]) => [k, full(v)]),
      );
    found = Object.freeze(result);
    expanded.set(options, found);
  }
  return found as T;
}
const all = <T extends object>(entries: Readonly<Record<string, T>> | undefined) =>
  entries && Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, full(v)]));
export function diagramData(config: {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly groups?: Readonly<Record<string, Group>>;
}): DiagramData {
  return {
    source: config.source,
    vertices: all(config.vertices) as Record<string, VertexData>,
    edges: all(config.edges) as Record<string, EdgeData> | undefined,
    groups: config.groups,
  };
}
