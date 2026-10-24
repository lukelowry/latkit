/**
 * What the package's classes share and the page never reaches: the WebAssembly bindings, once
 * loaded; the bindings' object behind each public one; and how latkit throws and waits.
 */

import * as bindings from '../pkg/latkit.js';
import type { Failure } from './outputs.js';

/**
 * What latkit throws: an `Error` with a `code`, and for invalid input the `path` to the part, such
 * as `marks[2].vertices.color`. `unloaded` is a call made before `await load()`.
 */
export interface LatkitError extends Error {
  code: Failure['code'] | 'unloaded';
  path?: string;
}

/** How long a promise may wait: until `signal` aborts, by default 30 seconds. */
export interface Wait {
  signal?: AbortSignal;
}

let ready = false;

/** @internal Marks the bindings loaded: classes may make their objects from now on. */
export function loaded(): void {
  ready = true;
}

/** @internal The bindings, or an `unloaded` error before `load()` finished. */
export function wasm(): typeof bindings {
  if (!ready)
    throw thrown({ code: 'unloaded', message: 'latkit is not loaded: call `await load()` first' });
  return bindings;
}

/** @internal The error `failure` describes, as latkit throws them. */
export function thrown({
  code,
  message,
  path,
}: Pick<Failure, 'message' | 'path'> & { code: LatkitError['code'] }): LatkitError {
  return Object.assign(new Error(message), path === undefined ? { code } : { code, path });
}

/** The bindings' object behind each public one. */
const held = new WeakMap<object, object>();

/** @internal Gives `owner` the bindings' object `inner`. */
export function hold(owner: object, inner: object): void {
  held.set(owner, inner);
}

/** @internal `owner`'s object of the bindings, or an error naming `what` once it was destroyed. */
export function inner<T extends object>(owner: object, what: string): T {
  const found = held.get(owner);
  if (!found) throw new Error(`this ${what} has been destroyed`);
  return found as T;
}

/** @internal Takes `owner`'s object of the bindings away, to free it; `undefined` once it was. */
export function release<T extends object>(owner: object): T | undefined {
  const found = held.get(owner);
  held.delete(owner);
  return found as T | undefined;
}

/** @internal A public object of class `type` around the bindings' `inner`, made without its constructor. */
export function wrap<T extends object>(type: { prototype: T }, inner: object): T {
  const made = Object.create(type.prototype) as T;
  hold(made, inner);
  return made;
}

/**
 * @internal What `pending` brings: a promise, or a task of the bindings, which is cancelled, so its
 * work is skipped, when `signal` (by default 30 seconds) aborts first. Aborting throws a `timeout`
 * error naming `what` for a timeout, `cancelled` for any other reason.
 */
export async function waited<T>(
  pending: Promise<T> | bindings.Task,
  { signal = AbortSignal.timeout(30_000) }: Wait,
  what: string,
): Promise<T> {
  const task = pending instanceof Promise ? undefined : pending;
  const promise = (task ? task.promise : pending) as Promise<T>;
  let stop = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => {
      task?.cancel();
      reject(abortError(signal, what));
    };
  });
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', stop);
    task?.free();
  }
}

/** Why `signal` aborted what was waiting for `what`, as latkit throws it. */
function abortError(signal: AbortSignal, what: string): LatkitError {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === 'TimeoutError'
    ? thrown({ code: 'timeout', message: `${what} timed out` })
    : Object.assign(thrown({ code: 'cancelled', message: `${what} was cancelled` }), {
        cause: reason,
      });
}
