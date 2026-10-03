import {
  sameItem as sameRow,
  type Data,
  type FieldInput,
  type Item,
  type RowSelection,
} from '@latkit/model';
import type { kit, RGBA, ColorScale, Position2D, Scale, TextFont } from '@latkit/gpu';

export interface Labels {
  readonly field: FieldInput;
  readonly font?: TextFont;
  readonly size?: number;
  readonly maxCount?: number;
  readonly color?: RGBA;
}
/** A field name stands for that field with defaults: `color: 'load'`, `labels: 'name'`. */
export interface VertexOptions {
  readonly rows?: RowSelection;
  /** Defaults to the type's spatial field. */
  readonly position?: Position2D;
  readonly color?: string | ColorScale | null;
  readonly size?: string | Scale | null;
  readonly height?: string | Scale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: string | Labels | null;
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
  readonly color?: string | ColorScale | null;
  readonly dash?: FieldInput | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: string | Labels | null;
}
export interface PathOptions {
  /** Defaults to the network's source. */
  readonly source?: Data;
  readonly rows?: RowSelection;
  readonly points: FieldInput;
  readonly curve?: 'linear' | 'geodesic';
  readonly widthPx?: number;
  readonly baseColor?: RGBA;
  readonly color?: string | ColorScale | null;
  readonly visible?: FieldInput | null;
  readonly labels?: string | Labels | null;
  /** Decorative paths do not participate in picking by default. */
  readonly pickable?: boolean;
}
/** A drawn row: a vertex, an edge, or a path. */
export interface NetworkItem extends Item {
  readonly kind: 'vertex' | 'edge' | 'path';
}
/** Items are their kind and row; the index names the row space. */
export function sameItem(a: NetworkItem | null, b: NetworkItem | null): boolean {
  return a === b || (!!a && !!b && a.kind === b.kind && sameRow(a, b));
}
/** Option keys whose string value names a field. */
export const FIELD_OPTIONS = ['color', 'size', 'height', 'labels'] as const;
type Full<T> = kit.Expanded<T, (typeof FIELD_OPTIONS)[number]>;
export type VertexData = Full<VertexOptions>;
export type EdgeData = Full<EdgeOptions>;
export type PathData = Full<PathOptions>;
/** What the renderer draws. Positions are longitude/latitude in degrees for geographic data. */
export interface NetworkData {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, VertexData>>;
  readonly edges?: Readonly<Record<string, EdgeData>>;
  readonly paths?: Readonly<Record<string, PathData>>;
}

/** The drawn records of a config whose field shorthands the view already expanded. */
export function networkData(config: {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly paths?: Readonly<Record<string, PathOptions>>;
}): NetworkData {
  const { source, vertices, edges, paths } = config as NetworkData;
  return { source, vertices, edges, paths };
}
