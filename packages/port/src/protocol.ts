/**
 * The contract both ends of a service import: a name on the port, the request, reply, and event
 * types, and the guard the served side checks requests with.
 */

/** A runtime check that narrows `unknown` to `T`. */
export type Guard<T> = (value: unknown) => value is T;

/** Bytes-so-far progress for one call. */
export type Progress = (loaded: number, total: number) => void;

/**
 * A named service contract.
 *
 * @typeParam Req - What a caller sends. A served side validates it with `guard` when one is given.
 * @typeParam Res - What one call replies, or what one stream yields.
 * @typeParam Ev - What the served side pushes to its peer between calls.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Res and Ev type the service and connection built over this protocol
export interface Protocol<Req, Res, Ev = never> {
  readonly name: string;
  readonly guard?: Guard<Req>;
}

/**
 * Declare a protocol. Both ends import the same value, so the types are stated once and a served
 * side never sees a request its guard refused.
 *
 * @throws Error when `name` is empty.
 */
export function protocol<Req, Res, Ev = never>(
  name: string,
  guard?: Guard<Req>,
): Protocol<Req, Res, Ev> {
  if (name === '') throw new Error('a protocol needs a name');
  return { name, guard };
}
