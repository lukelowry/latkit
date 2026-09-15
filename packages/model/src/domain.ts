/**
 * A numeric interval, the one scan that produces it, and the one check every renderer runs on it.
 */

/** A numeric interval expressed as `[min, max]`: a channel's input domain or an output range. */
export type Domain = readonly [number, number];

/** The finite `[min, max]` of `values`, or null when nothing in them is finite. */
export function extent(values: ArrayLike<number>): Domain | null {
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? [min, max] : null;
}

/**
 * Assert that `value` is a finite, ordered `[min, max]` pair, naming it in the error.
 *
 * @throws TypeError when the value is not two numbers; RangeError when they are not finite or
 * are out of order.
 */
export function validateDomain(value: unknown, name = 'domain'): asserts value is Domain {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${name} must contain exactly two numbers`);
  }
  const [minimum, maximum] = value as readonly unknown[];
  if (typeof minimum !== 'number' || typeof maximum !== 'number') {
    throw new TypeError(`${name} must contain exactly two numbers`);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new RangeError(`${name} values must be finite`);
  }
  if (minimum > maximum) {
    throw new RangeError(`${name} minimum must not exceed its maximum`);
  }
}

/** Normalize in f64, including domains whose subtraction overflows. */
export function position(value: number, [min, max]: Domain): number {
  if (!Number.isFinite(value)) return NaN;
  if (min === max) return 0.5;
  const span = max - min;
  if (Number.isFinite(span)) return (value - min) / span;
  const scale = Math.max(Math.abs(min), Math.abs(max));
  return (value / scale - min / scale) / (max / scale - min / scale);
}

/** A finite increasing display interval, padded only when a signal is constant. */
export function normalizeDomain(range: Domain | null): Domain {
  if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) return [0, 1];
  if (range[0] !== range[1]) return range;
  const padding = Math.max(0.5, Math.abs(range[0]) * Number.EPSILON * 4);
  return [
    Math.max(-Number.MAX_VALUE, range[0] - padding),
    Math.min(Number.MAX_VALUE, range[1] + padding),
  ];
}
