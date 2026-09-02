import { describe, expect, it } from 'vitest';
import { effectiveRange, finiteExtent, linearNorm, validateDomain } from '../src/range.js';

describe('channel range helpers', () => {
  it.each([
    [0, 1],
    [-10, -2],
    [3, 3],
  ] as const)('accepts the finite ordered range [%s, %s]', (minimum, maximum) => {
    expect(() => validateDomain([minimum, maximum])).not.toThrow();
  });

  it.each([
    [null, TypeError],
    [[0], TypeError],
    [[0, 1, 2], TypeError],
    [['0', 1], TypeError],
    [[0, Number.NaN], RangeError],
    [[Number.NEGATIVE_INFINITY, 1], RangeError],
    [[2, 1], RangeError],
  ] as const)('rejects invalid range %# with the semantic error class', (value, ErrorType) => {
    expect(() => validateDomain(value)).toThrow(ErrorType);
  });

  it('uses the caller-facing name in validation failures without mutating input', () => {
    const range = [2, 1];

    expect(() => validateDomain(range, 'vertex height range')).toThrow(
      'vertex height range minimum must not exceed its maximum',
    );
    expect(range).toEqual([2, 1]);
  });

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
