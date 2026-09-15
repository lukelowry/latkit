import { expect, it } from 'vitest';
import { normalizeDomain, position } from '../src/domain.js';

it('normalizes f64 differences and overflowing spans without losing their positions', () => {
  expect(position(1e12 + 0.25, [1e12, 1e12 + 1])).toBe(0.25);
  expect(position(0, [-1e308, 1e308])).toBe(0.5);
  expect(position(-1e308, [-1e308, 1e308])).toBe(0);
  expect(position(1e308, [-1e308, 1e308])).toBe(1);
  expect(position(NaN, [0, 1])).toBeNaN();
});
it('expands constant domains to finite, representable endpoints', () => {
  for (const value of [0, 1e20, -1e20, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const range = normalizeDomain([value, value]);
    expect(range.every(Number.isFinite)).toBe(true);
    expect(range[0]).toBeLessThan(range[1]);
    expect(value).toBeGreaterThanOrEqual(range[0]);
    expect(value).toBeLessThanOrEqual(range[1]);
  }
});
