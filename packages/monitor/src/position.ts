import type { Domain } from '@latkit/model';

/**
 * Where `value` falls in `[min, max]`, as the `(x - min) * scale` every shader maps through,
 * normalized in f64, including domains whose subtraction overflows: 0.5 for a zero-width one.
 */
export function position(value: number, [min, max]: Domain): number {
  if (!Number.isFinite(value)) return NaN;
  if (min === max) return 0.5;
  const span = max - min;
  if (Number.isFinite(span)) return (value - min) / span;
  const scale = Math.max(Math.abs(min), Math.abs(max));
  return (value / scale - min / scale) / (max / scale - min / scale);
}
