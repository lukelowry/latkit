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

/** Output endpoints may descend. Model domains remain ordered. */
export type Range = readonly [start: number, end: number];
export type ScaleDomain = Domain | 'auto' | { readonly window: SampleWindow };
export interface Scale {
  readonly field: FieldInput;
  readonly domain?: ScaleDomain;
  readonly range?: Range;
  readonly clamp?: boolean;
}
export interface ColorScale {
  readonly field: FieldInput;
  readonly domain?: ScaleDomain;
  /** A colormap or a catalog name such as `viridis`. */
  readonly colormap?: Colormap | ColormapName;
}
export type Position2D = FieldInput | { readonly x: FieldInput; readonly y: FieldInput };
export interface ScaleRequest extends Scale {
  readonly source: Data;
  readonly from: string;
  readonly rows?: RowSelection;
  readonly window?: SampleWindow;
}
export interface ResolvedScale {
  readonly domain: Domain | null;
  readonly range: Range;
  readonly clamp: boolean;
}
export function resolveScale(
  scale: Pick<Scale, 'range' | 'clamp'>,
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
/** Two vec4 uniforms consumed by scaleShader. Rebase before narrowing to Float32. */
export function scaleParameters(
  scale: ResolvedScale,
  options: { readonly origin?: number } = {},
): Float32Array {
  if (!scale.domain) return new Float32Array(8);
  const [lo, hi] = scale.domain,
    span = hi - lo;
  const result = Float32Array.of(
    lo - (options.origin ?? 0),
    span === 0 ? 0 : 1 / span,
    scale.range[0],
    scale.range[1] - scale.range[0],
    span === 0 ? 2 : 1,
    scale.clamp ? 1 : 0,
    0,
    0,
  );
  if (!result.every(Number.isFinite))
    throw failure('precision', 'Scale exceeds Float32 relative precision');
  return result;
}
export function scaleShader(): string {
  return `
struct LatkitScale { mapping: vec4f, options: vec4f }
fn scaleFinite(v: f32) -> bool { return (bitcast<u32>(v) & 0x7f800000u) != 0x7f800000u; }
fn scaleMapped(value: f32, valid: bool, scale: LatkitScale, fallback: f32) -> f32 {
  if (!valid || !scaleFinite(value) || scale.options.x == 0.0) { return fallback; }
  var t = 0.5;
  if (scale.options.x == 1.0) { t = (value - scale.mapping.x) * scale.mapping.y; }
  if (scale.options.y != 0.0) { t = clamp(t, 0.0, 1.0); }
  return scale.mapping.z + t * scale.mapping.w;
}`;
}
