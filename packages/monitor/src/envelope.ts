/** Scratch and output for {@link fold}, sized for the rows and elements one call writes. */
export interface Envelope {
  /** Two times per bucket: its first and its last. */
  readonly time: Float64Array;
  /** Two rows of `elements` values per bucket, row-major. */
  readonly values: Float64Array;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly loAt: Uint32Array;
  readonly hiAt: Uint32Array;
}

/**
 * Fold `frames` rows of `elements` values into buckets of `bucket` rows: each bucket's extremes in
 * the order they occurred, as two rows at its first and last times. A bucket with no finite value
 * folds to NaN, a gap. Returns the rows written.
 */
export function fold(
  time: Float64Array,
  values: ArrayLike<number>,
  stride: number,
  frames: number,
  elements: number,
  bucket: number,
  out: Envelope,
): number {
  const { lo, hi, loAt, hiAt } = out;
  let rows = 0;
  for (let b = 0; b < frames; b += bucket) {
    const end = Math.min(frames, b + bucket);
    lo.fill(Infinity, 0, elements);
    hi.fill(-Infinity, 0, elements);
    for (let f = b; f < end; f++) {
      const row = f * stride; // row-major: one pass, cache friendly
      for (let e = 0; e < elements; e++) {
        const v = values[row + e]!; // NaN fails both tests: skipped
        if (v < lo[e]!) {
          lo[e] = v;
          loAt[e] = f;
        }
        if (v > hi[e]!) {
          hi[e] = v;
          hiAt[e] = f;
        }
      }
    }
    out.time[rows] = time[b]!;
    out.time[rows + 1] = time[end - 1]!;
    const first = rows * elements;
    const second = first + elements;
    for (let e = 0; e < elements; e++) {
      const low = lo[e]!;
      const high = hi[e]!;
      if (low > high) {
        out.values[first + e] = out.values[second + e] = NaN;
      } else if (low === Infinity || high === -Infinity || loAt[e]! <= hiAt[e]!) {
        // Only one infinity: one extreme never moved and has no index; both rows hold it.
        out.values[first + e] = low;
        out.values[second + e] = high;
      } else {
        out.values[first + e] = high;
        out.values[second + e] = low;
      }
    }
    rows += 2;
  }
  return rows;
}
