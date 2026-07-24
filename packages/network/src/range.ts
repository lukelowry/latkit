/** Numeric channel domain expressed as `[min, max]`. */
export type ChannelRange = readonly [number, number];

/** Validate a public channel domain or output range without retaining it. */
export function validateChannelRange(
  value: unknown,
  name = 'network channel range',
): asserts value is ChannelRange {
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

/** Resolve the active input range, giving explicit clamps precedence. */
export function effectiveRange(
  dataRange: ChannelRange | null | undefined,
  clamp: ChannelRange | null | undefined,
): ChannelRange {
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
export function finiteExtent(values: Float32Array): ChannelRange | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return min <= max ? [min, max] : null;
}
