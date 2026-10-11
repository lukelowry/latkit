import { failure, type Data, type FieldInput } from '@latkit/model';
import { kit, type Channel, type ColorChannel, type Labels, type RGBA } from '@latkit/gpu';
import type { Tiles } from './tiles.js';

/** How the earth draws, beyond the shared view style; every option has a default. */
export interface GeographyStyle {
  /** The ground beneath everything. */
  readonly surfaceColor?: RGBA;
  /** Lines of longitude and latitude, spaced for the zoom. */
  readonly graticule?: boolean;
  readonly graticuleColor?: RGBA;
  /** Light by the sun at a time in milliseconds, at the current time, or not at all; a hosting network is lit too. */
  readonly daylight?: number | 'now' | false;
  /** How bright night stays, from 0 to 1, for the ground and everything on it. */
  readonly nightFloor?: number;
  /** How wide the band from day to night is. */
  readonly terminatorWidth?: number;
  /** A glow around the globe's rim. */
  readonly atmosphere?: boolean;
  readonly atmosphereColor?: RGBA;
  /** The axis the globe turns on, through its poles. */
  readonly earthAxis?: boolean;
  readonly earthAxisColor?: RGBA;
  /** The color of areas their `color` leaves unset. */
  readonly areaColor?: RGBA;
  /** The color of lines their `color` leaves unset. */
  readonly lineColor?: RGBA;
  /** The width of lines their `widthPx` leaves unset. */
  readonly lineWidthPx?: number;
  /** How far a dash and the gap after it run, in CSS pixels. */
  readonly dashPeriodPx?: number;
}
export type Style = Required<GeographyStyle> & kit.ResolvedViewStyle;
export const DEFAULTS: Required<GeographyStyle> = Object.freeze({
  surfaceColor: [0.07, 0.1, 0.15, 1] as RGBA,
  graticule: false,
  graticuleColor: [0.3, 0.38, 0.46, 0.4] as RGBA,
  daylight: false,
  nightFloor: 0.3,
  terminatorWidth: 0.12,
  atmosphere: true,
  atmosphereColor: [0.36, 0.62, 0.95, 0.55] as RGBA,
  earthAxis: false,
  earthAxisColor: [0.6, 0.75, 0.86, 0.65] as RGBA,
  areaColor: [0.16, 0.21, 0.27, 1] as RGBA,
  lineColor: [0.52, 0.6, 0.68, 0.6] as RGBA,
  lineWidthPx: 1,
  dashPeriodPx: 8,
});
/** Shared style the earth draws differently: hover and selection tint what they cover. */
export const VIEW_DEFAULTS: Partial<kit.ResolvedViewStyle> = Object.freeze({
  hoverColor: [1, 0.72, 0.28, 0.45] as RGBA,
  selectedColor: [1, 0.4, 0.24, 0.6] as RGBA,
});
/** Line widths in CSS pixels that a `widthPx` field spans by default. */
export const WIDTH_RANGE: readonly [number, number] = [0.5, 4];

/** What areas and lines share: where their shapes and values come from, and their channels. */
export interface ShapeOptions {
  /** Where the shapes come from: Data, or tiles; the config's `source` by default. */
  readonly source?: Data | Tiles;
  /**
   * Rows of the same type, matched to the shapes' rows by id, that the channels read: a run's
   * results coloring a static map. The shapes' own rows by default.
   */
  readonly values?: Data;
  /** `areaColor` or `lineColor` by default. */
  readonly color?: ColorChannel;
  readonly visible?: Channel<boolean>;
  /** The value the view's `shade` reads. */
  readonly shade?: Channel;
  /** Text at each row's anchor: an area's widest point, a line's middle. */
  readonly labels?: string | Labels | null;
}
export interface AreaOptions extends ShapeOptions {
  /** Rings of longitude and latitude; a hole winds opposite its outline. `rings` by default. */
  readonly rings?: FieldInput;
}
export interface LineOptions extends ShapeOptions {
  /** Points, or lists of them; an area type's `rings` draw its outline. `points` by default. */
  readonly points?: FieldInput;
  /**
   * How a line between geographic points runs over the earth: `straight` in longitude and
   * latitude, or `geodesic` along the great circle. `straight` by default, as maps record their
   * features: a border along a parallel stays on it.
   */
  readonly route?: 'straight' | 'geodesic';
  /** `lineWidthPx` by default. */
  readonly widthPx?: Channel;
  readonly dash?: Channel<boolean>;
}
/** What areas read per row, and how. */
export const AREA = {
  color: 'color',
  visible: 'raw',
  shade: 'raw',
} as const satisfies Readonly<Record<string, kit.ChannelKind>>;
/** What lines read per row, and how. */
export const LINE = {
  color: 'color',
  visible: 'raw',
  shade: 'raw',
  widthPx: WIDTH_RANGE,
  dash: 'raw',
} as const satisfies Readonly<Record<string, kit.ChannelKind>>;
export type ChannelName = keyof typeof LINE;

const AREA_KEYS = new Set(['source', 'values', 'color', 'visible', 'shade', 'labels', 'rings']);
const LINE_KEYS = new Set([
  'source',
  'values',
  'color',
  'visible',
  'shade',
  'labels',
  'points',
  'widthPx',
  'route',
  'dash',
]);

/** Whether a value is model Data. */
export function isData(value: unknown): value is Data {
  const data = value as Data | undefined;
  return !!data && typeof data === 'object' && !!data.schema && !!data.tables;
}
/** Throw unless a record's options are ones it knows, with valid channels and labels. */
export function checkRecord(
  kind: 'area' | 'line',
  type: string,
  options: AreaOptions | LineOptions,
  isTiles: (value: unknown) => boolean,
): void {
  if (!options || typeof options !== 'object')
    throw failure('invalid-input', `Invalid ${kind} options: ${type}`);
  const known = kind === 'area' ? AREA_KEYS : LINE_KEYS;
  for (const key of Object.keys(options))
    if (!known.has(key)) throw failure('invalid-input', `Unknown ${kind} option: ${key}`);
  if (options.source != null && !isData(options.source) && !isTiles(options.source))
    throw failure('invalid-input', `A ${kind} source is Data or tiles: ${type}`);
  if (options.values != null && !isData(options.values))
    throw failure('invalid-input', `Values are Data: ${type}`);
  const line = options as LineOptions;
  if (line.route != null && line.route !== 'straight' && line.route !== 'geodesic')
    throw failure('invalid-input', `Invalid route: ${type}`);
  kit.bindChannels(options, kind === 'area' ? AREA : LINE);
  kit.resolveLabels(options.labels);
}
const UNIT = new Set(['nightFloor', 'terminatorWidth']);
/** The style a config describes: its own options over the defaults, on the shared view style. */
export function resolveStyle(config: GeographyStyle, view: kit.ResolvedViewStyle): Style {
  const style: Record<string, unknown> = { ...view, ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof GeographyStyle)[]) {
    const value = config[key];
    if (value === undefined) continue;
    if (key.endsWith('Color')) kit.validateRgba(value as RGBA);
    else if (key === 'daylight') {
      if (value !== false && value !== 'now' && !Number.isFinite(value))
        throw failure('invalid-input', 'Daylight is a time, now, or false');
    } else if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw failure('invalid-input', 'Expected boolean: ' + key);
    } else if (
      !Number.isFinite(value) ||
      (value as number) < 0 ||
      (UNIT.has(key) && (value as number) > 1)
    )
      throw failure('invalid-input', 'Invalid option: ' + key);
    style[key] = value;
  }
  return Object.freeze(style) as Style;
}
/** The sun a style lights the scene with, or none: at its time, or at the moment it draws. */
export function lightOf(style: Style): kit.Light | null {
  if (style.daylight === false) return null;
  return {
    sun: kit.Projector.sun(style.daylight === 'now' ? Date.now() : style.daylight),
    nightFloor: style.nightFloor,
    terminatorWidth: style.terminatorWidth,
  };
}
