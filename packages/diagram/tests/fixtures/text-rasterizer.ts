/**
 * A fake glyph rasterizer for jsdom and node, which have no canvas: every glyph is a solid box
 * centered in its cell, and every call is recorded.
 */

import type { Rasterizer } from '../../src/text/atlas.js';

/** One recorded draw. */
export interface Draw {
  readonly text: string;
  readonly font: string;
  readonly width: number;
  readonly height: number;
}

/** A rasterizer drawing a centered solid box half the cell's size, with its calls. */
export function fakeRasterizer(): Rasterizer & { readonly draws: Draw[] } {
  const draws: Draw[] = [];
  return {
    draws,
    draw(text, font, width, height) {
      draws.push({ text, font, width, height });
      const alpha = new Uint8ClampedArray(width * height);
      const x0 = Math.floor(width / 4);
      const y0 = Math.floor(height / 4);
      for (let y = y0; y < height - y0; y++)
        alpha.fill(255, y * width + x0, y * width + width - x0);
      return alpha;
    },
  };
}
