/**
 * Internals shared by the package's classes: access to the WebAssembly bindings, the bindings
 * object behind each public object, and latkit's errors and bounded waits. Of these, only the
 * `LatkitError` and `Wait` types are public.
 */

import * as bindings from '../pkg/latkit.js';
import type { Failure } from './outputs.js';

/**
 * The error latkit throws: an `Error` with a `code`, plus a `path` to the bad part of invalid
 * input, such as `marks[2].vertices.color`. The codes:
 *
 * - `invalid`: the input is malformed or does not fit; `path` says where.
 * - `unsupported`: the browser or device cannot do what was asked.
 * - `limit`: a budget or device limit would be exceeded.
 * - `io`: reading or writing external bytes failed, such as loading latkit or fetching a file.
 * - `device-lost`: the GPU device was lost; create a new `Gpu`.
 * - `cancelled`: the wait's signal aborted, or the work was cancelled.
 * - `timeout`: the wait's signal timed out.
 * - `unloaded`: the call needs WebAssembly, and `load()` has not finished.
 * - `destroyed`: the object was destroyed, so it can no longer be used.
 */
export interface LatkitError extends Error {
  code: Failure['code'] | 'unloaded' | 'destroyed';
  path?: string;
}

/** Options that bound how long a promise waits. */
export interface Wait {
  /**
   * Aborts the wait. A timeout rejects with a `timeout` error; any other abort rejects with a
   * `cancelled` error whose `cause` is the abort reason. Either way, latkit cancels the call's
   * pending work where it can. Without a signal, each wait times out after 30 seconds.
   */
  signal?: AbortSignal;
}

let ready = false;

/** @internal Marks the bindings as loaded, so `wasm()` returns them from now on. */
export function loaded(): void {
  ready = true;
}

/** @internal Returns the bindings. Throws an `unloaded` error until `load()` has finished. */
export function wasm(): typeof bindings {
  if (!ready)
    throw thrown({ code: 'unloaded', message: 'latkit is not loaded: call `await load()` first' });
  return bindings;
}

/** @internal Builds a {@link LatkitError} from a code, a message, and an optional path. */
export function thrown({
  code,
  message,
  path,
}: Pick<Failure, 'message' | 'path'> & { code: LatkitError['code'] }): LatkitError {
  return Object.assign(new Error(message), path === undefined ? { code } : { code, path });
}

/** @internal An `io` error saying `message`, with `cause` as its cause. */
function io(message: string, cause?: unknown): LatkitError {
  return Object.assign(thrown({ code: 'io', message }), cause === undefined ? {} : { cause });
}

/**
 * @internal Reads `source` into bytes, with the URL they came from as `base` (else empty). A string
 * is a URL to fetch; a `Response`, `Blob`, or byte stream is read; any other object is written as
 * JSON text. Waits within `wait`, and rejects with an `io` error when a fetch fails or answers an
 * error status.
 */
export async function bytesOf(
  source: Uint8Array | ArrayBuffer | Blob | Response | ReadableStream<Uint8Array> | string | object,
  wait: Wait,
): Promise<{ bytes: Uint8Array; base: string }> {
  if (typeof source === 'string') {
    const url = source;
    const fetched = fetch(url, { signal: wait.signal }).then(
      (response) => bytesOf(response, wait),
      (cause: unknown) => Promise.reject(io(`${url} could not be fetched`, cause)),
    );
    return waited(fetched, wait, `fetching ${url}`);
  }
  if (source instanceof Uint8Array) return { bytes: source, base: '' };
  if (source instanceof ArrayBuffer) return { bytes: new Uint8Array(source), base: '' };
  if (source instanceof Response) {
    const { url, status, statusText } = source;
    if (!source.ok) throw io(`${url}: ${status} ${statusText}`);
    const body = await source.arrayBuffer().catch((cause: unknown) => {
      throw io(`${url} could not be read`, cause);
    });
    return { bytes: new Uint8Array(body), base: url };
  }
  if (source instanceof Blob)
    return { bytes: new Uint8Array(await source.arrayBuffer()), base: '' };
  if (source instanceof ReadableStream)
    return { bytes: new Uint8Array(await new Response(source).arrayBuffer()), base: '' };
  return { bytes: new TextEncoder().encode(JSON.stringify(source)), base: '' };
}

/** Maps each public object to its bindings object, until it is released. */
const held = new WeakMap<object, object>();

/** @internal Associates public object `owner` with its bindings object `inner`. */
export function hold(owner: object, inner: object): void {
  held.set(owner, inner);
}

/**
 * @internal Returns `owner`'s bindings object. Once `owner` is destroyed, throws a `destroyed`
 * error naming `what`.
 */
export function inner<T extends object>(owner: object, what: string): T {
  const found = held.get(owner);
  if (!found) throw thrown({ code: 'destroyed', message: `this ${what} has been destroyed` });
  return found as T;
}

/**
 * @internal Detaches and returns `owner`'s bindings object, for the caller to free. Returns
 * `undefined` if it was already released.
 */
export function release<T extends object>(owner: object): T | undefined {
  const found = held.get(owner);
  held.delete(owner);
  return found as T | undefined;
}

/** @internal Creates a `type` around bindings object `inner` without calling its constructor. */
export function wrap<T extends object>(type: { prototype: T }, inner: object): T {
  const made = Object.create(type.prototype) as T;
  hold(made, inner);
  return made;
}

/**
 * @internal Awaits `pending`, a promise or a bindings task, until `signal` aborts (30 seconds by
 * default). If the signal aborts first, a task is cancelled so its work is skipped, and the call
 * rejects with an error naming `what`: `timeout` for a timeout, else `cancelled`. Work that fails
 * once the signal has aborted, such as a fetch given the same signal, rejects the same way. A task
 * is freed either way.
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
  } catch (error) {
    // A fetch given the signal rejects with the abort's reason before the abort event fires.
    throw signal.aborted ? abortError(signal, what) : error;
  } finally {
    signal.removeEventListener('abort', stop);
    task?.free();
  }
}

/**
 * The error for an aborted wait on `what`: `timeout` when `signal` timed out, else `cancelled`
 * with the abort reason as its `cause`.
 */
function abortError(signal: AbortSignal, what: string): LatkitError {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === 'TimeoutError'
    ? thrown({ code: 'timeout', message: `${what} timed out` })
    : Object.assign(thrown({ code: 'cancelled', message: `${what} was cancelled` }), {
        cause: reason,
      });
}
