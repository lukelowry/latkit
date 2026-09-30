/** Normalized, sRGB-encoded channels with straight (unassociated) alpha. */
export type RGBA = readonly [red: number, green: number, blue: number, alpha: number];

export function validateRgba(value: unknown, name = 'color'): asserts value is RGBA {
  if (!Array.isArray(value) || value.length !== 4 || value.some((v) => typeof v !== 'number'))
    throw new TypeError(`${name} must be an RGBA tuple`);
  if (value.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
    throw new RangeError(`${name} channels must be finite and in [0, 1]`);
}

export function freezeColor(value: RGBA): RGBA {
  validateRgba(value);
  return Object.freeze([...value]) as RGBA;
}
