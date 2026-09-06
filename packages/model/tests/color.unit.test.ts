import { describe, expect, it } from 'vitest';
import { bakeColormap, COLORMAP_LUT_SIZE, validateRgba } from '../src/index.js';

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
  it('samples the ramp into COLORMAP_LUT_SIZE opaque rgba8 texels from 0 to 1 inclusive', () => {
    const lut = bakeColormap((t) => [t, 1 - t, 0.5]);
    expect(lut).toBeInstanceOf(Uint8Array);
    expect(lut.length).toBe(COLORMAP_LUT_SIZE * 4);
    expect(Array.from(lut.slice(0, 4))).toEqual([0, 255, 128, 255]);
    const mid = (COLORMAP_LUT_SIZE / 2) * 4;
    expect(Array.from(lut.slice(mid, mid + 4))).toEqual([128, 127, 128, 255]);
    expect(Array.from(lut.slice(-4))).toEqual([255, 0, 128, 255]);
  });

  it('clamps out-of-range channels', () => {
    const lut = bakeColormap(() => [2, -1, 0.25]);
    expect(Array.from(lut.slice(0, 4))).toEqual([255, 0, 64, 255]);
    expect(Array.from(lut.slice(-4))).toEqual([255, 0, 64, 255]);
  });
});
