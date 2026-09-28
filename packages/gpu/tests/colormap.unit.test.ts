import { describe, expect, it } from 'vitest';

import { bakeColormap, COLORMAP_LUT_SIZE } from '../src/index.js';

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
