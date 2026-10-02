/** Separable squared Euclidean distance transform, linear in the number of pixels. */
function transform(grid: Float64Array, width: number, height: number): void {
  const length = Math.max(width, height),
    f = new Float64Array(length),
    d = new Float64Array(length),
    sites = new Int32Array(length),
    boundaries = new Float64Array(length + 1);
  const line = (count: number): void => {
    let k = 0;
    sites[0] = 0;
    boundaries[0] = -Infinity;
    boundaries[1] = Infinity;
    for (let q = 1; q < count; q++) {
      let p = sites[k],
        s = (f[q] + q * q - f[p] - p * p) / (2 * (q - p));
      while (s <= boundaries[k]) {
        p = sites[--k];
        s = (f[q] + q * q - f[p] - p * p) / (2 * (q - p));
      }
      sites[++k] = q;
      boundaries[k] = s;
      boundaries[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < count; q++) {
      while (boundaries[k + 1] < q) k++;
      const delta = q - sites[k];
      d[q] = delta * delta + f[sites[k]];
    }
  };
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    line(height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    f.set(grid.subarray(y * width, (y + 1) * width));
    line(width);
    grid.set(d.subarray(0, width), y * width);
  }
}

export function distanceField(
  coverage: Uint8Array,
  width: number,
  height: number,
  padding: number,
): Uint8Array<ArrayBuffer> {
  const w = width + padding * 2,
    h = height + padding * 2,
    outside = new Float64Array(w * h),
    inside = new Float64Array(w * h);
  outside.fill(1e20);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = coverage[y * width + x] / 255,
        i = (y + padding) * w + x + padding;
      outside[i] = alpha === 0 ? 1e20 : Math.max(0, 0.5 - alpha) ** 2;
      inside[i] = alpha === 1 ? 1e20 : Math.max(0, alpha - 0.5) ** 2;
    }
  transform(outside, w, h);
  transform(inside, w, h);
  const result = new Uint8Array(w * h);
  for (let i = 0; i < result.length; i++)
    result[i] = Math.round(
      Math.max(
        0,
        Math.min(255, 255 * (0.5 + (Math.sqrt(inside[i]) - Math.sqrt(outside[i])) / (2 * padding))),
      ),
    );
  return result;
}
