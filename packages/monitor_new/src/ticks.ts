import type { Domain } from '@latkit/model';
import type { AxisOptions, Tick } from './options.js';
export interface Ticks {
  readonly items: readonly Tick[];
  readonly offset: number;
}
export function ticks(range: Domain, pixels: number, axis: AxisOptions): Ticks {
  if (axis.ticks)
    return {
      items: axis.ticks.filter((t) => t.value >= range[0] && t.value <= range[1]),
      offset: 0,
    };
  const span = range[1] - range[0],
    count = Math.max(1, Math.min(64, Math.floor(pixels / (axis.minSpacingPx ?? 80))));
  if (!(span > 0) || !Number.isFinite(span)) return { items: [], offset: 0 };
  const power = 10 ** Math.floor(Math.log10(span / count)),
    normal = span / count / power;
  const step = ([1, 2, 2.5, 5, 10].find((n) => n >= normal) ?? 10) * power;
  const offset =
    (!axis.format || axis.format === 'auto') && Math.abs(range[0]) > span * 1e5 ? range[0] : 0;
  const items: Tick[] = [];
  const first = Math.ceil((range[0] - offset) / step) * step;
  for (let i = 0; i < 128; i++) {
    const local = first + i * step,
      value = offset + local;
    if (value > range[1]) break;
    if (value >= range[0] && (items.length === 0 || value > items[items.length - 1].value))
      items.push({ value, label: format(local, step, axis) });
  }
  return { items, offset };
}
function format(value: number, step: number, axis: AxisOptions): string {
  if (Object.is(value, -0) || Math.abs(value) < step * 1e-9) value = 0;
  const precision =
    axis.precision ??
    Math.min(
      12,
      Math.max(
        0,
        -Math.floor(Math.log10(step)) +
          (Math.abs(step / 10 ** Math.floor(Math.log10(step)) - 2.5) < 1e-9 ? 1 : 0),
      ),
    );
  if (axis.format === 'scientific') return value.toExponential(axis.precision ?? 3);
  if (axis.format === 'engineering' && value) {
    const exponent = Math.floor(Math.log10(Math.abs(value)) / 3) * 3;
    return (value / 10 ** exponent).toFixed(axis.precision ?? 3) + 'e' + exponent;
  }
  if (axis.format === 'fixed') return value.toFixed(precision);
  if (value !== 0 && (Math.abs(value) >= 1e7 || Math.abs(value) < 1e-5))
    return value.toExponential(axis.precision ?? 2);
  return value.toFixed(precision);
}
