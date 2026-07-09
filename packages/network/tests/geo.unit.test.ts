import { describe, it, expect } from 'vitest';
import { DEG2RAD, xyzToGeo } from '../src/camera/geo.js';

const geo = new Float64Array(2);

describe('xyzToGeo', () => {
  it('maps the cardinal axes to their lon/lat', () => {
    xyzToGeo(geo, 1, 0, 0);
    expect(geo[0]).toBeCloseTo(0, 6);
    expect(geo[1]).toBeCloseTo(0, 6);

    xyzToGeo(geo, 0, 0, -1);
    expect(geo[0]).toBeCloseTo(90, 6);
    expect(geo[1]).toBeCloseTo(0, 6);

    xyzToGeo(geo, 0, 1, 0);
    expect(geo[1]).toBeCloseTo(90, 6);

    xyzToGeo(geo, 0, -1, 0);
    expect(geo[1]).toBeCloseTo(-90, 6);
  });

  it('inverts the sphere mapping used by shaders/projections/globe-overlay.wgsl geo_to_xyz', () => {
    // xyz built with the shader's convention: y = up, +lon toward -z.
    for (const [lon, lat] of [
      [0, 0],
      [45, 30],
      [-120, -60],
      [90, 0],
      [150, -45],
    ]) {
      const la = lat * DEG2RAD;
      const lo = lon * DEG2RAD;
      const c = Math.cos(la);
      xyzToGeo(geo, c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo));
      expect(geo[0]).toBeCloseTo(lon, 6);
      expect(geo[1]).toBeCloseTo(lat, 6);
    }
  });

  it('clamps y outside the unit range instead of producing NaN', () => {
    xyzToGeo(geo, 0, 1.0000001, 0);
    expect(geo[1]).toBeCloseTo(90, 6);
  });
});
