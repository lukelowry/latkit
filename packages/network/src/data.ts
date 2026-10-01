import type { Queryable, RowSelection } from '@latkit/model';
import type {
  DataHit,
  FieldInput,
  RGBA,
  TextFont,
  Position2D,
  Scale,
  ColorScale,
} from '@latkit/gpu';

export interface Labels {
  readonly field: FieldInput;
  readonly font?: TextFont;
  readonly size?: number;
  readonly maxCount?: number;
  readonly color?: RGBA;
}
export interface VertexOptions {
  readonly rows?: RowSelection;
  readonly position?: Position2D;
  readonly color?: ColorScale | null;
  readonly size?: Scale | null;
  readonly height?: Scale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: Labels | null;
}
export interface EdgeOptions {
  readonly rows?: RowSelection;
  /**
   * Two reference fields naming the vertices each row joins, such as a branch's two buses.
   * Omitted, the type is a net: each row joins the vertices whose references name it, drawn as a
   * segment between two or a star of more.
   */
  readonly ends?: readonly [source: string, target: string];
  /** Intermediate bends, a native list of two-component floating-point vectors; requires ends. */
  readonly bends?: FieldInput;
  readonly curve?: 'linear' | 'geodesic';
  /** A net's star center; otherwise the centroid of its vertices. */
  readonly junction?: Position2D;
  readonly color?: ColorScale | null;
  readonly dash?: FieldInput | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: Labels | null;
}
export interface PathOptions {
  readonly source?: Queryable;
  readonly rows?: RowSelection;
  readonly points: FieldInput;
  readonly curve?: 'linear' | 'geodesic';
  readonly widthPx?: number;
  readonly baseColor?: RGBA;
  readonly color?: ColorScale | null;
  readonly visible?: FieldInput | null;
  readonly labels?: Labels | null;
  /** Decorative paths do not participate in picking by default. */
  readonly pickable?: boolean;
}
/** Positions are longitude/latitude in degrees when the drawn types' spatial system is geographic. */
export interface NetworkData {
  /** Borrowed. Renderer destruction never closes an acquisition. */
  readonly source: Queryable;
  /** Keys name native model types, not additional layer identities. */
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly paths?: Readonly<Record<string, PathOptions>>;
}
export interface NetworkItem extends DataHit {
  readonly kind: 'vertex' | 'edge' | 'path';
}
