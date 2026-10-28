/**
 * Code the package's classes share: access to the WebAssembly bindings, the `Handle` base class,
 * errors, bounded waits, and byte reading. `Handle`, `LatkitError`, `Wait`, `ByteSource`, and
 * `ReadableBytes` are public.
 */

import * as bindings from '../pkg/latkit.js';
import type { Failure } from './outputs.js';

/** The error latkit throws: an `Error` with a `code` that names the kind of failure. */
export interface LatkitError extends Error {
  /**
   * The kind of failure:
   *
   * - `invalid`: the input is malformed or does not fit. `path` says where.
   * - `unsupported`: the browser or device cannot do what was asked.
   * - `limit`: a budget or device limit would be exceeded.
   * - `io`: reading or writing external bytes failed, such as loading latkit or fetching a file.
   * - `device-lost`: the GPU device was lost. Create a new `Gpu`.
   * - `cancelled`: the wait's signal aborted, or the work was cancelled.
   * - `timeout`: the wait's signal timed out.
   * - `unloaded`: the call needs WebAssembly, and `load()` has not finished.
   * - `destroyed`: the object was destroyed and can't be used.
   * - `stopped`: latkit hit an internal error and stopped. Every view reports it once, every
   *   `Gpu` is lost, and every later call throws it. Reload the page to start over.
   */
  code: Failure['code'] | 'unloaded' | 'destroyed' | 'stopped';
  /** On `invalid` errors, the invalid part of the input, such as `marks[2].color`. */
  path?: string;
}

/** Options that bound how long a promise waits. */
export interface Wait {
  /**
   * Aborts the wait. A timeout rejects with a `timeout` error. Any other abort rejects with a
   * `cancelled` error, with the abort reason as its `cause`. Either way, latkit cancels the call's
   * pending work where it can. Without a signal, each wait times out after 30 seconds.
   */
  signal?: AbortSignal;
}

let ready = false;

/** The error every call throws once an internal error stopped latkit. */
let halted: LatkitError | undefined;
/** Callbacks to tell when latkit stops. */
const told = new Set<(error: LatkitError) => void>();

/** @internal Marks the bindings as loaded, so `wasm()` returns them. */
export function loaded(): void {
  ready = true;
}

/**
 * @internal Stops latkit after the panic that `message` describes. A panic aborts wherever it
 * happens, so the WebAssembly memory can't be used again. Each callback is told once, after the
 * call that panicked has returned.
 */
export function stop(message: string): void {
  if (halted) return;
  halted = thrown({
    code: 'stopped',
    message: `latkit stopped after an internal error. Reload the page to start over. ${message}`,
  });
  const error = halted;
  queueMicrotask(() => {
    for (const tell of told) tell(error);
    told.clear();
  });
}

/** @internal Whether an internal error stopped latkit. */
export function stopped(): boolean {
  return halted !== undefined;
}

/** @internal Calls `tell` with the error if latkit stops. Returns a function that stops listening. */
export function onStop(tell: (error: LatkitError) => void): () => void {
  told.add(tell);
  return () => told.delete(tell);
}

/**
 * @internal Returns the bindings. Throws an `unloaded` error until `load()` has finished, and a
 * `stopped` error once latkit has stopped.
 */
export function wasm(): typeof bindings {
  if (halted) throw halted;
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

/** Each handle's bindings object, until the handle is destroyed, and the name its errors use. */
const held = new WeakMap<Handle, { bound?: { free(): void }; what: string }>();

/**
 * An object that holds WebAssembly memory (and GPU memory, for a `Gpu`) until it is destroyed.
 * `destroy()` frees it, as does the end of a `using` block. After that, its other methods throw a
 * `destroyed` error.
 */
export abstract class Handle {
  /** @internal Holds `bound`, the bindings object to free. Errors call the object `what`. */
  constructor(bound: { free(): void }, what: string) {
    held.set(this, { bound, what });
  }

  /**
   * Frees the object's memory. Calling it again does nothing. Once latkit has stopped, it only
   * drops the object, since its memory can't be used again.
   */
  destroy(): void {
    const entry = held.get(this);
    const bound = entry?.bound;
    if (!bound) return;
    entry.bound = undefined;
    try {
      this.freeing();
      if (!halted) bound.free();
    } catch (error) {
      if (!halted) throw error;
    }
  }

  /** @internal Runs once when the object is destroyed, before its memory is freed. */
  protected freeing(): void {}

  /** Calls `destroy()`, so a `using` declaration destroys the object when its block ends. */
  [Symbol.dispose](): void {
    this.destroy();
  }
}

/**
 * @internal Returns `owner`'s bindings object. Throws a `destroyed` error once it is destroyed, and
 * a `stopped` error once latkit has stopped.
 */
export function inner<T>(owner: Handle): T {
  const entry = held.get(owner)!;
  if (!entry.bound)
    throw thrown({ code: 'destroyed', message: `this ${entry.what} has been destroyed` });
  if (halted) throw halted;
  return entry.bound as T;
}

/** A byte stream: anything shaped like a browser or Node.js `ReadableStream` of `Uint8Array`. */
export interface ReadableBytes {
  /** Returns a reader of the stream's chunks. latkit reads it to the end or cancels it. */
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

/**
 * Bytes to read: an array or buffer, a `Blob`, a `Response`, a byte stream, or a URL string to
 * fetch. Reading is bounded by the call's {@link Wait}. It fails with an `io` error when a fetch
 * fails or returns an error status, or when the bytes can't be read.
 */
export type ByteSource =
  Uint8Array | ArrayBuffer | Blob | Response | ReadableBytes | AsyncIterable<Uint8Array> | string;

/**
 * @internal Reads `source` into bytes, with the URL they came from as `base` (empty if none). An
 * object that is not a {@link ByteSource} is encoded as JSON text. Waits within `wait`, and
 * cancels a fetch or stream it gives up on.
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
 * @internal Yields the chunks of `stream` until it ends or `signal` aborts. Reads through
 * `getReader()` when the stream has one, else by async iteration. Stopping early cancels the
 * stream with the abort reason. A failed read throws an `io` error.
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
 * @internal Awaits `pending`, a promise or a bindings task, until `signal` aborts. The signal
 * defaults to a 30-second timeout. If the signal aborts first, a task is cancelled so its work is
 * skipped, and the call rejects with an error naming `what`: `timeout` for a timeout, else
 * `cancelled`. Work that fails after the signal aborted, such as a fetch given the same signal,
 * rejects the same way. A task is always freed.
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
