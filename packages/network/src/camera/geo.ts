/** Degrees-to-radians conversion factor. */
export const DEG2RAD = Math.PI / 180;

/** Radians-to-degrees conversion factor. */
export const RAD2DEG = 180 / Math.PI;

/** Wrap an angle in degrees to [0, 360). */
export function wrap(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Shortest signed angular turn in degrees from `a` to `b`. */
export function turn(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/**
 * Convert a unit-sphere xyz coordinate to [lon, lat] degrees.
 *
 * Uses y-up coordinates where (1, 0, 0) maps to (0, 0), matching
 * `geo_to_xyz` in shaders/projections/globe-overlay.wgsl.
 */
export function xyzToGeo(out: Float64Array, x: number, y: number, z: number): void {
  out[0] = Math.atan2(-z, x) * RAD2DEG;
  out[1] = Math.asin(Math.max(-1, Math.min(1, y))) * RAD2DEG;
}
