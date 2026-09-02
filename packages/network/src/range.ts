/** A numeric interval expressed as `[min, max]`: a channel's input domain or an output range. */
export type Domain = readonly [number, number];

/** Validate a public domain without retaining it. */
export function validateDomain(
  value: unknown,
  name = 'network channel domain',
): asserts value is Domain {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${name} must contain exactly two numbers`);
  }
  const tuple = value as readonly unknown[];
  const minimum = tuple[0];
  const maximum = tuple[1];
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

/** Resolve the active input domain, giving an explicit override precedence. */
export function effectiveRange(
  dataRange: Domain | null | undefined,
  clamp: Domain | null | undefined,
): Domain {
  return clamp ?? dataRange ?? [0, 1];
}

/**
 * Return linear normalization coefficients for mapping `[min, max]` to `[0, 1]`.
 *
 * @remarks
 * Consumers compute `(value - offset) * scale`, where `offset` is the first
 * tuple entry and `scale` is the second.
 */
export function linearNorm(min: number, max: number): [number, number] {
  return [min, 1 / Math.max(max - min, 1e-12)];
}

/** Return the finite `[min, max]` extent of values, or `null` when none exist. */
export function finiteExtent(values: Float32Array): Domain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return min <= max ? [min, max] : null;
}
