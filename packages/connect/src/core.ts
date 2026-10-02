import type { Limits } from './types.js';
export function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
export function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure('invalid-input', 'Expected an object.');
  return value as Record<string, unknown>;
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw failure('invalid-input', 'Expected a bounded integer.');
  return value;
}
export function text(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || !value.length || value.length > max)
    throw failure('invalid-input', 'Expected bounded nonempty text.');
  return value;
}
export const defaults: Limits = Object.freeze({
  maxMessageBytes: 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxBufferedMessages: 1024,
  streamWindowBytes: 4 * 1024 * 1024,
  streamWindowMessages: 256,
  maxStreams: 32,
  maxPublicationBatches: 64,
  maxLogs: 32,
  timeoutMs: 30000,
});
export function limits(input: Partial<Limits> = {}): Limits {
  for (const key of Object.keys(input))
    if (!Object.hasOwn(defaults, key)) throw failure('invalid-input', 'Unknown limit: ' + key);
  const result = { ...defaults, ...input };
  for (const [key, value] of Object.entries(result))
    integer(value, 1, key === 'timeoutMs' ? 0x7fffffff : 0xffffffff);
  if (
    result.maxMetadataBytes < 1024 ||
    result.maxMetadataBytes + 1024 > result.maxMessageBytes ||
    result.maxMessageBytes > result.streamWindowBytes ||
    result.streamWindowBytes > result.maxBufferedBytes ||
    result.streamWindowMessages > result.maxBufferedMessages
  )
    throw failure(
      'invalid-input',
      'Metadata, message, stream and connection bounds are inconsistent.',
    );
  return Object.freeze(result);
}
export function negotiate(local: Limits, remote: unknown): Limits {
  const offered = record(remote),
    result = { ...local };
  for (const key of Object.keys(defaults) as (keyof Limits)[])
    result[key] = Math.min(
      local[key],
      integer(offered[key], 1, key === 'timeoutMs' ? 0x7fffffff : 0xffffffff),
    );
  return limits(result);
}
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
/** Stop waiting without pretending that arbitrary application code can be forcibly stopped. */
export function interrupt<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(errorOf(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      clearTimeout(timer);
    };
    const abort = () => {
      cleanup();
      reject(errorOf(signal.reason));
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            cleanup();
            reject(failure('timeout', 'The operation exceeded its deadline.'));
          }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(errorOf(error));
      },
    );
  });
}
