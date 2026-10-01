import { GpuError, validateRgba, type RGBA, type Insets } from '@latkit/gpu';
import type { Domain, SampleRange } from '@latkit/model';
import type { Options, Limits, AxisOptions } from './options.js';
export type Settings = Required<Omit<Options, 'coordinateAxis' | 'valueAxis' | 'focusColor'>> & {
  coordinateAxis: AxisOptions | null;
  valueAxis: AxisOptions | null;
  focusColor: RGBA | null;
};
export const defaults: Settings = {
  detail: 'auto',
  follow: null,
  coordinateAxis: {},
  valueAxis: {},
  valueDomain: 'auto',
  autoDomain: 'grow',
  domainPadding: 0.1,
  font: { family: 'ui-monospace, monospace' },
  fontSizePx: 12,
  textColor: [0.78, 0.84, 0.91, 1],
  axisColor: [0.48, 0.58, 0.67, 0.8],
  gridColor: [0.4, 0.5, 0.6, 0.13],
  backgroundColor: [0.027, 0.043, 0.065, 1],
  cursorColor: [1, 0.71, 0.25, 0.9],
  focusColor: null,
  unselectedAlpha: 0.25,
  paddingPx: 12,
  pickRadiusPx: 8,
  msaa: 1,
  hover: 'auto',
  hoverBudgetMs: 2,
};
export const limitDefaults: Required<Limits> = {
  rows: 100000,
  prepareMs: 3,
  segmentsPerFrame: 250000,
  historyBytes: 64 * 1024 ** 2,
  pickingBytes: 2 * 1024 ** 2,
};
export function fail(message: string): never {
  throw new GpuError('invalid-input', message);
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
  if (value.length !== 2 || !value.every(Number.isFinite) || value[1] < value[0])
    fail('Invalid ' + name);
  return [...value];
}
export function windowRange(value: SampleRange): SampleRange {
  if (value.kind !== 'range') fail('Monitor window must be a coordinate range');
  domain(value.between, 'coordinate window');
  for (const n of [value.context?.before, value.context?.after])
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0)) fail('Invalid window context');
  return { ...value, between: [...value.between] };
}
export function expanded(value: Domain, padding = 0): Domain {
  const d = value[1] - value[0],
    extra = d > 0 ? d * padding : Math.max(Math.abs(value[0]) * 1e-6, 1e-6);
  const lo = value[0] - extra,
    hi = value[1] + extra;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo))
    fail('Domain cannot be represented');
  return [lo, hi];
}
export function settings(current: Settings, patch: Options): Settings {
  const out = { ...current, ...patch };
  for (const key of Object.keys(patch))
    if (!(key in defaults)) fail('Unknown monitor option: ' + key);
  for (const [name, n, min, max] of [
    ['fontSizePx', out.fontSizePx, 1, 256],
    ['pickRadiusPx', out.pickRadiusPx, 0, 1024],
    ['hoverBudgetMs', out.hoverBudgetMs, 0, 1000],
    ['unselectedAlpha', out.unselectedAlpha, 0, 1],
    ['domainPadding', out.domainPadding, 0, 10],
  ] as const)
    finite(n, name, min, max);
  if (
    !['auto', 'full'].includes(out.detail) ||
    !['grow', 'fit'].includes(out.autoDomain) ||
    !['auto', 'on', 'off'].includes(out.hover) ||
    ![1, 4].includes(out.msaa)
  )
    fail('Invalid monitor option');
  if (out.valueDomain !== 'auto') domain(out.valueDomain);
  if (out.follow) finite(out.follow.span, 'follow span', Number.MIN_VALUE);
  for (const c of [
    out.textColor,
    out.axisColor,
    out.gridColor,
    out.backgroundColor,
    out.cursorColor,
    out.focusColor,
  ])
    if (c) validateRgba(c);
  for (const axis of [out.coordinateAxis, out.valueAxis]) checkAxis(axis);
  insets(out.paddingPx);
  return out;
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
export function limits(patch: Limits = {}): Required<Limits> {
  const result = { ...limitDefaults, ...patch };
  for (const [name, n] of Object.entries(result)) {
    finite(n, name, 1);
    if (name !== 'prepareMs' && !Number.isSafeInteger(n)) fail('Invalid ' + name);
  }
  return result;
}
export function insets(padding: Insets): readonly number[] {
  const p = typeof padding === 'number' ? [padding, padding, padding, padding] : padding;
  if (p.length !== 4 || !p.every((n) => Number.isFinite(n) && n >= 0)) fail('Invalid padding');
  return p;
}
