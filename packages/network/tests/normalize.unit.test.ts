import { describe, expect, it } from 'vitest';
import { effectiveDomain, linearNorm } from '../src/normalize.js';

describe('channel range helpers', () => {
  it('uses clamp, then data range, then the default range', () => {
    expect(effectiveDomain([2, 8], [3, 5])).toEqual([3, 5]);
    expect(effectiveDomain([2, 8], null)).toEqual([2, 8]);
    expect(effectiveDomain(null, null)).toEqual([0, 1]);
  });

  it('maps a symmetric range so value 0 lands at t = 0.5', () => {
    const [min, scale] = linearNorm(-8, 8);
    expect((0 - min) * scale).toBeCloseTo(0.5);
  });

  it('computes linear size normalization', () => {
    expect(linearNorm(10, 30)).toEqual([10, 0.05]);
  });
});
