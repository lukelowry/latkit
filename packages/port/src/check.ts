/**
 * Checks for what a peer sends: each returns when a value is what it claims and throws a
 * `TypeError` naming what is wrong when it is not, so a refused request says why. A request union
 * is checked by `check.requests`, whose shape map the compiler keeps honest: every `op` must
 * appear, and every field's check must match the field's declared type. Bounds ride the checks:
 * strings are capped, arrays and maps take explicit limits.
 */

/** The type a check checks, for the compiler alone. */
declare const checked: unique symbol;

/** A runtime check: returns when `value` is a `T`, and throws a `TypeError` naming it otherwise. */
export type Check<T> = ((value: unknown, name: string) => asserts value is T) & {
  /**
   * The type it checks, for the compiler alone: the compiler does not compare what two assertions
   * assert, so this keeps one type's check from standing in for another's.
   */
  readonly [checked]?: T;
};

/** A check called where the compiler cannot narrow through it. */
type Run = (value: unknown, name: string) => void;

const MAX_STRING = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The field checks one request variant demands: every field but the discriminant. */
type FieldShapes<V> = { readonly [F in Exclude<keyof V, 'op'>]-?: Check<V[F]> };

/** The shape map `check.requests` demands: one entry per `op`, kept exhaustive by the compiler. */
type RequestShapes<Req extends { readonly op: string }> = {
  readonly [K in Req['op']]: FieldShapes<Extract<Req, { readonly op: K }>>;
};

/** The checks a protocol composes its request checks from. */
interface Checks {
  /** A string of at most 64 KiB; every wire string rides under this cap. */
  readonly string: Check<string>;
  readonly boolean: Check<boolean>;
  /** A finite number. */
  readonly finite: Check<number>;
  /** A non-negative safe integer: an index, a count, an identity token. */
  readonly index: Check<number>;
  /** A `Uint8Array`, by type tag: `instanceof` fails across realms (a jsdom test, a vm context). */
  readonly bytes: Check<Uint8Array>;
  /** A non-negative safe integer no larger than `max`: a window size, a page length. */
  bounded(max: number): Check<number>;
  /** One of `values`; pass the canonical constant, never a re-typed literal list. */
  oneOf<const T extends string>(values: readonly T[]): Check<T>;
  /** `inner`, or null. */
  nullable<T>(inner: Check<T>): Check<T | null>;
  /** `inner`, or absent. */
  optional<T>(inner: Check<T>): Check<T | undefined>;
  /**
   * An object whose every declared field passes its check. Extra fields are ignored, as some
   * hosts merge their own keys into a payload.
   */
  object<T extends object>(shape: { readonly [F in keyof T]-?: Check<T[F]> }): Check<T>;
  /** An array of at most `maxLength` entries, each passing `inner`. */
  array<T>(inner: Check<T>, maxLength: number): Check<readonly T[]>;
  /** A string-to-string map of at most `maxEntries` entries, keys capped like every wire string. */
  stringMap(maxEntries: number): Check<Readonly<Record<string, string>>>;
  /** A record with exactly `keys`, each value passing `inner`. */
  record<K extends string, V>(keys: readonly K[], inner: Check<V>): Check<Readonly<Record<K, V>>>;
  /**
   * A protocol's request union: `op` picks the variant, whose fields check against its shape.
   * Unknown ops and non-objects fail.
   */
  requests<Req extends { readonly op: string }>(shapes: RequestShapes<Req>): Check<Req>;
}

function fail(name: string, what: string): never {
  throw new TypeError(`${name} must be ${what}`);
}

const string: Check<string> = (value, name) => {
  if (typeof value !== 'string' || value.length > MAX_STRING)
    fail(name, `a string of at most ${MAX_STRING} characters`);
};

const index: Check<number> = (value, name) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail(name, 'a nonnegative safe integer');
};

/** Every check a protocol composes its requests from. */
export const check: Checks = Object.freeze<Checks>({
  string,
  boolean(value, name) {
    if (typeof value !== 'boolean') fail(name, 'a boolean');
  },
  finite(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(name, 'a finite number');
  },
  index,
  bytes(value, name) {
    if (Object.prototype.toString.call(value) !== '[object Uint8Array]') fail(name, 'a Uint8Array');
  },
  bounded(max) {
    return (value, name) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
        fail(name, `a nonnegative safe integer no larger than ${max}`);
    };
  },
  oneOf<const T extends string>(values: readonly T[]): Check<T> {
    const set: ReadonlySet<string> = new Set(values);
    return (value, name) => {
      if (typeof value !== 'string' || !set.has(value)) fail(name, `one of ${values.join(', ')}`);
    };
  },
  nullable<T>(inner: Check<T>): Check<T | null> {
    const run: Run = inner;
    return (value, name) => {
      if (value !== null) run(value, name);
    };
  },
  optional<T>(inner: Check<T>): Check<T | undefined> {
    const run: Run = inner;
    return (value, name) => {
      if (value !== undefined) run(value, name);
    };
  },
  object<T extends object>(shape: { readonly [F in keyof T]-?: Check<T[F]> }): Check<T> {
    const fields = Object.entries(shape) as [string, Run][];
    return (value, name) => {
      if (!isRecord(value)) fail(name, 'an object');
      for (const [key, run] of fields) run(value[key], `${name}.${key}`);
    };
  },
  array<T>(inner: Check<T>, maxLength: number): Check<readonly T[]> {
    const run: Run = inner;
    return (value, name) => {
      if (!Array.isArray(value) || value.length > maxLength)
        fail(name, `an array of at most ${maxLength} entries`);
      value.forEach((item: unknown, at) => run(item, `${name}[${at}]`));
    };
  },
  stringMap(maxEntries) {
    return (value, name) => {
      if (!isRecord(value) || Object.keys(value).length > maxEntries)
        fail(name, `a map of at most ${maxEntries} entries`);
      for (const [key, entry] of Object.entries(value)) {
        if (key.length > MAX_STRING) fail(`${name} key`, `at most ${MAX_STRING} characters`);
        string(entry, `${name}.${key}`);
      }
    };
  },
  record<K extends string, V>(keys: readonly K[], inner: Check<V>): Check<Readonly<Record<K, V>>> {
    const run: Run = inner;
    return (value, name) => {
      if (!isRecord(value) || Object.keys(value).length !== keys.length)
        fail(name, `a record of ${keys.join(', ')}`);
      for (const key of keys) run(value[key], `${name}.${key}`);
    };
  },
  requests<Req extends { readonly op: string }>(shapes: RequestShapes<Req>): Check<Req> {
    const variants = shapes as Readonly<Record<string, Readonly<Record<string, Run>>>>;
    const ops = Object.keys(variants);
    return (value, name) => {
      if (!isRecord(value)) fail(name, 'an object');
      const op = value['op'];
      if (typeof op !== 'string' || !Object.hasOwn(variants, op))
        fail(`${name}.op`, `one of ${ops.join(', ')}`);
      for (const [key, run] of Object.entries(variants[op]!)) run(value[key], `${name}.${key}`);
    };
  },
});
