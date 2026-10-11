import {
  failure,
  type Data,
  type FieldInput,
  type Domain,
  type Reader,
  type Index,
  type Query,
} from '@latkit/model';
import type { Colormap } from '../colors/colormap.js';
import { validateRgba, type RGBA } from '../colors/color.js';
import type { TextRasterizer } from '../text/text.js';

/** A field read through a mapping from its domain onto a range. */
export interface Scale {
  readonly field: FieldInput;
  /** The lane of a vector field; 0 by default. */
  readonly component?: number;
  readonly domain?: Scale.Domain;
  /** The channel's own range by default; a position reads its field as it is without one. */
  readonly range?: Scale.Range;
  readonly clamp?: boolean;
  /** The value of rows the field leaves empty; the view's default otherwise. */
  readonly missing?: number;
}
export declare namespace Scale {
  /** A field read through a colormap. */
  interface Color {
    readonly field: FieldInput;
    readonly component?: number;
    readonly domain?: Domain;
    /** A colormap or a catalog name such as `viridis`. */
    readonly colormap?: Colormap | Colormap.Name;
    /** The color of rows the field leaves empty; the view's default otherwise. */
    readonly missing?: RGBA;
  }
  /** Output endpoints may descend. Model domains remain ordered. */
  type Range = readonly [start: number, end: number];
  /** What a field's values span: bounds, all of them, or those in a window of samples. */
  type Domain =
    readonly [minimum: number, maximum: number] | 'auto' | { readonly window: Query.Window };
}
/** Text from a field beside each drawn item. */
export interface Labels {
  readonly field: FieldInput;
  readonly font?: TextRasterizer.Font;
  /** The shared `fontSizePx` by default. */
  readonly fontSizePx?: number;
  /** `textColor` by default. */
  readonly color?: RGBA;
  /** At most this many labels of the type draw at once. */
  readonly maxCount?: number;
  /**
   * Leave out a label whose text repeats one placed within this many CSS pixels, as when buses of
   * one substation, or the pieces of one road, share a name; 0 labels every row. Unset, a network
   * labels every row, and a geography names each text once in view.
   */
  readonly repeatSpacingPx?: number;
}
/**
 * A type's labels as a view reads them, checked: a field name labels by that field with defaults.
 * Views check the options they add to `Labels` themselves.
 */
export function resolveLabels<L extends Labels>(
  labels: string | L | null | undefined,
): L | undefined {
  if (labels === null || labels === undefined) return undefined;
  if (typeof labels === 'string') return { field: labels } as L;
  if (typeof labels !== 'object' || labels.field === undefined)
    throw failure('invalid-input', 'Invalid labels');
  if (labels.color !== undefined) validateRgba(labels.color);
  if (
    labels.maxCount !== undefined &&
    (!Number.isSafeInteger(labels.maxCount) || labels.maxCount < 0)
  )
    throw failure('invalid-input', 'Invalid label count');
  const { fontSizePx, repeatSpacingPx } = labels;
  if (fontSizePx !== undefined && !(Number.isFinite(fontSizePx) && fontSizePx > 0))
    throw failure('invalid-input', 'Invalid label fontSizePx');
  if (repeatSpacingPx !== undefined && !(Number.isFinite(repeatSpacingPx) && repeatSpacingPx >= 0))
    throw failure('invalid-input', 'Invalid label repeatSpacingPx');
  return labels;
}
export interface ScaleRequest {
  readonly source: Data;
  readonly from: string;
  readonly field: FieldInput;
  readonly domain?: Scale.Domain;
  readonly range?: Scale.Range;
  readonly clamp?: boolean;
  readonly rows?: Index.Selection;
  readonly window?: Query.Window;
}
export interface ResolvedScale {
  readonly domain: Domain | null;
  readonly range: Scale.Range;
  readonly clamp: boolean;
}
export function resolveScale(
  scale: { readonly range?: Scale.Range; readonly clamp?: boolean },
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
export async function fieldScale(
  reader: Reader.Scope,
  request: ScaleRequest,
): Promise<ResolvedScale> {
  if (Array.isArray(request.domain)) return resolveScale(request, request.domain as Domain);
  const window =
    request.domain && request.domain !== 'auto'
      ? (request.domain as { readonly window: Query.Window }).window
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
