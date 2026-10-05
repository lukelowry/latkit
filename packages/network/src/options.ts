import { failure } from '@latkit/model';
import { kit, type RGBA } from '@latkit/gpu';

/** How a network draws, beyond the shared view style; every option has a default. */
export interface NetworkStyle {
  /** Draw vertex markers. */
  readonly markers?: boolean;
  /** Draw edges and paths. */
  readonly lines?: boolean;
  /** Stems from the ground to raised vertices. */
  readonly poles?: boolean;
  /** Longitude and latitude lines. */
  readonly graticule?: boolean;
  /** The globe's axis. */
  readonly earthAxis?: boolean;
  readonly vertexRadiusPx?: number;
  readonly edgeWidthPx?: number;
  readonly heightScale?: number;
  readonly dashPeriodPx?: number;
  readonly vertexBaseColor?: RGBA;
  /** Null colors each edge by its ends. */
  readonly edgeBaseColor?: RGBA | null;
  readonly surfaceColor?: RGBA;
  readonly gridColor?: RGBA;
  /** Light the globe by the sun at `sunTime`, or now. */
  readonly daylight?: boolean;
  readonly sunTime?: number | null;
  readonly nightFloor?: number;
  readonly surfaceNightFloor?: number;
  readonly terminatorWidth?: number;
  /** Also halo the vertices a selected edge joins. */
  readonly selectedEnds?: boolean;
  /** Also halo the vertices a hovered edge joins. */
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
  graticule: false,
  earthAxis: true,
  vertexRadiusPx: 4,
  edgeWidthPx: 1.4,
  heightScale: 1,
  dashPeriodPx: 12,
  vertexBaseColor: [0.28, 0.75, 0.85, 1] as RGBA,
  edgeBaseColor: null,
  surfaceColor: [0.07, 0.1, 0.15, 1] as RGBA,
  gridColor: [0.3, 0.38, 0.46, 0.4] as RGBA,
  daylight: false,
  sunTime: null,
  nightFloor: 0.55,
  surfaceNightFloor: 0.15,
  terminatorWidth: 0.12,
  selectedEnds: true,
  hoverEnds: true,
  fitPitch: 45,
  fitBearing: 0,
  orbitRate: 1,
});
/** Shared style a network draws differently: halos translucent over what they surround. */
export const VIEW_DEFAULTS: Partial<kit.ResolvedViewStyle> = Object.freeze({
  hoverColor: [1, 0.72, 0.28, 0.65] as RGBA,
  selectedColor: [1, 0.4, 0.24, 0.9] as RGBA,
});
/** A path's line where its options leave it unset; a path has no ends to color it by. */
export const PATH_LINE = Object.freeze({ widthPx: 1, color: [0.52, 0.6, 0.68, 0.6] as RGBA });
/** Marker radii in CSS pixels that a `sizePx` field spans by default. */
export const SIZE_RANGE: readonly [number, number] = [2, 8];
/** Line widths in CSS pixels that a `widthPx` field spans by default. */
export const WIDTH_RANGE: readonly [number, number] = [1, 4];
/** The width, in CSS pixels, of a type's lines its `widthPx` leaves unset. */
export function lineWidthPx(entry: object, style: Style): number {
  return 'points' in entry ? PATH_LINE.widthPx : style.edgeWidthPx;
}
const UNIT = new Set(['nightFloor', 'surfaceNightFloor', 'terminatorWidth']);
/** The style a config describes: its own options over the defaults, on the shared view style. */
export function resolveStyle(config: NetworkStyle, view: kit.ResolvedViewStyle): Style {
  const style: Record<string, unknown> = { ...view, ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof NetworkStyle)[]) {
    const value = config[key];
    if (value === undefined) continue;
    if (key.endsWith('Color')) {
      if (!(key === 'edgeBaseColor' && value === null)) kit.validateRgba(value as RGBA);
    } else if (key === 'sunTime') {
      if (value !== null && !Number.isFinite(value))
        throw failure('invalid-input', 'Invalid sun time');
    } else if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw failure('invalid-input', 'Expected boolean: ' + key);
    } else if (!Number.isFinite(value) || (value as number) < 0)
      throw failure('invalid-input', 'Invalid option: ' + key);
    if (UNIT.has(key) && (value as number) > 1)
      throw failure('invalid-input', 'Option must be in [0,1]: ' + key);
    style[key] = value;
  }
  return Object.freeze(style) as Style;
}
