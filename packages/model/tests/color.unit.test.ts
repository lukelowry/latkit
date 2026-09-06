import { describe, expect, it } from 'vitest';
import { bakeColormap, validateRgba } from '../src/index.js';

describe('validateRgba', () => {
  it('accepts four finite components in [0, 1]', () => {
    expect(() => validateRgba([0, 0.5, 1, 1])).not.toThrow();
  });

  it('rejects the wrong shape with a TypeError naming the value', () => {
    expect(() => validateRgba([0, 0, 0], 'option x')).toThrow(
      new TypeError('option x must be an RGBA tuple'),
    );
    expect(() => validateRgba(['0', 0, 0, 1])).toThrow(TypeError);
    expect(() => validateRgba(null)).toThrow(TypeError);
  });

  it('rejects components outside [0, 1] or non-finite with a RangeError', () => {
    expect(() => validateRgba([0, 0, 1.5, 1], 'option x')).toThrow(
      new RangeError('option x RGBA components must be finite and in [0, 1]'),
    );
    expect(() => validateRgba([Number.NaN, 0, 0, 1])).toThrow(RangeError);
    expect(() => validateRgba([-0.1, 0, 0, 1])).toThrow(RangeError);
  });
});

describe('bakeColormap', () => {
  it('samples the ramp into opaque rgba8 texels from 0 to 1 inclusive', () => {
    const lut = bakeColormap((t) => [t, 1 - t, 0.5], 4);
    expect(lut).toBeInstanceOf(Uint8Array);
    expect(Array.from(lut)).toEqual([
      0, 255, 128, 255, 85, 170, 128, 255, 170, 85, 128, 255, 255, 0, 128, 255,
    ]);
  });

  it('clamps out-of-range channels and defaults to 256 entries', () => {
    const lut = bakeColormap(() => [2, -1, 0.25]);
    expect(lut.length).toBe(256 * 4);
    expect(Array.from(lut.slice(0, 4))).toEqual([255, 0, 64, 255]);
    expect(Array.from(lut.slice(-4))).toEqual([255, 0, 64, 255]);
  });
});
