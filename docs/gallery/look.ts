/** The gallery's picture size, and framing a box in it. */
import type { Fit } from 'latkit';

/** Picture size in pixels. Views lay out at half this size in CSS pixels. */
export const SIZE = [1600, 1000] as const;

/**
 * Fits a box into the picture, centered with a margin of at least 7% on each side. The box is a
 * drawing's `[minX, minY, maxX, maxY]`, with y up.
 */
export function framed([x0, y0, x1, y1]: readonly [number, number, number, number]): Fit {
  const aspect = SIZE[0] / SIZE[1];
  const room = 1 - 2 * 0.07;
  const height = Math.max((y1 - y0) / room, (x1 - x0) / (room * aspect));
  const width = height * aspect;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  return {
    bounds: {
      min: [cx - width / 2, cy - height / 2, 0],
      max: [cx + width / 2, cy + height / 2, 0],
    },
  };
}
