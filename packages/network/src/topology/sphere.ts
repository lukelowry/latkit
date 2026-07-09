/** Degrees-to-radians conversion factor for geographic inputs. */
const DEG2RAD = Math.PI / 180;

/**
 * Write a unit-sphere position for geographic lon/lat degrees.
 *
 * @remarks
 * The convention matches globe shaders: y is up and positive longitude maps to
 * negative z.
 */
export function writeSpherePosition(
  out: Float32Array,
  offset: number,
  lonDeg: number,
  latDeg: number,
): void {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const cosLat = Math.cos(lat);
  out[offset] = cosLat * Math.cos(lon);
  out[offset + 1] = Math.sin(lat);
  out[offset + 2] = -cosLat * Math.sin(lon);
}

/** Convert an interleaved lon/lat coordinate array to unit-sphere xyz triples. */
export function spherePositionsForCoords(coords: Float32Array): Float32Array {
  const out = new Float32Array(Math.floor(coords.length / 2) * 3);
  for (let i = 0, j = 0; i + 1 < coords.length; i += 2, j += 3) {
    writeSpherePosition(out, j, coords[i]!, coords[i + 1]!);
  }
  return out;
}
