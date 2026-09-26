import { describe, expect, it } from 'vitest';

import { fold, type Envelope } from '../src/envelope.js';

function envelope(rows: number, elements: number): Envelope {
  return {
    time: new Float64Array(rows),
    values: new Float64Array(rows * elements),
    lo: new Float64Array(elements),
    hi: new Float64Array(elements),
    loAt: new Uint32Array(elements),
    hiAt: new Uint32Array(elements),
  };
}

/** Rows of `elements` values as nested arrays, for readable expectations. */
function rows(out: Envelope, count: number, elements: number): number[][] {
  return Array.from({ length: count }, (_, r) =>
    Array.from(out.values.subarray(r * elements, (r + 1) * elements)),
  );
}

describe('fold', () => {
  it('keeps each bucket extremes in the order they occurred, at its first and last times', () => {
    const time = Float64Array.of(0, 1, 2, 3, 4, 5);
    // Two elements, frame-major: element 0 rises then falls, element 1 falls then rises.
    const values = Float64Array.of(1, 9, 5, 2, 3, 7, 4, 0, 8, 6, 2, 5);
    const out = envelope(4, 2);

    expect(fold(time, values, 2, 6, 2, 3, out)).toBe(4);
    expect(Array.from(out.time)).toEqual([0, 2, 3, 5]);
    expect(rows(out, 4, 2)).toEqual([
      [1, 9],
      [5, 2],
      [8, 0],
      [2, 6],
    ]);
  });

  it('folds a partial last bucket and reads past a wider stride', () => {
    const time = Float64Array.of(10, 11, 12, 13, 14);
    // Stride 3: the third column is never read.
    const values = Float64Array.of(4, 99, 99, 1, 99, 99, 6, 99, 99, 2, 99, 99, 3, 99, 99);
    const out = envelope(6, 1);

    expect(fold(time, values, 3, 5, 1, 2, out)).toBe(6);
    expect(Array.from(out.time)).toEqual([10, 11, 12, 13, 14, 14]);
    expect(Array.from(out.values)).toEqual([4, 1, 6, 2, 3, 3]);
  });

  it('skips NaN, and folds a bucket with no value to a gap', () => {
    const time = Float64Array.of(0, 1, 2, 3);
    const values = Float64Array.of(NaN, 2, NaN, 1, NaN, NaN, 5, NaN);
    const out = envelope(4, 2);

    fold(time, values, 2, 4, 2, 2, out);
    expect(rows(out, 4, 2)).toEqual([
      [NaN, 2],
      [NaN, 1],
      [5, NaN],
      [5, NaN],
    ]);
  });

  it('holds an infinity in both rows when it is the only value a bucket has', () => {
    const time = Float64Array.of(0, 1, 2, 3);
    const values = Float64Array.of(Infinity, -Infinity, Infinity, -Infinity, 3, -Infinity, 1, 7);
    const out = envelope(4, 2);

    fold(time, values, 2, 4, 2, 2, out);
    expect(rows(out, 4, 2)).toEqual([
      [Infinity, -Infinity],
      [Infinity, -Infinity],
      [3, -Infinity],
      [1, 7],
    ]);
  });
});
