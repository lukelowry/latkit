import { sameIndex, type Queryable, type RowSelection } from '@latkit/model';
import type { kit, RGBA } from '@latkit/gpu';

export interface Labels {
  readonly field: kit.FieldInput;
  readonly font?: kit.TextFont;
  readonly size?: number;
  readonly maxCount?: number;
  readonly color?: RGBA;
}
/** A field name stands for that field with defaults: `color: 'load'`, `labels: 'name'`. */
export interface VertexOptions {
  readonly rows?: RowSelection;
  /** Defaults to the type's spatial field. */
  readonly position?: kit.Position2D;
  readonly color?: string | kit.ColorScale | null;
  readonly size?: string | kit.Scale | null;
  readonly height?: string | kit.Scale | null;
  readonly visible?: kit.FieldInput | null;
  readonly shade?: kit.FieldInput | null;
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
  readonly bends?: kit.FieldInput;
  readonly curve?: 'linear' | 'geodesic';
  /** A net's star center; otherwise the centroid of its vertices. */
  readonly junction?: kit.Position2D;
  readonly color?: string | kit.ColorScale | null;
  readonly dash?: kit.FieldInput | null;
  readonly visible?: kit.FieldInput | null;
  readonly shade?: kit.FieldInput | null;
  readonly labels?: string | Labels | null;
}
export interface PathOptions {
  /** Defaults to the network's source. */
  readonly source?: Queryable;
  readonly rows?: RowSelection;
  readonly points: kit.FieldInput;
  readonly curve?: 'linear' | 'geodesic';
  readonly widthPx?: number;
  readonly baseColor?: RGBA;
  readonly color?: string | kit.ColorScale | null;
  readonly visible?: kit.FieldInput | null;
  readonly labels?: string | Labels | null;
  /** Decorative paths do not participate in picking by default. */
  readonly pickable?: boolean;
}
export interface NetworkItem extends kit.DataHit {
  readonly kind: 'vertex' | 'edge' | 'path';
}
export function sameItem(a: NetworkItem | null, b: NetworkItem | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.source === b.source &&
      a.kind === b.kind &&
      a.row === b.row &&
      sameIndex(a.index, b.index))
  );
}

/** Options with every shorthand expanded. */
type Full<T> = {
  readonly [K in keyof T]: K extends 'color' | 'size' | 'height' | 'labels'
    ? Exclude<T[K], string>
    : T[K];
};
export type VertexData = Full<VertexOptions>;
export type EdgeData = Full<EdgeOptions>;
export type PathData = Full<PathOptions>;
/** What the renderer draws. Positions are longitude/latitude in degrees for geographic data. */
export interface NetworkData {
  readonly source: Queryable;
  readonly vertices: Readonly<Record<string, VertexData>>;
  readonly edges?: Readonly<Record<string, EdgeData>>;
  readonly paths?: Readonly<Record<string, PathData>>;
}

const expanded = new WeakMap<object, object>();
/** Expand shorthands, keeping each unchanged entry's identity so caches keyed on it survive. */
function full<T extends object>(options: T): Full<T> {
  let found = expanded.get(options);
  if (!found) {
    const result: Record<string, unknown> = { ...(options as Record<string, unknown>) };
    for (const key of ['color', 'size', 'height', 'labels'])
      if (typeof result[key] === 'string') result[key] = { field: result[key] };
    found = Object.freeze(result);
    expanded.set(options, found);
  }
  return found as Full<T>;
}
function record<T extends object>(
  entries: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, Full<T>>> | undefined {
  return entries && Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, full(v)]));
}
export function networkData(config: {
  readonly source: Queryable;
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly paths?: Readonly<Record<string, PathOptions>>;
}): NetworkData {
  return {
    source: config.source,
    vertices: record(config.vertices)!,
    edges: record(config.edges),
    paths: record(config.paths),
  };
}
