import { failure, type Data, type FieldInput } from '@latkit/model';
import { kit, type RGBA } from '@latkit/gpu';
import type { Geography } from './geography.js';
export type Style = Required<Geography.Style> & kit.ResolvedViewStyle;
/** A map looks straight down when it fits, and dashes finer than a network's edges. */
export const DEFAULTS: Required<Geography.Style> = Object.freeze({
  ...kit.lineStyle,
  ...kit.projectedStyle,
  ...kit.gridStyle,
  dashPeriodPx: 8,
  fitPitch: 0,
  surfaceColor: [0.07, 0.1, 0.15, 1] as RGBA,
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
});
/** Shared style the earth draws differently: hover and selection tint what they cover. */
export const VIEW_DEFAULTS: Partial<kit.ResolvedViewStyle> = Object.freeze({
  hoverColor: [1, 0.72, 0.28, 0.45] as RGBA,
  selectedColor: [1, 0.4, 0.24, 0.6] as RGBA,
});
/** Line widths in CSS pixels that a `widthPx` field spans by default. */
export const WIDTH_RANGE: readonly [number, number] = [0.5, 4];
/** Speeds in CSS pixels a second that a `flowPx` field spans by default, as in a network. */
export const FLOW_RANGE: readonly [number, number] = [0, 40];

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
  flowPx: FLOW_RANGE,
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
  'flowPx',
]);

/** The field a record draws from: its own, or the kind's default. */
export function shapeField(
  kind: 'area' | 'line',
  options: Geography.AreaOptions | Geography.LineOptions,
): FieldInput {
  return kind === 'area'
    ? ((options as Geography.AreaOptions).rings ?? 'rings')
    : ((options as Geography.LineOptions).points ?? 'points');
}
/** Whether a line record strokes rings, which close: an area type's own `rings`. */
export function strokesRings(
  options: Geography.LineOptions,
  area: Geography.AreaOptions | undefined,
): boolean {
  const field = options.points ?? 'points';
  return field === 'rings' || (area !== undefined && field === (area.rings ?? 'rings'));
}
/** A field input as a key: a field name, or its JSON. */
export function fieldKey(field: FieldInput): string {
  return typeof field === 'string' ? field : JSON.stringify(field);
}
/** Whether a value is model Data. */
export function isData(value: unknown): value is Data {
  const data = value as Data | undefined;
  return !!data && typeof data === 'object' && !!data.schema && !!data.tables;
}
/** Throw unless a record's options are ones it knows, with valid channels and labels. */
export function checkRecord(
  kind: 'area' | 'line',
  type: string,
  options: Geography.AreaOptions | Geography.LineOptions,
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
  const line = options as Geography.LineOptions;
  if (line.route != null && line.route !== 'straight' && line.route !== 'geodesic')
    throw failure('invalid-input', `Invalid route: ${type}`);
  kit.bindChannels(options, kind === 'area' ? AREA : LINE);
  kit.resolveLabels(options.labels);
}
const RULES: kit.StyleRules<Required<Geography.Style>> = {
  daylight: (value) => value === false || value === 'now' || Number.isFinite(value),
  nightFloor: 'unit',
  terminatorWidth: 'unit',
};
/** The style a config describes: its own options over the defaults, on the shared view style. */
export function resolveStyle(config: Geography.Style, view: kit.ResolvedViewStyle): Style {
  return kit.resolveStyle(config, DEFAULTS, RULES, view);
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
