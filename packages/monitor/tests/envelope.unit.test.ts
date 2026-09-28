import { describe, expect, it } from 'vitest';

import { fold, span, type Envelope } from '../src/envelope.js';

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

/** Pixel columns `width` time units wide. */
const columns = (width: number) => (time: number) => Math.floor(time / width);

describe('fold', () => {
  it('keeps each column extremes in the order they occurred, at its first and last times', () => {
    const time = Float64Array.of(0, 1, 2, 3, 4, 5);
    // Two elements, frame-major: element 0 rises then falls, element 1 falls then rises.
    const values = Float64Array.of(1, 9, 5, 2, 3, 7, 4, 0, 8, 6, 2, 5);
    const out = envelope(4, 2);

    expect(fold(time, values, 2, 0, 6, 2, columns(3), out)).toBe(4);
    expect(Array.from(out.time)).toEqual([0, 2, 3, 5]);
    expect(rows(out, 4, 2)).toEqual([
      [1, 9],
      [5, 2],
      [8, 0],
      [2, 6],
    ]);
  });

  it('follows uneven time steps: a crowded column folds, sparse rows stay as they are', () => {
    // Four rows crowd column 0, then one row in each of columns 2, 5, and 9.
    const time = Float64Array.of(0, 0.2, 0.4, 0.6, 2, 5, 9);
    const values = Float64Array.of(3, 8, 1, 4, 6, Infinity, NaN);
    const out = envelope(5, 1);

    expect(fold(time, values, 1, 0, 7, 1, columns(1), out)).toBe(5);
    expect(Array.from(out.time)).toEqual([0, 0.6, 2, 5, 9]);
    expect(Array.from(out.values)).toEqual([8, 1, 6, Infinity, NaN]);
  });

  it('folds from one row to another and reads past a wider stride', () => {
    const time = Float64Array.of(10, 11, 12, 13, 14);
    // Stride 3: the other columns are never read.
    const values = Float64Array.of(4, 99, 99, 1, 99, 99, 6, 99, 99, 2, 99, 99, 3, 99, 99);
    const out = envelope(4, 1);

    // Columns two units wide: row 1 alone, rows 2 and 3 together, row 4 alone.
    expect(fold(time, values, 3, 1, 5, 1, columns(2), out)).toBe(4);
    expect(Array.from(out.time)).toEqual([11, 12, 13, 14]);
    expect(Array.from(out.values)).toEqual([1, 6, 2, 3]);
  });

  it('skips NaN, and folds a column with no value to a gap', () => {
    const time = Float64Array.of(0, 1, 2, 3);
    const values = Float64Array.of(NaN, 2, NaN, 1, NaN, NaN, 5, NaN);
    const out = envelope(4, 2);

    fold(time, values, 2, 0, 4, 2, columns(2), out);
    expect(rows(out, 4, 2)).toEqual([
      [NaN, 2],
      [NaN, 1],
      [5, NaN],
      [5, NaN],
    ]);
  });

  it('holds an infinity in both rows when it is the only value a column has', () => {
    const time = Float64Array.of(0, 1, 2, 3);
    const values = Float64Array.of(Infinity, -Infinity, Infinity, -Infinity, 3, -Infinity, 1, 7);
    const out = envelope(4, 2);

    fold(time, values, 2, 0, 4, 2, columns(2), out);
    expect(rows(out, 4, 2)).toEqual([
      [Infinity, -Infinity],
      [Infinity, -Infinity],
      [3, -Infinity],
      [1, 7],
    ]);
  });
});

describe('span', () => {
  it('stops after the last whole column that fits the rows', () => {
    // Columns one unit wide: rows 0 and 1 fold to two, row 2 stays one, rows 3 and 4 fold to two.
    const time = Float64Array.of(0, 0.5, 1, 2, 2.5, 3);

    expect(span(time, 0, 6, columns(1), 2)).toBe(2);
    expect(span(time, 0, 6, columns(1), 3)).toBe(3);
    expect(span(time, 0, 6, columns(1), 4)).toBe(3);
    expect(span(time, 2, 6, columns(1), 6)).toBe(6);
  });
});
