import { failure } from '@latkit/model';
import { kit, type RGBA } from '@latkit/gpu';

/**
 * How a network draws, beyond the shared view style; every option has a default. A kind's
 * defaults are named after the channels they stand in for: `vertexColor` is the vertices' `color`.
 */
export interface NetworkStyle {
  /** Draw vertex markers. */
  readonly markers?: boolean;
  /** Draw edges. */
  readonly lines?: boolean;
  /** Stems from the ground to raised vertices. */
  readonly poles?: boolean;
  readonly vertexColor?: RGBA;
  readonly vertexRadiusPx?: number;
  /** `ends` colors each edge by the vertices it joins. */
  readonly edgeColor?: RGBA | 'ends';
  readonly edgeWidthPx?: number;
  /** How high a `z` of 1 draws: 15% of the data's extent on a plane, and 8% of the globe's radius, times this. */
  readonly zScale?: number;
  readonly dashPeriodPx?: number;
  /** Edges joining the same two vertices draw this many CSS pixels apart; 0 draws them over each other. */
  readonly edgeSpacingPx?: number;
  /** The comets `flowPx` moves along a line, `flowSpacingPx` apart; 0 draws none. */
  readonly flowColor?: RGBA;
  readonly flowSpacingPx?: number;
  /** Soft shadows below markers, lifting them off the lines. */
  readonly shadows?: boolean;
  /** How much hover grows a vertex's marker, eased; 1 keeps its size. */
  readonly hoverScale?: number;
  /** How far the ground's halo reaches around label text, in CSS pixels. */
  readonly labelHaloPx?: number;
  /** Also draw the vertices a selected edge joins over the rest. */
  readonly selectedEnds?: boolean;
  /** Also draw the vertices a hovered edge joins over the rest. */
  readonly hoverEnds?: boolean;
  readonly fitPitch?: number;
  readonly fitBearing?: number;
  readonly orbitRate?: number;
}
export type Style = Required<NetworkStyle> & kit.ResolvedViewStyle;
export const DEFAULTS: Required<NetworkStyle> = Object.freeze({
  markers: true,
  lines: true,
  poles: false,
  vertexColor: [0.28, 0.75, 0.85, 1] as RGBA,
  vertexRadiusPx: 4,
  edgeColor: 'ends',
  edgeWidthPx: 1.4,
  zScale: 1,
  dashPeriodPx: 12,
  edgeSpacingPx: 0,
  flowColor: [0.95, 0.97, 1, 0.9] as RGBA,
  flowSpacingPx: 32,
  shadows: false,
  hoverScale: 1.25,
  labelHaloPx: 2,
  selectedEnds: true,
  hoverEnds: true,
  fitPitch: 45,
  fitBearing: 0,
  orbitRate: 1,
});
/** Shared style a network draws differently: glows translucent over what they surround. */
export const VIEW_DEFAULTS: Partial<kit.ResolvedViewStyle> = Object.freeze({
  hoverColor: [1, 0.72, 0.28, 0.65] as RGBA,
  selectedColor: [1, 0.4, 0.24, 0.9] as RGBA,
});
/** Marker radii in CSS pixels that a `radiusPx` field spans by default. */
export const RADIUS_RANGE: readonly [number, number] = [2, 8];
/** Line widths in CSS pixels that a `widthPx` field spans by default. */
export const WIDTH_RANGE: readonly [number, number] = [1, 4];
/** Speeds in CSS pixels a second that a `flowPx` field spans by default, as in a diagram. */
export const FLOW_RANGE: readonly [number, number] = [0, 40];
/** The color of edges their `color` leaves unset; null colors an edge by its ends. */
export function lineColor(style: Style): RGBA | null {
  return style.edgeColor === 'ends' ? null : style.edgeColor;
}
/** The style a config describes: its own options over the defaults, on the shared view style. */
export function resolveStyle(config: NetworkStyle, view: kit.ResolvedViewStyle): Style {
  const style: Record<string, unknown> = { ...view, ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof NetworkStyle)[]) {
    const value = config[key];
    if (value === undefined) continue;
    if (key.endsWith('Color')) {
      if (!(key === 'edgeColor' && value === 'ends')) kit.validateRgba(value as RGBA);
    } else if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw failure('invalid-input', 'Expected boolean: ' + key);
    } else if (!Number.isFinite(value) || (value as number) < 0)
      throw failure('invalid-input', 'Invalid option: ' + key);
    style[key] = value;
  }
  return Object.freeze(style) as Style;
}
