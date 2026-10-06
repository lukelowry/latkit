import {
  sameItem as sameRow,
  type Data,
  type FieldInput,
  type Item,
  type RowSelection,
} from '@latkit/model';
import type { Channel, ColorChannel, Labels, Marker } from '@latkit/gpu';

/** Labels beside a type's items. */
export interface NetworkLabels extends Labels {
  /** The shared `fontSizePx` by default. */
  readonly fontSizePx?: number;
  /**
   * Leave out a label whose text repeats one placed within this many CSS pixels, as when buses
   * of one substation share its name; 0, the default, labels every row it has room for.
   */
  readonly repeatSpacingPx?: number;
}
/**
 * How a type's vertices draw. Each channel takes one value for every row, a field, or a scale:
 * `color: 'load'`, `radiusPx: { field: 'load', range: [2, 12] }`. A field name labels by that field.
 */
export interface VertexOptions {
  readonly rows?: RowSelection;
  /** Where each row draws, in the data's coordinates; layout places rows without, as `layout` says. */
  readonly x?: Channel;
  readonly y?: Channel;
  /** Height above the drawing, from 0 to 1 of `zScale`; a field spans 0 to 1. */
  readonly z?: Channel;
  /** `vertexColor` by default. */
  readonly color?: ColorChannel;
  /** Marker radius in CSS pixels; a field spans 2 to 8. `vertexRadiusPx` by default. */
  readonly radiusPx?: Channel;
  /** How each row draws in its radius: a disc, `shape('ellipse')`, by default. */
  readonly marker?: Marker;
  /** Shown where true or positive; every row by default. */
  readonly visible?: Channel<boolean>;
  readonly shade?: Channel;
  readonly labels?: string | NetworkLabels | null;
}
/** How the lines of edges and paths draw. */
export interface LineOptions {
  readonly rows?: RowSelection;
  /** `straight` in the data's coordinates, or `geodesic` along great circles. */
  readonly route?: 'straight' | 'geodesic';
  /** Line width in CSS pixels; a field spans 1 to 4. `edgeWidthPx` or `pathWidthPx` by default. */
  readonly widthPx?: Channel;
  /** `edgeColor` or `pathColor` by default. */
  readonly color?: ColorChannel;
  /** Dashed where true or positive. */
  readonly dash?: Channel<boolean>;
  /**
   * How far comets move along the line each second, in CSS pixels, from its first end toward its
   * second; negative runs the other way, and 0 draws none. A field spans 0 to 40.
   */
  readonly flowPx?: Channel;
  /** Shown where true or positive; every row by default. */
  readonly visible?: Channel<boolean>;
  readonly shade?: Channel;
  readonly labels?: string | NetworkLabels | null;
}
export interface EdgeOptions extends LineOptions {
  /**
   * Two reference fields naming the vertices each row joins, such as a branch's two buses.
   * Omitted, the type is a net: each row joins the vertices whose references name it, drawn as a
   * segment between two or a star of more.
   */
  readonly ends?: readonly [source: string, target: string];
  /** Intermediate bends, a native list of two-component floating-point vectors; requires ends. */
  readonly bends?: FieldInput;
  /** Where a net's star meets, drawing every net as a star; otherwise the centroid of its ends. */
  readonly x?: Channel;
  readonly y?: Channel;
}
export interface PathOptions extends LineOptions {
  /** Defaults to the network's source. */
  readonly source?: Data;
  readonly points: FieldInput;
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
/** What the renderer draws. Positions are longitude/latitude in degrees for geographic data. */
export interface NetworkData {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly paths?: Readonly<Record<string, PathOptions>>;
}
/** The drawn records of a config. */
export function networkData({ source, vertices, edges, paths }: NetworkData): NetworkData {
  return { source, vertices, edges, paths };
}
