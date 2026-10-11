import { kit, type RGBA } from '@latkit/gpu';
import type { Network } from './network.js';
export type Style = Required<Network.Style> & kit.ResolvedViewStyle;
export const DEFAULTS: Required<Network.Style> = Object.freeze({
  ...kit.lineStyle,
  ...kit.projectedStyle,
  ...kit.gridStyle,
  markers: true,
  lines: true,
  poles: false,
  vertexColor: [0.28, 0.75, 0.85, 1] as RGBA,
  vertexRadiusPx: 4,
  vertexMinRadiusPx: 1,
  edgeColor: 'ends',
  edgeWidthPx: 1.4,
  zScale: 1,
  edgeSpacingPx: 0,
  shadows: false,
  hoverScale: 1.25,
  selectedEnds: true,
  hoverEnds: true,
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
export function resolveStyle(config: Network.Style, view: kit.ResolvedViewStyle): Style {
  return kit.resolveStyle(config, DEFAULTS, { edgeColor: ['ends'] }, view);
}
