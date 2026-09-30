import type { Domain, LinksQuery, Queryable, RowSelection, SampleWindow } from '@latkit/model';
import type { DataHit, FieldInput, TextFont } from '@latkit/gpu';
import type { Colormap, RGBA } from '@latkit/colormaps';

export type Position = FieldInput | { readonly x: FieldInput; readonly y: FieldInput };
export type ScaleDomain = Domain | 'auto' | { readonly window: SampleWindow };
export interface Scale {
  readonly field: FieldInput;
  readonly domain?: ScaleDomain;
  readonly range?: Domain;
}
export interface ColorScale {
  readonly field: FieldInput;
  readonly domain?: ScaleDomain;
  readonly colormap?: Colormap;
}
export interface Labels {
  readonly field: string;
  readonly font?: TextFont;
  readonly size?: number;
  readonly maxCount?: number;
  readonly color?: RGBA;
}
export interface VertexOptions {
  readonly rows?: RowSelection;
  readonly position?: Position;
  readonly color?: ColorScale | null;
  readonly size?: Scale | null;
  readonly height?: Scale | null;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
  readonly labels?: Labels | null;
}
export interface EdgeOptions {
  readonly rows?: RowSelection;
  readonly connectivity:
    | Omit<LinksQuery, 'from' | 'rows'>
    | {
        readonly kind: 'endpoints';
        readonly layout: 'pair' | 'star';
      };
  /** Intermediate bends, a native list of two-component floating-point vectors; pair layout only. */
  readonly bends?: FieldInput;
  readonly curve?: 'linear' | 'geodesic';
  /** Optional star junction; otherwise the centroid of the selected endpoints. */
  readonly junction?: Position;
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
export interface NetworkData {
  /** Borrowed. Renderer destruction never closes an acquisition. */
  readonly source: Queryable;
  /** Geographic positions are longitude/latitude in degrees. */
  readonly coordinates: 'cartesian' | 'geographic';
  /** Keys name native model types, not additional layer identities. */
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly paths?: Readonly<Record<string, PathOptions>>;
}
export interface NetworkItem extends DataHit {
  readonly kind: 'vertex' | 'edge' | 'path';
}
