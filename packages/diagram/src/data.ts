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
export interface Labels {
  readonly field: FieldInput;
  readonly font?: TextFont;
  readonly size?: number;
  readonly color?: RGBA;
  readonly maxCount?: number;
}
export interface PortOptions {
  readonly side?: 'left' | 'right' | 'top' | 'bottom';
  readonly order?: number;
  readonly label?: string;
  readonly color?: ColorScale | null;
  readonly status?: ColorScale | null;
}
export interface ComponentOptions {
  readonly rows?: RowSelection;
  readonly position?: Position2D;
  /** Native two-lane width/height field; otherwise measured labels and ports determine size. */
  readonly size?: FieldInput;
  readonly color?: ColorScale | null;
  readonly status?: ColorScale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: Labels | null;
  /** Keys are ports declared by the model schema. */
  readonly ports?: Readonly<Record<string, PortOptions>>;
}
export interface ConnectionOptions {
  readonly rows?: RowSelection;
  readonly route?: 'orthogonal' | 'straight';
  readonly color?: ColorScale | null;
  readonly width?: Scale | null;
  readonly flow?: Scale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: Labels | null;
  /** Endpoint role names where arrowheads are drawn. */
  readonly arrows?: readonly string[];
}
/** Application presentation grouping; it is not stored in the domain Document. */
export interface Group {
  readonly label?: string;
  readonly components: Readonly<Record<string, RowSelection>>;
  readonly collapsed?: boolean;
}
export interface DiagramData {
  readonly source: Queryable;
  readonly components: Readonly<Record<string, ComponentOptions>>;
  readonly connections?: Readonly<Record<string, ConnectionOptions>>;
  readonly groups?: Readonly<Record<string, Group>>;
}
export type DiagramItem =
  | (DataHit & { readonly kind: 'component' | 'connection' })
  | (DataHit & { readonly kind: 'port'; readonly port: string })
  | { readonly kind: 'group'; readonly id: string };
