import { DEG2RAD } from './camera/geo.js';
import type { LightRegion } from './webgpu/uniforms.js';

/** Wall-clock cadence for sun-direction refreshes, in milliseconds. */
export const SUN_REFRESH_MS = 30_000;

/** Earth's axial tilt in degrees for the low-precision solar model. */
const OBLIQUITY = 23.44;
/** Full turn in radians. */
const TAU = 2 * Math.PI;
/** Number of milliseconds in one UTC day. */
const MS_PER_DAY = 86_400_000;

/**
 * Return a unit vector pointing toward the sun in globe coordinates.
 *
 * The result uses the same Y-up convention as `camera/geo.ts`:
 * lon = atan2(-z, x). Accuracy is intentionally low precision, roughly within
 * one degree, which is sufficient for daylight lighting.
 */
export function sunDirection(date: Date): [number, number, number] {
  // Day-of-year (fractional).
  const jan1 = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = (date.getTime() - jan1) / MS_PER_DAY;

  // Solar declination: +/-23.44 degrees over the year.
  const decl = -OBLIQUITY * Math.cos((TAU * (dayOfYear + 10)) / 365.25) * DEG2RAD;

  // Sub-solar longitude from UTC time-of-day.
  const utcFrac =
    (date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600) / 24;
  const sunLon = (0.5 - utcFrac) * TAU;

  const cosDecl = Math.cos(decl);
  return [cosDecl * Math.cos(sunLon), Math.sin(decl), -cosDecl * Math.sin(sunLon)];
}

/** Owner of time-varying sun state: refreshes `light_dir` on a fixed cadence. */
export interface Daylight {
  /** Write the current sun direction if the refresh cadence has elapsed. */
  refresh(now?: number): void;
}

/**
 * Create the daylight owner over the shared light uniform region.
 *
 * `refresh()` is called once per frame (a stamp compare) and from the
 * controller's idle wake timer, so `light_dir` is fresh regardless of the
 * active projection. Every projection family shades with it; the controller
 * arms FLAG_DAYLIGHT only for geographic topologies (`isGeographicTopology`).
 */
export function createDaylight(light: LightRegion): Daylight {
  let stamp = -Infinity;
  return {
    refresh(now = Date.now()) {
      if (now - stamp < SUN_REFRESH_MS) return;
      stamp = now;
      const [x, y, z] = sunDirection(new Date(now));
      light.setDir(x, y, z);
    },
  };
}
