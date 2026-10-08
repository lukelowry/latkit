import { failure, type Domain } from '@latkit/model';
import { kit, type RGBA, type Insets } from '@latkit/gpu';
import type { MonitorStyle, Limits, AxisOptions } from './options.js';

type Own = Required<Omit<MonitorStyle, 'xAxis' | 'yAxis'>> & {
  readonly xAxis: AxisOptions | null;
  readonly yAxis: AxisOptions | null;
};
/** The monitor's own style over the shared view style, every option resolved. */
export type Style = Own & kit.ResolvedViewStyle;
export const DEFAULTS: Own = Object.freeze({
  xAxis: {},
  yAxis: {},
  traceColor: [0.23, 0.72, 0.88, 0.7] as RGBA,
  traceWidthPx: 1.25,
  axisColor: [0.48, 0.58, 0.67, 0.8] as RGBA,
  gridColor: [0.4, 0.5, 0.6, 0.13] as RGBA,
  cursorColor: [1, 0.71, 0.25, 0.9] as RGBA,
  paddingPx: 12,
});
/**
 * Shared style a monitor draws differently: one sample, since history images would cost four times
 * the memory; no easing, since each eased step would redraw history; monospace axes; selected
 * traces in their own colors; and the rest faded.
 */
export const VIEW_DEFAULTS: Partial<kit.ResolvedViewStyle> = Object.freeze({
  msaa: 1,
  animationMs: 0,
  font: Object.freeze({ family: 'ui-monospace, monospace' }),
  textColor: [0.78, 0.84, 0.91, 1] as RGBA,
  selectedColor: 'none',
  unselectedAlpha: 0.25,
});
export const LIMITS: Required<Limits> = Object.freeze({
  rows: 100000,
  segmentsPerFrame: 1_000_000,
  historyBytes: 64 * 1024 ** 2,
});
export function fail(message: string): never {
  throw failure('invalid-input', message);
}
export function finite(
  value: number,
  name: string,
  minimum = -Infinity,
  maximum = Infinity,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail('Invalid ' + name);
  return value;
}
export function domain(value: Domain, name = 'domain'): Domain {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(Number.isFinite) ||
    value[1] < value[0]
  )
    fail('Invalid ' + name);
  return [value[0], value[1]];
}
/**
 * A domain grown so it fills `sizePx` pixels less `beforePx` and `afterPx` at its ends, as a fit
 * leaves `fitPaddingPx` clear; an empty domain grows by a hair.
 */
export function expanded(value: Domain, beforePx = 0, afterPx = 0, sizePx = 1): Domain {
  const d = value[1] - value[0],
    unit = d / Math.max(1, sizePx - beforePx - afterPx),
    tiny = Math.max(Math.abs(value[0]) * 1e-6, 1e-6);
  const lo = value[0] - (d > 0 ? unit * beforePx : tiny),
    hi = value[1] + (d > 0 ? unit * afterPx : tiny);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo))
    fail('Domain cannot be represented');
  return [lo, hi];
}
const axis = (value: string | AxisOptions | false | undefined, fallback: AxisOptions | null) =>
  value === undefined
    ? fallback
    : value === false
      ? null
      : typeof value === 'string'
        ? { label: value }
        : value;
/** The style a config describes: its own options over the defaults, on the shared view style. */
export function resolveStyle(config: MonitorStyle, view: kit.ResolvedViewStyle): Style {
  const own = Object.fromEntries(
    Object.keys(DEFAULTS).flatMap((key) => {
      const value = config[key as keyof MonitorStyle];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const out: Style = {
    ...view,
    ...DEFAULTS,
    ...own,
    xAxis: axis(config.xAxis, DEFAULTS.xAxis),
    yAxis: axis(config.yAxis, DEFAULTS.yAxis),
  };
  finite(out.traceWidthPx, 'traceWidthPx', 0.1, 64);
  for (const color of [out.traceColor, out.axisColor, out.gridColor, out.cursorColor])
    kit.validateRgba(color);
  for (const axis of [out.xAxis, out.yAxis]) checkAxis(axis);
  insets(out.paddingPx);
  return Object.freeze(out);
}
function checkAxis(axis: AxisOptions | null): void {
  if (axis === null) return;
  if (axis.minSpacingPx !== undefined) finite(axis.minSpacingPx, 'tick spacing', 8, 10000);
  if (
    axis.precision !== undefined &&
    (!Number.isInteger(axis.precision) || axis.precision < 0 || axis.precision > 15)
  )
    fail('Invalid axis precision');
  if (axis.format && !['auto', 'fixed', 'scientific', 'engineering'].includes(axis.format))
    fail('Invalid axis format');
  if (axis.label && axis.label.length > 256) fail('Axis label is too long');
  if (axis.ticks) {
    if (axis.ticks.length > 128) fail('Too many ticks');
    let last = -Infinity;
    for (const tick of axis.ticks) {
      finite(tick.value, 'tick');
      if (tick.value <= last || (tick.label?.length ?? 0) > 256) fail('Invalid ticks');
      last = tick.value;
    }
  }
}
export function insets(padding: Insets): readonly number[] {
  const p = typeof padding === 'number' ? [padding, padding, padding, padding] : padding;
  if (p.length !== 4 || !p.every((n) => Number.isFinite(n) && n >= 0)) fail('Invalid padding');
  return p;
}
