/**
 * `@latkit/port/guard` — guards for the requests a protocol accepts from a peer it does not trust.
 * A request union is guarded by `requests`, whose shape map the compiler keeps honest: every `op`
 * must appear, and every field's guard must match the field's declared type, the drift a
 * hand-written switch cannot catch. Bounds ride the guards: strings are capped, arrays and maps
 * take explicit limits.
 *
 * @packageDocumentation
 */

import type { Guard } from './protocol.js';

export type { Guard } from './protocol.js';

const MAX_STRING = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string of at most 64 KiB; every wire string rides under this cap. */
export const str: Guard<string> = (value): value is string =>
  typeof value === 'string' && value.length <= MAX_STRING;

/** A boolean. */
export const bool: Guard<boolean> = (value): value is boolean => typeof value === 'boolean';

/** A finite number. */
export const finite: Guard<number> = (value): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A non-negative safe integer: an index, a count, an identity token. */
export const index: Guard<number> = (value): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A `Uint8Array`, by type tag: `instanceof` fails across realms (a jsdom test, a vm context). */
export const bytes: Guard<Uint8Array> = (value): value is Uint8Array =>
  Object.prototype.toString.call(value) === '[object Uint8Array]';

/** A non-negative safe integer no larger than `max`: a window size, a page length. */
export function bounded(max: number): Guard<number> {
  return (value): value is number => index(value) && value <= max;
}

/** One of `values`; pass the canonical constant, never a re-typed literal list. */
export function oneOf<const T extends string>(values: readonly T[]): Guard<T> {
  const set: ReadonlySet<string> = new Set(values);
  return (value): value is T => typeof value === 'string' && set.has(value);
}

/** `inner`, or null. */
export function nullable<T>(inner: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || inner(value);
}

/** `inner`, or absent. */
export function optional<T>(inner: Guard<T>): Guard<T | undefined> {
  return (value): value is T | undefined => value === undefined || inner(value);
}

/**
 * An object whose every declared field passes its guard. Extra fields are ignored, as some hosts
 * merge their own keys into a payload.
 */
export function object<T extends Record<string, unknown>>(shape: {
  readonly [F in keyof T]-?: Guard<T[F]>;
}): Guard<T> {
  const fields = Object.entries<Guard<unknown>>(shape);
  return (value): value is T =>
    isRecord(value) && fields.every(([key, check]) => check(value[key]));
}

/** An array of at most `maxLength` entries, each passing `inner`. */
export function arrayOf<T>(inner: Guard<T>, maxLength: number): Guard<readonly T[]> {
  return (value): value is readonly T[] =>
    Array.isArray(value) && value.length <= maxLength && value.every(inner);
}

/** A string-to-string map of at most `maxEntries` entries, keys capped like every wire string. */
export function stringMap(maxEntries: number): Guard<Readonly<Record<string, string>>> {
  return (value): value is Readonly<Record<string, string>> =>
    isRecord(value) &&
    Object.keys(value).length <= maxEntries &&
    Object.entries(value).every(([key, entry]) => key.length <= MAX_STRING && str(entry));
}

/** A record with exactly `keys`, each value passing `inner`. */
export function keyedRecord<K extends string, V>(
  keys: readonly K[],
  inner: Guard<V>,
): Guard<Readonly<Record<K, V>>> {
  return (value): value is Readonly<Record<K, V>> =>
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => inner(value[key]));
}

/** The field guards one request variant demands: every field but the discriminant. */
type FieldShapes<V> = { readonly [F in Exclude<keyof V, 'op'>]-?: Guard<V[F]> };

/** The shape map `requests` demands: one entry per `op`, kept exhaustive by the compiler. */
export type RequestShapes<Req extends { readonly op: string }> = {
  readonly [K in Req['op']]: FieldShapes<Extract<Req, { readonly op: K }>>;
};

/**
 * The guard for a protocol's request union: `op` picks the variant, whose fields validate against
 * its shape. Unknown ops and non-objects fail.
 */
export function requests<Req extends { readonly op: string }>(
  shapes: RequestShapes<Req>,
): Guard<Req> {
  return (value): value is Req => {
    if (!isRecord(value)) return false;
    const op = value['op'];
    if (typeof op !== 'string' || !Object.hasOwn(shapes, op)) return false;
    const shape = (shapes as Record<string, Record<string, Guard<unknown>>>)[op];
    return Object.entries(shape).every(([key, check]) => check(value[key]));
  };
}
