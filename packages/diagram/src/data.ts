import type { Queryable, RowSelection } from '@latkit/model';
import type {
  ColorScale,
  DataHit,
  FieldInput,
  Position2D,
  RGBA,
  Scale,
  TextFont,
} from '@latkit/gpu';
export type Point = readonly [x: number, y: number];
export type Shape = 'rectangle' | 'rounded' | 'ellipse' | 'diamond';
export interface Labels {
  readonly field: FieldInput;
  readonly font?: TextFont;
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
  readonly color?: ColorScale | null;
  readonly status?: ColorScale | null;
}
export interface VertexOptions {
  readonly rows?: RowSelection;
  readonly position?: Position2D | null;
  readonly size?: FieldInput | null;
  readonly shape?: Shape;
  readonly cornerRadius?: number;
  /** Automatic sizing reserves room around the title. Default: center. */
  readonly labelPosition?: 'header' | 'center';
  readonly color?: ColorScale | null;
  readonly status?: ColorScale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: Labels | null;
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
  readonly color?: ColorScale | null;
  /** Widths are CSS pixels; flow is CSS pixels per second. */
  readonly width?: Scale | null;
  readonly flow?: Scale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: Labels | null;
  /** Arrowheads where flow arrives: a row's target end, or a net's input ports. */
  readonly arrows?: boolean;
}
export interface Group {
  readonly label?: string;
  readonly vertices: Readonly<Record<string, RowSelection>>;
  readonly collapsed?: boolean;
  readonly parent?: string;
}
export interface DiagramData {
  readonly source: Queryable;
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly groups?: Readonly<Record<string, Group>>;
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
