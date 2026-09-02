import { describe, expect, it } from 'vitest';

import {
  arrayOf,
  bool,
  bounded,
  bytes,
  finite,
  index,
  keyedRecord,
  nullable,
  object,
  oneOf,
  optional,
  requests,
  str,
  stringMap,
} from '../src/guard.js';

describe('guard', () => {
  it('guards scalars with their bounds', () => {
    expect(str('ok')).toBe(true);
    expect(str('x'.repeat(65_536))).toBe(true);
    expect(str('x'.repeat(65_537))).toBe(false);
    expect(str(1)).toBe(false);
    expect(bool(false)).toBe(true);
    expect(bool('false')).toBe(false);
    expect(finite(1.5)).toBe(true);
    expect(finite(Number.NaN)).toBe(false);
    expect(finite(Number.POSITIVE_INFINITY)).toBe(false);
    expect(index(0)).toBe(true);
    expect(index(-1)).toBe(false);
    expect(index(1.5)).toBe(false);
    expect(index(2 ** 53)).toBe(false);
    expect(bounded(10)(10)).toBe(true);
    expect(bounded(10)(11)).toBe(false);
    expect(bounded(10)(-1)).toBe(false);
  });

  it('guards bytes by type tag', () => {
    expect(bytes(Uint8Array.of(1))).toBe(true);
    expect(bytes(new Uint8Array(0))).toBe(true);
    expect(bytes(new ArrayBuffer(1))).toBe(false);
    expect(bytes(Int8Array.of(1))).toBe(false);
    expect(bytes([1])).toBe(false);
  });

  it('composes guards for literals, nullability, and absence', () => {
    const dir = oneOf(['asc', 'desc']);
    expect(dir('asc')).toBe(true);
    expect(dir('up')).toBe(false);
    expect(nullable(str)(null)).toBe(true);
    expect(nullable(str)(undefined)).toBe(false);
    expect(optional(str)(undefined)).toBe(true);
    expect(optional(str)(null)).toBe(false);
  });

  it('guards objects by declared fields and ignores extras', () => {
    const point = object<{ x: number; y: number }>({ x: finite, y: finite });
    expect(point({ x: 1, y: 2 })).toBe(true);
    expect(point({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(point({ x: 1 })).toBe(false);
    expect(point([1, 2])).toBe(false);
    expect(point(null)).toBe(false);
  });

  it('guards collections with explicit limits', () => {
    expect(arrayOf(index, 2)([0, 1])).toBe(true);
    expect(arrayOf(index, 2)([0, 1, 2])).toBe(false);
    expect(arrayOf(index, 2)([0, 'x'])).toBe(false);
    expect(stringMap(1)({ a: 'b' })).toBe(true);
    expect(stringMap(1)({ a: 'b', c: 'd' })).toBe(false);
    expect(stringMap(1)({ a: 1 })).toBe(false);
    const flags = keyedRecord(['flat', 'globe'], bool);
    expect(flags({ flat: true, globe: false })).toBe(true);
    expect(flags({ flat: true })).toBe(false);
    expect(flags({ flat: true, globe: false, tilt: true })).toBe(false);
  });

  it('guards a request union by op, exhaustively', () => {
    type Request =
      | { readonly op: 'state' }
      | { readonly op: 'select'; readonly index: number }
      | { readonly op: 'rename'; readonly name: string | null };
    const isRequest = requests<Request>({
      state: {},
      select: { index },
      rename: { name: nullable(str) },
    });
    expect(isRequest({ op: 'state' })).toBe(true);
    expect(isRequest({ op: 'select', index: 3 })).toBe(true);
    expect(isRequest({ op: 'select', index: -3 })).toBe(false);
    expect(isRequest({ op: 'rename', name: null })).toBe(true);
    expect(isRequest({ op: 'rename' })).toBe(false);
    expect(isRequest({ op: 'toString' })).toBe(false);
    expect(isRequest({ op: 'nope' })).toBe(false);
    expect(isRequest('state')).toBe(false);
    expect(isRequest(null)).toBe(false);
  });
});
