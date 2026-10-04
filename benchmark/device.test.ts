import { expect, it } from 'vitest';
import { copyUpload } from './device.ts';

it('copies typed-array elements inside the supplied view, not its backing buffer', () => {
  const data = Uint32Array.of(10, 20, 30, 40, 50);
  expect(new Uint32Array(copyUpload(data.subarray(1, 4), 1, 1).buffer)).toEqual(Uint32Array.of(30));
  expect(new Uint32Array(copyUpload(data.subarray(1, 4), 1).buffer)).toEqual(
    Uint32Array.of(30, 40),
  );
  const copy = copyUpload(data);
  data.fill(0);
  expect(new Uint32Array(copy.buffer)).toEqual(Uint32Array.of(10, 20, 30, 40, 50));
});
it('uses bytes for buffers and DataViews, including a nonzero view offset', () => {
  const buffer = Uint8Array.from({ length: 24 }, (_, i) => i).buffer;
  expect([...copyUpload(buffer, 4, 4)]).toEqual([4, 5, 6, 7]);
  expect([...copyUpload(new DataView(buffer, 8, 12), 4, 4)]).toEqual([12, 13, 14, 15]);
  expect(copyUpload(buffer, 24)).toHaveLength(0);
});
it('rejects ranges that slice would silently clamp', () => {
  const data = new Uint32Array(4);
  for (const [offset, count] of [
    [-1, 1],
    [0.5, 1],
    [3, 2],
    [5, 0],
    [0, -1],
  ])
    expect(() => copyUpload(data, offset, count)).toThrow(RangeError);
  expect(() => copyUpload(new Uint8Array(3))).toThrow(/four bytes/);
});
