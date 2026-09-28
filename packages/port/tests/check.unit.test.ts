import { describe, expect, it } from 'vitest';

import { check, type Check } from '../src/index.js';

/** Whether `value` passes `run`; a refusal is always a TypeError. */
function passes(run: (value: unknown, name: string) => void, value: unknown): boolean {
  try {
    run(value, 'value');
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return false;
  }
}

describe('check', () => {
  it('checks scalars with their bounds', () => {
    expect(passes(check.string, 'ok')).toBe(true);
    expect(passes(check.string, 'x'.repeat(65_536))).toBe(true);
    expect(passes(check.string, 'x'.repeat(65_537))).toBe(false);
    expect(passes(check.string, 1)).toBe(false);
    expect(passes(check.boolean, false)).toBe(true);
    expect(passes(check.boolean, 'false')).toBe(false);
    expect(passes(check.finite, 1.5)).toBe(true);
    expect(passes(check.finite, Number.NaN)).toBe(false);
    expect(passes(check.finite, Number.POSITIVE_INFINITY)).toBe(false);
    expect(passes(check.index, 0)).toBe(true);
    expect(passes(check.index, -1)).toBe(false);
    expect(passes(check.index, 1.5)).toBe(false);
    expect(passes(check.index, 2 ** 53)).toBe(false);
    expect(passes(check.bounded(10), 10)).toBe(true);
    expect(passes(check.bounded(10), 11)).toBe(false);
    expect(passes(check.bounded(10), -1)).toBe(false);
  });

  it('checks bytes by type tag', () => {
    expect(passes(check.bytes, Uint8Array.of(1))).toBe(true);
    expect(passes(check.bytes, new Uint8Array(0))).toBe(true);
    expect(passes(check.bytes, new ArrayBuffer(1))).toBe(false);
    expect(passes(check.bytes, Int8Array.of(1))).toBe(false);
    expect(passes(check.bytes, [1])).toBe(false);
  });

  it('composes checks for literals, nullability, and absence', () => {
    const dir = check.oneOf(['asc', 'desc']);
    expect(passes(dir, 'asc')).toBe(true);
    expect(passes(dir, 'up')).toBe(false);
    expect(passes(check.nullable(check.string), null)).toBe(true);
    expect(passes(check.nullable(check.string), undefined)).toBe(false);
    expect(passes(check.optional(check.string), undefined)).toBe(true);
    expect(passes(check.optional(check.string), null)).toBe(false);
  });

  it('checks objects by declared fields and ignores extras', () => {
    const point = check.object<{ x: number; y: number }>({ x: check.finite, y: check.finite });
    expect(passes(point, { x: 1, y: 2 })).toBe(true);
    expect(passes(point, { x: 1, y: 2, z: 3 })).toBe(true);
    expect(passes(point, { x: 1 })).toBe(false);
    expect(passes(point, [1, 2])).toBe(false);
    expect(passes(point, null)).toBe(false);
  });

  it('accepts interfaces and keeps every field check type checked', () => {
    interface Command {
      readonly app: string;
      readonly params?: Uint8Array;
    }
    const command = check.object<Command>({
      app: check.string,
      params: check.optional(check.bytes),
    });
    expect(passes(command, { app: 'run' })).toBe(true);
    expect(passes(command, { app: 'run', params: Uint8Array.of(1) })).toBe(true);
    expect(passes(command, { app: 1 })).toBe(false);
    // @ts-expect-error Every field, including optional ones, needs its check.
    check.object<Command>({ app: check.string });
    // @ts-expect-error The check must match the declared field type.
    check.object<Command>({ app: check.finite, params: check.optional(check.bytes) });
  });

  it('checks collections with explicit limits', () => {
    expect(passes(check.array(check.index, 2), [0, 1])).toBe(true);
    expect(passes(check.array(check.index, 2), [0, 1, 2])).toBe(false);
    expect(passes(check.array(check.index, 2), [0, 'x'])).toBe(false);
    expect(passes(check.stringMap(1), { a: 'b' })).toBe(true);
    expect(passes(check.stringMap(1), { a: 'b', c: 'd' })).toBe(false);
    expect(passes(check.stringMap(1), { a: 1 })).toBe(false);
    const flags = check.record(['flat', 'globe'], check.boolean);
    expect(passes(flags, { flat: true, globe: false })).toBe(true);
    expect(passes(flags, { flat: true })).toBe(false);
    expect(passes(flags, { flat: true, globe: false, tilt: true })).toBe(false);
  });

  it('checks a request union by op, exhaustively', () => {
    type Request =
      | { readonly op: 'state' }
      | { readonly op: 'select'; readonly index: number }
      | { readonly op: 'rename'; readonly name: string | null };
    const request = check.requests<Request>({
      state: {},
      select: { index: check.index },
      rename: { name: check.nullable(check.string) },
    });
    expect(passes(request, { op: 'state' })).toBe(true);
    expect(passes(request, { op: 'select', index: 3 })).toBe(true);
    expect(passes(request, { op: 'select', index: -3 })).toBe(false);
    expect(passes(request, { op: 'rename', name: null })).toBe(true);
    expect(passes(request, { op: 'rename' })).toBe(false);
    expect(passes(request, { op: 'toString' })).toBe(false);
    expect(passes(request, { op: 'nope' })).toBe(false);
    expect(passes(request, 'state')).toBe(false);
    expect(passes(request, null)).toBe(false);
  });

  it('names what is wrong, down to the field', () => {
    const shape: Check<{ items: readonly number[] }> = check.object<{ items: readonly number[] }>({
      items: check.array(check.index, 4),
    });
    expect(() => shape({ items: [0, -1] }, 'request')).toThrow(
      new TypeError('request.items[1] must be a nonnegative safe integer'),
    );
    const mode: Check<'a' | 'b'> = check.oneOf(['a', 'b']);
    expect(() => mode('c', 'mode')).toThrow('mode must be one of a, b');
    const meta: Check<Readonly<Record<string, string>>> = check.stringMap(4);
    expect(() => meta({ k: 1 }, 'meta')).toThrow(
      'meta.k must be a string of at most 65536 characters',
    );
  });

  it('narrows what it checks', () => {
    const value: unknown = 'text';
    check.string(value, 'value');
    expect(value.length).toBe(4);
    expect(Object.isFrozen(check)).toBe(true);
  });
});
