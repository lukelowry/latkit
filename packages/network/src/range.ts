import type { Domain } from '@latkit/model';

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
