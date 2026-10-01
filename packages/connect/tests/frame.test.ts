import { expect, it } from 'vitest';
import { encodeFrame, decodeFrame, inspect, limits, transferable } from '../src/internal/frame.js';
const bounds = limits();
it('preserves overlapping typed views and nonfinite numeric payloads without JSON arrays', () => {
  const backing = new ArrayBuffer(64);
  const a = new Float64Array(backing, 8, 3);
  a.set([1, NaN, Infinity]);
  const value = { a, b: new Float64Array(backing, 16, 2), text: 'hello', nil: null };
  const frame = encodeFrame(value, bounds);
  const decoded = decodeFrame(frame, bounds) as typeof value;
  expect(decoded.a).toEqual(a);
  expect(decoded.b.buffer).toBe(decoded.a.buffer);
  expect(decoded.b.byteOffset - decoded.a.byteOffset).toBe(8);
  expect(decoded.a.buffer).toBe(frame.buffer);
});
it('does not include hidden gaps or oversized parent allocations in compact transfers', () => {
  const backing = new ArrayBuffer(1024 * 1024);
  new Uint8Array(backing).fill(123);
  const value = { a: new Uint8Array(backing, 3, 2), b: new Uint8Array(backing, 1000, 2) };
  const compact = transferable(value, bounds);
  expect(compact.buffers.reduce((n, b) => n + b.byteLength, 0)).toBeLessThan(32);
  expect(compact.value).toEqual(value);
  expect(new Uint8Array(compact.buffers[0]).slice(0, 3)).toEqual(new Uint8Array(3));
});
it('bounds frame headers and payloads and rejects corrupt descriptors', () => {
  expect(() => inspect({ text: 'x'.repeat(1000) }, limits({ maxMetadataBytes: 128 }))).toThrow();
  expect(() => decodeFrame(new Uint8Array([1, 2]), bounds)).toThrow();
  const valid = encodeFrame({ a: new Float64Array([1]) }, bounds);
  expect(() => decodeFrame(valid.subarray(0, valid.length - 1), bounds)).toThrow();
  const bad = valid.slice();
  new DataView(bad.buffer).setUint32(4, 0xffffffff, true);
  expect(() => decodeFrame(bad, bounds)).toThrow();
});
it('rejects nonportable metadata, cycles, and excessive nesting', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [cycle, { date: new Date() }, () => {}, NaN])
    expect(() => encodeFrame(value, bounds)).toThrow();
  let nested: unknown = null;
  for (let i = 0; i < 66; i++) nested = [nested];
  expect(() => encodeFrame(nested, bounds)).toThrow();
});
it('keeps special property names as data', () => {
  const object = Object.create(null) as Record<string, unknown>;
  object.__proto__ = new Uint32Array([4]);
  Object.defineProperty(object, 'constructor', { value: 'data', enumerable: true });
  const decoded = decodeFrame(encodeFrame(object, bounds), bounds) as typeof object;
  expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
  expect(decoded.__proto__).toEqual(new Uint32Array([4]));
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
});
