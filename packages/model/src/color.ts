/**
 * Color vocabulary every latkit renderer shares: a normalized color tuple, a transfer function,
 * the one check run on a color option, and the one bake that turns a transfer function into texels.
 */

/** Normalized RGBA color, each component in `[0, 1]`. */
export type RGBA = readonly [number, number, number, number];

/**
 * Maps a normalized scalar to RGB channels in `[0, 1]`.
 *
 * @param t - Normalized value; implementations clamp it to `[0, 1]`.
 */
export type Colormap = (t: number) => readonly [number, number, number];

/**
 * Assert that `value` is four finite numbers in `[0, 1]`, naming it in the error.
 *
 * @throws TypeError when the value is not a four-number tuple; RangeError when a component is
 * not finite or is outside `[0, 1]`.
 */
export function validateRgba(value: unknown, name = 'color'): asserts value is RGBA {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError(`${name} must be an RGBA tuple`);
  }
  for (const component of value as readonly unknown[]) {
    if (typeof component !== 'number') throw new TypeError(`${name} must be an RGBA tuple`);
    if (!Number.isFinite(component) || component < 0 || component > 1) {
      throw new RangeError(`${name} RGBA components must be finite and in [0, 1]`);
    }
  }
}

/** Sample `colormap` into `size` opaque rgba8 texels, `size * 4` bytes, for a lookup texture. */
export function bakeColormap(colormap: Colormap, size = 256): Uint8Array {
  const lut = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = colormap(i / (size - 1));
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
