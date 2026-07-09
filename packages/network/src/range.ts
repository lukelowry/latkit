/** Numeric channel domain expressed as `[min, max]`. */
export type ChannelRange = readonly [number, number];

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
