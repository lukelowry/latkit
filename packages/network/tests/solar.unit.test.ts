import { describe, it, expect } from 'vitest';
import { sunDirection } from '../src/camera/solar.js';

const len = ([x, y, z]: [number, number, number]) => Math.sqrt(x * x + y * y + z * z);

describe('sunDirection', () => {
  it('returns a unit vector', () => {
    const d = sunDirection(new Date('2026-06-15T08:30:00Z'));
    expect(len(d)).toBeCloseTo(1.0, 10);
  });

  it('points north of equator at summer solstice noon', () => {
    const [x, y, z] = sunDirection(new Date('2026-06-21T12:00:00Z'));
    expect(y).toBeGreaterThan(0); // northern hemisphere
    expect(x).toBeGreaterThan(0); // sun over prime meridian
    expect(Math.abs(z)).toBeLessThan(0.02);
  });

  it('points south of equator at winter solstice noon', () => {
    const [x, y, z] = sunDirection(new Date('2025-12-21T12:00:00Z'));
    expect(y).toBeLessThan(0); // southern hemisphere
    expect(x).toBeGreaterThan(0); // sun over prime meridian
    expect(Math.abs(z)).toBeLessThan(0.02);
  });

  it('points near equator at equinox noon', () => {
    const [x, y] = sunDirection(new Date('2026-03-20T12:00:00Z'));
    expect(Math.abs(y)).toBeLessThan(0.04); // near equator
    expect(x).toBeGreaterThan(0); // sun over prime meridian
  });

  it('points away from prime meridian at midnight', () => {
    const [x, , z] = sunDirection(new Date('2026-03-20T00:00:00Z'));
    expect(x).toBeLessThan(0); // sun on far side
    expect(Math.abs(z)).toBeLessThan(0.02);
  });
});
