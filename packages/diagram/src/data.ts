import type { Data, FieldValues, Item, RowSelection } from '@latkit/model';
import type { Channel, ColorChannel, Labels, Point } from '@latkit/gpu';
export type { Point };
export type Shape = 'rectangle' | 'rounded' | 'ellipse' | 'diamond';
/** Labels on a type's items, sized in diagram units so they zoom with the diagram. */
export interface DiagramLabels extends Labels {
  /** `fontSizePx` by default. */
  readonly size?: number;
  readonly maxWidth?: number;
  readonly overflow?: 'wrap' | 'ellipsis';
}
export interface PortOptions {
  readonly side?: 'left' | 'right' | 'top' | 'bottom';
  readonly order?: number;
  readonly marker?: 'directional' | 'circle' | 'diamond';
  readonly label?: string;
  readonly color?: ColorChannel;
  readonly status?: ColorChannel;
}
/**
 * How a type's vertices draw. Each channel takes one value for every row, a field, or a scale:
 * `color: 'load'`, `width: 120`. A field name labels by that field.
 */
export interface VertexOptions {
  readonly rows?: RowSelection;
  /** Where each block's top-left corner sits, in diagram units; the layout places rows without. */
  readonly x?: Channel;
  readonly y?: Channel;
  /** A block's size in diagram units; it fits its title and ports without one. */
  readonly width?: Channel;
  readonly height?: Channel;
  readonly shape?: Shape;
  readonly cornerRadius?: number;
  /** Automatic sizing reserves room around the title. Default: center. */
  readonly labelPosition?: 'header' | 'center';
  /** `vertexBaseColor` by default. */
  readonly color?: ColorChannel;
  /** A ring around the block. */
  readonly status?: ColorChannel;
  readonly visible?: Channel<boolean>;
  readonly shade?: Channel;
  readonly labels?: string | DiagramLabels | null;
  /** Keyed by reference field. Each field naming a drawn net is a port. */
  readonly ports?: Readonly<Record<string, PortOptions>>;
}
/** Where a type's vertices sit: x and y values to spread into the type's options. */
export interface Positions {
  readonly x: FieldValues;
  readonly y: FieldValues;
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
  /** `edgeBaseColor` by default. */
  readonly color?: ColorChannel;
  /** Line width in CSS pixels; a field spans 1 to 4. `edgeWidthPx` by default. */
  readonly widthPx?: Channel;
  /** How fast dashes move along the wire, in CSS pixels per second; a field spans 0 to 40. */
  readonly flow?: Channel;
  readonly visible?: Channel<boolean>;
  readonly shade?: Channel;
  readonly labels?: string | DiagramLabels | null;
  /** Arrowheads where flow arrives: a row's target end, or a net's input ports. */
  readonly arrows?: boolean;
}
export interface Group {
  readonly label?: string;
  readonly vertices: Readonly<Record<string, RowSelection>>;
  readonly collapsed?: boolean;
  readonly parent?: string;
}
/** A drawn row, as a vertex or an edge. */
export interface DiagramRow extends Item {
  readonly kind: 'vertex' | 'edge';
}
/** A vertex's port: the vertex row and the reference field the port draws. */
export interface DiagramPort extends Item {
  readonly kind: 'port';
  readonly port: string;
}
/** What a diagram selects, hovers, and picks: a row, a port, or a group of the config. */
export type DiagramItem =
  DiagramRow | DiagramPort | { readonly kind: 'group'; readonly id: string };
/** The item a scene vertex or edge draws, with the id its layout and labels key on. */
export interface SceneItem extends DiagramRow {
  readonly id: string;
}
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
/** A scene row as a public item, without the id its layout keys on. */
export function rowOf(hit: SceneItem): DiagramRow {
  return { kind: hit.kind, source: hit.source, index: hit.index, row: hit.row };
}
/** One string per item: its kind, row space, row, and port, or its group. */
export function itemKey(item: DiagramItem): string {
  return JSON.stringify(
    item.kind === 'group'
      ? ['group', item.id]
      : [
          item.kind,
          item.index.source,
          item.index.type,
          item.index.version,
          item.row,
          item.kind === 'port' ? item.port : '',
        ],
  );
}

/** What the renderer draws. */
export interface DiagramData {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly groups?: Readonly<Record<string, Group>>;
}
/** The drawn records of a config. */
export function diagramData({ source, vertices, edges, groups }: DiagramData): DiagramData {
  return { source, vertices, edges, groups };
}
