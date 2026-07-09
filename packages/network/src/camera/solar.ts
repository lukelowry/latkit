import { DEG2RAD } from './geo.js';

/** Earth's axial tilt in degrees for the low-precision solar model. */
const OBLIQUITY = 23.44;
/** Full turn in radians. */
const TAU = 2 * Math.PI;
/** Number of milliseconds in one UTC day. */
const MS_PER_DAY = 86_400_000;

/**
 * Return a unit vector pointing toward the sun in globe coordinates.
 *
 * The result uses the same Y-up convention as `geo.ts`: lon = atan2(-z, x).
 * Accuracy is intentionally low precision, roughly within one degree, which
 * is sufficient for globe lighting.
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
