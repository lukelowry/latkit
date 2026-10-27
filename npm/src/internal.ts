/**
 * What the package's classes share: access to the WebAssembly bindings, the `Handle` base class,
 * latkit's errors and bounded waits, and reading bytes. Of these, `Handle`, `LatkitError`, `Wait`,
 * `ByteSource`, and `ReadableBytes` are public.
 */

import * as bindings from '../pkg/latkit.js';
import type { Failure } from './outputs.js';

/** The error latkit throws: an `Error` whose `code` says what kind of failure it is. */
export interface LatkitError extends Error {
  /**
   * The kind of failure:
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
  code: Failure['code'] | 'unloaded' | 'destroyed';
  /** The invalid part of the input, such as `marks[2].vertices.color`, on `invalid` errors. */
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

/** @internal Builds a {@link LatkitError}: a code, a message, and optionally a path and a cause. */
export function thrown({
  code,
  message,
  path,
  cause,
}: Pick<Failure, 'message' | 'path'> & {
  code: LatkitError['code'];
  cause?: unknown;
}): LatkitError {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  return Object.assign(error, path === undefined ? { code } : { code, path });
}

/** The bindings object behind each handle, until it is destroyed, and the name its errors use. */
const held = new WeakMap<Handle, { bound?: { free(): void }; what: string }>();

/**
 * An object that holds WebAssembly memory, and GPU memory for a `Gpu`, until it is destroyed:
 * `destroy()` frees it, as does a `using` declaration when its block ends. Once it is destroyed,
 * its other methods throw a `destroyed` error.
 */
export abstract class Handle {
  /** @internal Holds `bound`, the bindings object it frees; errors name the object `what`. */
  constructor(bound: { free(): void }, what: string) {
    held.set(this, { bound, what });
  }

  /** Frees the object's memory. Calling it again does nothing. */
  destroy(): void {
    const entry = held.get(this);
    const bound = entry?.bound;
    if (!bound) return;
    entry.bound = undefined;
    this.freeing();
    bound.free();
  }

  /** @internal Runs once, as the object is destroyed, before its memory is freed. */
  protected freeing(): void {}

  /** Calls `destroy()`, so a `using` declaration destroys the object when its block ends. */
  [Symbol.dispose](): void {
    this.destroy();
  }
}

/** @internal Returns `owner`'s bindings object. Throws a `destroyed` error once it is destroyed. */
export function inner<T>(owner: Handle): T {
  const entry = held.get(owner)!;
  if (!entry.bound)
    throw thrown({ code: 'destroyed', message: `this ${entry.what} has been destroyed` });
  return entry.bound as T;
}

/** A byte stream: anything shaped like a browser or Node.js `ReadableStream` of `Uint8Array`. */
export interface ReadableBytes {
  /** A reader of the stream's chunks, which latkit reads to the end, or cancels. */
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

/**
 * Bytes to read: an array or buffer, a `Blob`, a `Response`, a byte stream, or a URL to fetch as a
 * string. Reading waits within its {@link Wait}, and fails with an `io` error when a fetch fails or
 * answers an error status, or the bytes cannot be read.
 */
export type ByteSource =
  Uint8Array | ArrayBuffer | Blob | Response | ReadableBytes | AsyncIterable<Uint8Array> | string;

/**
 * @internal Reads `source` into bytes, with the URL they came from as `base` (else empty). Any
 * object that is not a {@link ByteSource} is written as JSON text. Waits within `wait`, cancelling
 * a fetch or stream it gives up on.
 */
export async function bytesOf(
  source: ByteSource | object,
  wait: Wait,
): Promise<{ bytes: Uint8Array; base: string }> {
  const failed = (message: string) => (cause: unknown) =>
    Promise.reject(thrown({ code: 'io', message, cause }));
  const reading = (what: string, bytes: Promise<ArrayBuffer>) =>
    waited(
      bytes.then((read) => new Uint8Array(read), failed(`${what} could not be read`)),
      wait,
      `reading ${what}`,
    );
  if (source instanceof Uint8Array) return { bytes: source, base: '' };
  if (source instanceof ArrayBuffer) return { bytes: new Uint8Array(source), base: '' };
  if (typeof source === 'string') {
    const fetched = fetch(source, { signal: wait.signal }).catch(
      failed(`${source} could not be fetched`),
    );
    return bytesOf(await waited(fetched, wait, `fetching ${source}`), wait);
  }
  if (source instanceof Response) {
    const { url, status, statusText } = source;
    if (!source.ok) throw thrown({ code: 'io', message: `${url}: ${status} ${statusText}` });
    return { bytes: await reading(url || 'the response', source.arrayBuffer()), base: url };
  }
  if (source instanceof Blob)
    return { bytes: await reading('the blob', source.arrayBuffer()), base: '' };
  if ('getReader' in source || Symbol.asyncIterator in source) {
    const stream = source as ReadableBytes | AsyncIterable<Uint8Array>;
    return {
      bytes: await waited(collect(stream, wait.signal), wait, 'reading the stream'),
      base: '',
    };
  }
  return { bytes: new TextEncoder().encode(JSON.stringify(source)), base: '' };
}

/** The bytes of `stream` in one array; see {@link chunks}. */
async function collect(
  stream: ReadableBytes | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks(stream, signal)) parts.push(chunk);
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  parts.reduce((at, part) => (bytes.set(part, at), at + part.length), 0);
  return bytes;
}

/**
 * @internal Yields the chunks of `stream`, through `getReader()` when it has one, else by async
 * iteration, until the stream ends or `signal` aborts. Stopping early cancels the stream, with the
 * abort's reason. A failed read throws an `io` error.
 */
export async function* chunks(
  stream: ReadableBytes | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const failed = (cause: unknown) =>
    thrown({ code: 'io', message: 'the stream could not be read', cause });
  if (!('getReader' in stream)) {
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) return;
        yield chunk;
      }
    } catch (cause) {
      throw failed(cause);
    }
    return;
  }
  const reader = stream.getReader();
  const cancel = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  let ended = false;
  try {
    while (!signal?.aborted) {
      const read = await reader.read().catch((cause: unknown) => Promise.reject(failed(cause)));
      if ((ended = read.done)) return;
      if (!read.value) throw thrown({ code: 'io', message: 'a stream chunk is missing' });
      yield read.value;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!ended) await reader.cancel(signal?.reason).catch(() => {});
    reader.releaseLock();
  }
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
    : thrown({ code: 'cancelled', message: `${what} was cancelled`, cause: reason });
}
