/**
 * The contract both ends of a service import: a name on the port, the request, reply, and event
 * types, and the check the served side runs on every request.
 */

import type { Check } from './check.js';

/** Bytes-so-far progress for one call. */
export type Progress = (loaded: number, total: number) => void;

/**
 * A named service contract.
 *
 * @typeParam Req - What a caller sends. A served side checks it with `check` when one is given.
 * @typeParam Res - What one call replies, or what one stream yields.
 * @typeParam Ev - What the served side pushes to its peer between calls.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Res and Ev type the service and connection built over this protocol
export interface Protocol<Req, Res, Ev = never> {
  readonly name: string;
  readonly check?: Check<Req>;
}

/**
 * Declare a protocol. Both ends import the same value, so the types are stated once and a served
 * side never sees a request its check refused.
 *
 * @throws Error when `name` is empty.
 */
export function protocol<Req, Res, Ev = never>(
  name: string,
  check?: Check<Req>,
): Protocol<Req, Res, Ev> {
  if (name === '') throw new Error('a protocol needs a name');
  return { name, check };
}
