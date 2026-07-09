import { describe, expect, it } from 'vitest';
import { effectiveRange, finiteExtent, linearNorm } from '../src/range.js';

describe('channel range helpers', () => {
  it('uses clamp, then data range, then the default range', () => {
    expect(effectiveRange([2, 8], [3, 5])).toEqual([3, 5]);
    expect(effectiveRange([2, 8], null)).toEqual([2, 8]);
    expect(effectiveRange(null, null)).toEqual([0, 1]);
  });

  it('maps a symmetric range so value 0 lands at t = 0.5', () => {
    const [min, scale] = linearNorm(-8, 8);
    expect((0 - min) * scale).toBeCloseTo(0.5);
  });

  it('scans the finite extent for height-domain defaults', () => {
    expect(finiteExtent(new Float32Array([Number.NaN, -2, 5, Infinity]))).toEqual([-2, 5]);
    expect(finiteExtent(new Float32Array([Number.NaN, Infinity]))).toBeNull();
  });

  it('computes linear size normalization', () => {
    expect(linearNorm(10, 30)).toEqual([10, 0.05]);
  });
});
