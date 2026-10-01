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
export interface ComponentOptions {
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
  readonly ports?: Readonly<Record<string, PortOptions>>;
}
export interface ConnectionOptions {
  readonly rows?: RowSelection;
  readonly route?: 'orthogonal' | 'straight' | RouteStrategy;
  readonly appearance?: 'wire' | 'tag';
  readonly color?: ColorScale | null;
  /** Widths are CSS pixels; flow is CSS pixels per second. */
  readonly width?: Scale | null;
  readonly flow?: Scale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: Labels | null;
  readonly arrows?: readonly string[];
}
export interface Group {
  readonly label?: string;
  readonly components: Readonly<Record<string, RowSelection>>;
  readonly collapsed?: boolean;
  readonly parent?: string;
}
export interface DiagramData {
  readonly source: Queryable;
  readonly components: Readonly<Record<string, ComponentOptions>>;
  readonly connections?: Readonly<Record<string, ConnectionOptions>>;
  readonly groups?: Readonly<Record<string, Group>>;
}
export interface EntityRef {
  readonly type: string;
  readonly id: string;
}
export type DiagramItem =
  | (EntityRef & { readonly kind: 'component' | 'connection' })
  | (EntityRef & { readonly kind: 'port'; readonly port: string })
  | { readonly kind: 'group'; readonly id: string };
export type DiagramHit =
  (Exclude<DiagramItem, { kind: 'group' }> & DataHit) | Extract<DiagramItem, { kind: 'group' }>;
export interface RouteEndpoint {
  readonly position: Point;
  readonly normal: Point;
  readonly role: string;
}
export interface RouteRequest {
  readonly endpoints: readonly RouteEndpoint[];
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
