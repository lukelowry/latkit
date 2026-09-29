import type { Domain } from '@latkit/model';

/** Preserve narrow f64 spans; normalize only when expansion or subtraction would overflow. */
export function transformRange(range: Domain, factor: number, anchor: number, shift = 0): Domain {
  const span = range[1] - range[0];
  if (span === 0) return range;
  const resized = span / factor,
    delta = span * shift;
  let a: number, b: number;
  if (Number.isFinite(span) && Number.isFinite(resized) && Number.isFinite(delta)) {
    a = range[0] + (span - resized) * anchor + delta;
    b = range[1] + (resized - span) * (1 - anchor) + delta;
  } else {
    const scale = Math.max(Math.abs(range[0]), Math.abs(range[1]));
    const lo = range[0] / scale,
      hi = range[1] / scale;
    const normalized = hi - lo,
      center = lo + normalized * anchor;
    a = (center + (lo - center) / factor + shift * normalized) * scale;
    b = (center + (hi - center) / factor + shift * normalized) * scale;
  }
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    a >= b ||
    b - a < Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * 8
  )
    return range;
  return [a, b];
}
