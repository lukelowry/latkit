import type { Domain } from '@latkit/model';
import type { Axis, Tick } from './options.js';

/** Bounded indexed ticks: no cumulative floating-point stepping or unbounded loops. */
export function ticks(domain: Domain, pixels: number, axis: Axis): readonly Tick[] {
  if (axis.ticks) return axis.ticks.filter(({ value }) => value >= domain[0] && value <= domain[1]);
  const [lo, hi] = domain;
  if (lo === hi) return [{ value: lo }];
  const count = Math.min(128, Math.max(2, Math.floor(pixels / (axis.minSpacingPx ?? 72))));
  // Scale before subtracting, so opposite extreme f64 values do not overflow.
  const magnitude = Math.max(Math.abs(lo), Math.abs(hi));
  const raw = ((hi / magnitude - lo / magnitude) / count) * magnitude;
  if (!(raw > 0) || !Number.isFinite(raw)) return [{ value: lo }, { value: hi }];
  const power = 10 ** Math.floor(Math.log10(raw));
  if (power === 0) return [{ value: lo }, { value: hi }];
  const fraction = raw / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  if (!Number.isFinite(step)) return [{ value: lo }, { value: hi }];
  const start = Math.ceil(lo / step);
  const result: Tick[] = [];
  for (let i = 0; i < 128; i++) {
    const value = (start + i) * step;
    if (value > hi || !Number.isFinite(value)) break;
    if (value < lo || (result.length && value <= result[result.length - 1]!.value)) continue;
    result.push({ value: Object.is(value, -0) ? 0 : value });
  }
  return result.length ? result : [{ value: lo }, { value: hi }];
}

/** Locale-independent output is portable between a window and its export worker. */
export function formatTick(value: number, domain: Domain, axis: Axis): string {
  if (value === 0) value = 0;
  const span = Math.abs(domain[1] / 2 - domain[0] / 2) * 2;
  const automatic = Math.max(
    0,
    Math.min(12, 2 - Math.floor(Math.log10(span || Math.abs(value) || 1))),
  );
  const precision = axis.precision ?? automatic;
  const magnitude = Math.abs(value);
  const mode = axis.format ?? 'auto';
  if (mode === 'engineering' && magnitude > 0) {
    const exponent = Math.floor(Math.log10(magnitude) / 3) * 3;
    // Divide in two steps when 10^exponent would underflow.
    const scaled =
      exponent < -308 ? value / 1e-300 / 10 ** (exponent + 300) : value / 10 ** exponent;
    return `${scaled.toFixed(axis.precision ?? 2)}e${exponent >= 0 ? '+' : ''}${exponent}`;
  }
  if (
    mode === 'scientific' ||
    (mode === 'auto' && magnitude > 0 && (magnitude >= 1e6 || magnitude < 1e-4))
  )
    return value.toExponential(
      axis.precision ??
        Math.max(
          2,
          Math.min(16, Math.ceil(Math.log10(magnitude) - Math.log10(span || magnitude)) + 2),
        ),
    );
  const text = value.toFixed(precision);
  return axis.precision === undefined && text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Auto labels use a shared offset for narrow ranges far from zero, retaining useful digits. */
export function tickOffset(domain: Domain, axis: Axis): number {
  if (axis.ticks || (axis.format !== undefined && axis.format !== 'auto')) return 0;
  const span = domain[1] - domain[0];
  return span > 0 && Math.max(Math.abs(domain[0]), Math.abs(domain[1])) / span >= 1e6
    ? domain[0]
    : 0;
}
