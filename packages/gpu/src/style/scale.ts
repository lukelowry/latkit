import {
  failure,
  type Domain,
  type Data,
  type FieldInput,
  type ReadScope,
  type RowSelection,
  type SampleWindow,
} from '@latkit/model';
import type { Colormap } from '../colors/colormap.js';
import type { ColormapName } from '../colors/catalog.js';
import type { RGBA } from '../colors/color.js';
import type { TextFont } from '../text/text.js';

/** Output endpoints may descend. Model domains remain ordered. */
export type Range = readonly [start: number, end: number];
export type ScaleDomain = Domain | 'auto' | { readonly window: SampleWindow };
/** A field read through a mapping from its domain onto a range. */
export interface Scale {
  readonly field: FieldInput;
  /** The lane of a vector field; 0 by default. */
  readonly component?: number;
  readonly domain?: ScaleDomain;
  /** The channel's own range by default; a position reads its field as it is without one. */
  readonly range?: Range;
  readonly clamp?: boolean;
  /** The value of rows the field leaves empty; the view's default otherwise. */
  readonly missing?: number;
}
/** A field read through a colormap. */
export interface ColorScale {
  readonly field: FieldInput;
  readonly component?: number;
  readonly domain?: ScaleDomain;
  /** A colormap or a catalog name such as `viridis`. */
  readonly colormap?: Colormap | ColormapName;
  /** The color of rows the field leaves empty; the view's default otherwise. */
  readonly missing?: RGBA;
}
/** Text from a field beside each drawn item; views add how it is sized. */
export interface Labels {
  readonly field: FieldInput;
  readonly font?: TextFont;
  /** `textColor` by default. */
  readonly color?: RGBA;
  /** At most this many labels of the type draw at once. */
  readonly maxCount?: number;
}
/** A type's labels as a view reads them: a field name labels by that field with defaults. */
export function resolveLabels<L extends Labels>(
  labels: string | L | null | undefined,
): L | undefined {
  return typeof labels === 'string' ? ({ field: labels } as L) : (labels ?? undefined);
}
export interface ScaleRequest {
  readonly source: Data;
  readonly from: string;
  readonly field: FieldInput;
  readonly domain?: ScaleDomain;
  readonly range?: Range;
  readonly clamp?: boolean;
  readonly rows?: RowSelection;
  readonly window?: SampleWindow;
}
export interface ResolvedScale {
  readonly domain: Domain | null;
  readonly range: Range;
  readonly clamp: boolean;
}
export function resolveScale(
  scale: { readonly range?: Range; readonly clamp?: boolean },
  domain: Domain | null,
): ResolvedScale {
  if (domain && (domain.length !== 2 || !domain.every(Number.isFinite) || domain[1] < domain[0]))
    throw failure('invalid-input', 'Invalid scale domain');
  const range = scale.range ?? [0, 1];
  if (range.length !== 2 || !range.every(Number.isFinite))
    throw failure('invalid-input', 'Invalid output range');
  return { domain, range, clamp: scale.clamp ?? true };
}
/** Resolve a scale, reading its field's extent when the domain is automatic. */
export async function fieldScale(reader: ReadScope, request: ScaleRequest): Promise<ResolvedScale> {
  if (Array.isArray(request.domain)) return resolveScale(request, request.domain as Domain);
  const window =
    request.domain && request.domain !== 'auto'
      ? (request.domain as { readonly window: SampleWindow }).window
      : request.window;
  const { source, from, rows, field } = request;
  return resolveScale(request, await reader.extent({ source, from, rows, field, window }));
}
/** Null includes invalid/nonfinite input and empty domains. A constant maps to the midpoint. */
export function scaleValue(value: number | null, scale: ResolvedScale): number | null {
  if (value === null || !Number.isFinite(value) || !scale.domain) return null;
  const [lo, hi] = scale.domain;
  const span = hi - lo;
  let t =
    lo === hi
      ? 0.5
      : Number.isFinite(span)
        ? (value - lo) / span
        : (value / 2 - lo / 2) / (hi / 2 - lo / 2);
  if (scale.clamp) t = Math.max(0, Math.min(1, t));
  return (1 - t) * scale.range[0] + t * scale.range[1];
}
