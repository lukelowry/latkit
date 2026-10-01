import { expect, it } from 'vitest';
import {
  numberAt,
  sampleAt,
  textAt,
  rowAt,
  rowCount,
  sliceRows,
  sameIndex,
  assertIndex,
} from '../src/index.js';
it('honors offsets, bitmaps and sample strides without conflating null and present NaN', () => {
  const column = {
    kind: 'numeric' as const,
    offset: 1,
    length: 4,
    values: Float64Array.of(99, 1, NaN, 3, 4),
    validity: Uint8Array.of(0b10110),
  };
  expect(numberAt(column, 0)).toBe(1);
  expect(numberAt(column, 1)).toBeNaN();
  expect(numberAt(column, 2)).toBeNull();
  expect(sampleAt({ ...column, rowStride: 1, frameStride: 2 }, { row: 1, frame: 1 })).toBe(4);
  expect(() => numberAt(column, 4)).toThrow();
  expect(() =>
    sampleAt({ ...column, rowStride: 1, frameStride: 2 }, { row: -1, frame: 0 }),
  ).toThrow();
  const text = {
    kind: 'text' as const,
    offset: 1,
    length: 2,
    bytes: new TextEncoder().encode('!hello'),
    offsets: Int32Array.of(0, 1, 1, 6),
    validity: Uint8Array.of(0b110),
  };
  expect(textAt(text, 0)).toBe('');
  expect(textAt(text, 1)).toBe('hello');
});
it('preserves sparse axis buffers and enforces physical index identity', () => {
  const values = Uint32Array.of(9, 3, 7),
    slice = sliceRows({ kind: 'indices', values }, 1, 2);
  expect(slice.kind === 'indices' && slice.values.buffer).toBe(values.buffer);
  expect(rowAt(slice, 0)).toBe(3);
  expect(rowCount(slice)).toBe(2);
  const index = { document: 'd', type: 't', version: 'v' };
  expect(sameIndex(index, { ...index })).toBe(true);
  expect(() => assertIndex(index, { ...index, version: 'x' })).toThrow();
});
