import {
  sameItem as sameRow,
  type Data,
  type FieldInput,
  type Item,
  type RowSelection,
} from '@latkit/model';
import type { kit, Labels, RGBA, ColorScale, Position2D, Scale } from '@latkit/gpu';

/** Labels beside a type's items, sized in CSS pixels; `fontSizePx` by default. */
export interface NetworkLabels extends Labels {
  readonly sizePx?: number;
  /**
   * Leave out a label whose text repeats one placed within this many CSS pixels, as when buses
   * of one substation share its name; 0, the default, labels every row it has room for.
   */
  readonly repeatSpacingPx?: number;
}
/** A field name stands for that field with defaults: `color: 'load'`, `labels: 'name'`. */
export interface VertexOptions {
  readonly rows?: RowSelection;
  /** Defaults to the type's first positioned field: geographic, else cartesian. */
  readonly position?: Position2D;
  readonly color?: string | ColorScale | null;
  /** The color without a `color` field; `vertexBaseColor` by default. */
  readonly baseColor?: RGBA;
  /** Marker radius in CSS pixels, from a field; `vertexRadiusPx` without one. */
  readonly sizePx?: string | Scale | null;
  readonly height?: string | Scale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: string | NetworkLabels | null;
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
  /** `straight` in the data's coordinates, or `geodesic` along great circles. */
  readonly route?: 'straight' | 'geodesic';
  /** A net's star center; otherwise the centroid of its vertices. */
  readonly junction?: Position2D;
  /** `edgeWidthPx` by default. */
  readonly widthPx?: number;
  readonly color?: string | ColorScale | null;
  /** The color without a `color` field; `edgeBaseColor`, or the colors of its ends, by default. */
  readonly baseColor?: RGBA;
  readonly dash?: FieldInput | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: string | NetworkLabels | null;
}
export interface PathOptions {
  /** Defaults to the network's source. */
  readonly source?: Data;
  readonly rows?: RowSelection;
  readonly points: FieldInput;
  readonly route?: 'straight' | 'geodesic';
  readonly widthPx?: number;
  readonly color?: string | ColorScale | null;
  readonly baseColor?: RGBA;
  readonly visible?: FieldInput | null;
  readonly labels?: string | NetworkLabels | null;
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
export const FIELD_OPTIONS = ['color', 'sizePx', 'height', 'labels'] as const;
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
