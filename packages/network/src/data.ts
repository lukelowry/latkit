import { itemKey, type Data, type FieldInput, type Item, type RowSelection } from '@latkit/model';
import type { Channel, ColorChannel, Labels, Marker } from '@latkit/gpu';

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
  readonly labels?: string | Labels | null;
}
/** How a type's edges draw. */
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
  /** Where a net's star meets, drawing every net as a star; otherwise the centroid of its ends. */
  readonly x?: Channel;
  readonly y?: Channel;
  /**
   * How an edge between geographic points runs over the earth: `straight` in longitude and
   * latitude, or `geodesic` along the great circle. Unset, it takes the shortest way: `geodesic`
   * on the globe, `straight` on a flat map.
   */
  readonly route?: 'straight' | 'geodesic';
  /** Line width in CSS pixels; a field spans 1 to 4. `edgeWidthPx` by default. */
  readonly widthPx?: Channel;
  /** `edgeColor` by default. */
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
  readonly labels?: string | Labels | null;
}
/** A drawn row: a vertex or an edge. */
export interface NetworkItem extends Item {
  readonly kind: 'vertex' | 'edge';
}
/** An item's identity: its kind, row space, and row; appends keep it. */
export function networkKey(item: NetworkItem): string {
  return itemKey(item, item.kind);
}
/** What the renderer draws. Positions are longitude/latitude in degrees for geographic data. */
export interface NetworkData {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
}
/** The drawn records of a config. */
export function networkData({ source, vertices, edges }: NetworkData): NetworkData {
  return { source, vertices, edges };
}
