import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaylight, SUN_REFRESH_MS, sunDirection } from '../src/daylight.js';
import { createUniforms } from '../src/webgpu/uniforms.js';

const norm = ([x, y, z]: readonly [number, number, number]) => Math.hypot(x, y, z);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sunDirection', () => {
  it('returns a unit vector', () => {
    const d = sunDirection(new Date('2026-06-15T08:30:00Z'));
    expect(norm(d)).toBeCloseTo(1, 6);
  });

  it('points north of the equator at the June solstice', () => {
    const [x, y, z] = sunDirection(new Date('2026-06-21T12:00:00Z'));
    expect(y).toBeGreaterThan(0.35);
    expect(y).toBeLessThan(0.45);
    // Noon UTC: sun over the prime meridian, +x axis.
    expect(x).toBeGreaterThan(0.8);
    expect(Math.abs(z)).toBeLessThan(0.1);
  });

  it('points south of the equator at the December solstice', () => {
    const [x, y, z] = sunDirection(new Date('2025-12-21T12:00:00Z'));
    expect(y).toBeLessThan(-0.35);
    expect(y).toBeGreaterThan(-0.45);
    expect(x).toBeGreaterThan(0.8);
    expect(Math.abs(z)).toBeLessThan(0.1);
  });

  it('crosses the equator near the March equinox', () => {
    const [x, y] = sunDirection(new Date('2026-03-20T12:00:00Z'));
    expect(Math.abs(y)).toBeLessThan(0.05);
    expect(x).toBeGreaterThan(0.9);
  });

  it('faces the antimeridian at midnight UTC', () => {
    const [x, , z] = sunDirection(new Date('2026-03-20T00:00:00Z'));
    expect(x).toBeLessThan(-0.9);
    expect(Math.abs(z)).toBeLessThan(0.15);
  });
});

describe('createDaylight', () => {
  it('writes the sun direction into light uniforms on the first refresh', () => {
    const uniforms = createUniforms();
    const daylight = createDaylight(uniforms.light);

    daylight.refresh(Date.UTC(2026, 5, 21, 12));

    const f = uniforms.rawF32;
    expect(Math.hypot(f[20]!, f[21]!, f[22]!)).toBeCloseTo(1, 5);
    expect(f[21]).toBeGreaterThan(0.35); // June: northern declination
  });

  it('refreshes on the wall-clock cadence and holds still inside it', () => {
    const uniforms = createUniforms();
    const daylight = createDaylight(uniforms.light);
    const f = uniforms.rawF32;
    const t0 = Date.UTC(2026, 2, 20, 0);

    daylight.refresh(t0);
    const first = [f[20], f[21], f[22]];

    daylight.refresh(t0 + SUN_REFRESH_MS - 1);
    expect([f[20], f[21], f[22]]).toEqual(first);

    daylight.refresh(t0 + 4 * 3_600_000);
    expect([f[20], f[21], f[22]]).not.toEqual(first);
  });

  it('defaults to the current time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 21, 12));
    const uniforms = createUniforms();
    createDaylight(uniforms.light).refresh();
    expect(uniforms.rawF32[21]).toBeGreaterThan(0.35);
  });
});
