import { expect, it } from 'vitest';
import { normalizeDomain } from '../src/domain.js';

it('expands constant domains to finite, representable endpoints', () => {
  for (const value of [0, 1e20, -1e20, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const range = normalizeDomain([value, value]);
    expect(range.every(Number.isFinite)).toBe(true);
    expect(range[0]).toBeLessThan(range[1]);
    expect(value).toBeGreaterThanOrEqual(range[0]);
    expect(value).toBeLessThanOrEqual(range[1]);
  }
});
