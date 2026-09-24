/**
 * Signed distance fields for the glyph atlas. A glyph's coverage becomes distances to its edge, so
 * one rasterization at a fixed size draws crisp text at every zoom: the glyph pass thresholds the
 * distance at `0.5` with an anti-aliasing width from its screen-space derivative.
 */

/** Stands in for "infinitely far" in the squared-distance grids. */
const INF = 1e20;

// Scratch reused across calls: the atlas rasterizes glyphs one at a time, so one set suffices.
let outer = new Float64Array(0);
let inner = new Float64Array(0);
let f = new Float64Array(0);
let z = new Float64Array(0);
let v = new Uint32Array(0);

/**
 * An 8-bit signed distance field of a glyph's coverage: `0.5` (128) on the edge, rising inside and
 * falling outside over `radius` pixels, by an exact Euclidean distance transform (Felzenszwalb)
 * over the inside and the outside, as TinySDF does.
 *
 * @remarks
 * A texel `v` decodes to the signed distance `(0.5 - v / 255) * 2 * radius` px, positive outside;
 * `0` is `radius` or more outside and `255` is `radius` or more inside. Partly covered pixels place
 * the edge within the pixel by their coverage (`0.5 - alpha`), which keeps anti-aliased input
 * sub-pixel accurate.
 *
 * @param alpha - Coverage, `width * height` bytes, row-major.
 * @param radius - The distance in px that spans half the 8-bit range.
 * @throws RangeError when `alpha` is shorter than `width * height` or `radius` is not positive.
 */
export function sdf(
  alpha: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const size = width * height;
  if (alpha.length < size) throw new RangeError('sdf alpha must hold width * height bytes');
  if (!(radius > 0)) throw new RangeError('sdf radius must be positive');
  reserve(size, Math.max(width, height));

  // `outer` holds squared distances to the inside, `inner` squared distances to the outside.
  for (let i = 0; i < size; i++) {
    const a = alpha[i]!;
    if (a === 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else if (a === 255) {
      outer[i] = 0;
      inner[i] = INF;
    } else {
      const d = 0.5 - a / 255;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  transform(outer, width, height);
  transform(inner, width, height);

  const out = new Uint8Array(size);
  const scale = 127.5 / radius;
  for (let i = 0; i < size; i++) {
    const value = 127.5 - (Math.sqrt(outer[i]!) - Math.sqrt(inner[i]!)) * scale;
    out[i] = value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
  }
  return out;
}

/** Grow the scratch grids to hold `size` cells and 1D passes of `length`. */
function reserve(size: number, length: number): void {
  if (outer.length < size) {
    outer = new Float64Array(size);
    inner = new Float64Array(size);
  }
  if (f.length < length) {
    f = new Float64Array(length);
    z = new Float64Array(length + 1);
    v = new Uint32Array(length);
  }
}

/** The 2D squared Euclidean distance transform in place: columns, then rows. */
function transform(grid: Float64Array, width: number, height: number): void {
  for (let x = 0; x < width; x++) pass(grid, x, width, height);
  for (let y = 0; y < height; y++) pass(grid, y * width, 1, width);
}

/**
 * One 1D pass of Felzenszwalb and Huttenlocher's transform: the lower envelope of the parabolas
 * rooted at each sample, read back at every sample.
 */
function pass(grid: Float64Array, offset: number, stride: number, length: number): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset]!;
  for (let q = 1, k = 0; q < length; q++) {
    f[q] = grid[offset + q * stride]!;
    const q2 = q * q;
    // Where the new parabola overtakes the envelope's last one; drop those it hides entirely.
    let s: number;
    do {
      const r = v[k]!;
      s = (f[q]! - f[r]! + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k]! && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    const d = q - r;
    grid[offset + q * stride] = f[r]! + d * d;
  }
}
