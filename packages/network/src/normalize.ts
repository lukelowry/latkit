import type { Domain } from '@latkit/model';

/** The input domain a channel uses: an explicit override, else the scanned data domain, else unit. */
export function effectiveDomain(
  data: Domain | null | undefined,
  override: Domain | null | undefined,
): Domain {
  return override ?? data ?? [0, 1];
}

/**
 * The `[min, scale]` pair that maps `[min, max]` onto `[0, 1]` as `(value - min) * scale`; the
 * shape every channel's normalization words take.
 */
export function linearNorm(min: number, max: number): [number, number] {
  return [min, 1 / Math.max(max - min, 1e-12)];
}
