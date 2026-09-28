/**
 * The colormap lookup texture every renderer samples: a colormap baked into opaque rgba8 texels,
 * so a shader maps a normalized value through one texture read.
 */

import type { Colormap } from '@latkit/colormaps';

/** Texels in the colormap lookup texture every renderer samples; `bakeColormap` fills that many. */
export const COLORMAP_LUT_SIZE = 256;

/** Sample `colormap` into `COLORMAP_LUT_SIZE` opaque rgba8 texels for a lookup texture. */
export function bakeColormap(colormap: Colormap): Uint8Array {
  const lut = new Uint8Array(COLORMAP_LUT_SIZE * 4);
  for (let i = 0; i < COLORMAP_LUT_SIZE; i++) {
    const [r, g, b] = colormap(i / (COLORMAP_LUT_SIZE - 1));
    lut[i * 4] = byte(r);
    lut[i * 4 + 1] = byte(g);
    lut[i * 4 + 2] = byte(b);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/** A clamped `[0, 1]` component as an 8-bit texel value. */
function byte(x: number): number {
  return Math.round(Math.min(1, Math.max(0, x)) * 255);
}
