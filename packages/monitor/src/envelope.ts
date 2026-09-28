/** Scratch and output for {@link fold}, sized for the rows and elements one call writes. */
export interface Envelope {
  /** A time per row: a bucket's first and last, or its only one. */
  readonly time: Float64Array;
  /** A row of `elements` values per time, row-major. */
  readonly values: Float64Array;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly loAt: Uint32Array;
  readonly hiAt: Uint32Array;
}

/** The pixel column a time falls in; never decreasing as time grows. */
export type Column = (time: number) => number;

/**
 * Where folding rows from `from` stops so its buckets write at most `rows` rows, two or more: after
 * the last whole bucket that fits, or at `to`.
 */
export function span(
  time: Float64Array,
  from: number,
  to: number,
  column: Column,
  rows: number,
): number {
  let stop = from;
  for (let written = 0; stop < to;) {
    const end = bucketEnd(time, stop, to, column);
    written += Math.min(2, end - stop);
    if (written > rows) break;
    stop = end;
  }
  return stop;
}

/**
 * Fold rows `[from, to)` of `elements` values into buckets, each the run of rows whose times fall
 * in one pixel column: a bucket's extremes in the order they occurred, as rows at its first and
 * last times, or its one row as it is. A bucket with no finite value folds to NaN, a gap. Returns
 * the rows written.
 */
export function fold(
  time: Float64Array,
  values: ArrayLike<number>,
  stride: number,
  from: number,
  to: number,
  elements: number,
  column: Column,
  out: Envelope,
): number {
  const { lo, hi, loAt, hiAt } = out;
  let rows = 0;
  for (let b = from; b < to;) {
    const end = bucketEnd(time, b, to, column);
    const first = rows * elements;
    if (end - b === 1) {
      out.time[rows++] = time[b]!;
      for (let e = 0; e < elements; e++) out.values[first + e] = values[b * stride + e]!;
      b = end;
      continue;
    }
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
    b = end;
  }
  return rows;
}

/** The end of the bucket starting at `from`: past every row after it in the same column. */
function bucketEnd(time: Float64Array, from: number, to: number, column: Column): number {
  const at = column(time[from]!);
  let end = from + 1;
  while (end < to && column(time[end]!) === at) end++;
  return end;
}
