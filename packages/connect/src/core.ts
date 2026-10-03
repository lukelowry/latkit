import { failure, isFailure, type Failure, type FailureCode } from '@latkit/model';
import type { ConnectLimits } from './types.js';
/** Every Failure code, so a peer's report keeps the codes latkit knows. */
const CODES: Readonly<Record<FailureCode, true>> = {
  'invalid-input': true,
  'resource-limit': true,
  conflict: true,
  unsupported: true,
  busy: true,
  aborted: true,
  closed: true,
  unavailable: true,
  'device-lost': true,
  precision: true,
  disconnected: true,
  protocol: true,
  timeout: true,
  io: true,
  internal: true,
};
/**
 * Read what a peer sent. Data that fails a check is the peer breaking the protocol, not invalid
 * input from whoever reads it.
 */
export function fromPeer<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (isFailure(error, 'invalid-input'))
      throw failure('protocol', error.message, { cause: error });
    throw error;
  }
}
/** A failure a peer reported: its own code when latkit knows it, otherwise `internal` naming it. */
export function peerFailure(metadata: Readonly<Record<string, unknown>>): Failure {
  return fromPeer(() => {
    const code = text(metadata.code, 128),
      message = text(metadata.message, 4096);
    return Object.hasOwn(CODES, code)
      ? failure(code as FailureCode, message)
      : failure('internal', code + ': ' + message);
  });
}
export function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
/** The code and message an error crosses a connection with, within `messageLength` characters. */
export function reasonOf(value: unknown, messageLength = 2048): { code: string; message: string } {
  const error = errorOf(value);
  return {
    code: 'code' in error && typeof error.code === 'string' ? error.code.slice(0, 64) : 'internal',
    message: error.message.slice(0, messageLength) || 'Operation failed.',
  };
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
/** What both ends require of progress: a count, a total at least as large, and a coordinate domain. */
export function validProgress(value: Readonly<Record<string, unknown>>): boolean {
  const { completed, total, domain } = value;
  return (
    typeof completed === 'number' &&
    Number.isFinite(completed) &&
    completed >= 0 &&
    (total === undefined ||
      (typeof total === 'number' && Number.isFinite(total) && total >= completed)) &&
    (domain === undefined ||
      (Array.isArray(domain) &&
        domain.length === 2 &&
        domain.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
        domain[0] <= domain[1]))
  );
}
export const defaults: ConnectLimits = Object.freeze({
  messageBytes: 1024 * 1024,
  metadataBytes: 64 * 1024,
  bufferedBytes: 16 * 1024 * 1024,
  bufferedMessages: 1024,
  streamWindowBytes: 4 * 1024 * 1024,
  streamWindowMessages: 256,
  streams: 32,
  publicationBatches: 64,
  logs: 32,
  timeoutMs: 30000,
});
export function limits(input: Partial<ConnectLimits> = {}): ConnectLimits {
  for (const key of Object.keys(input))
    if (!Object.hasOwn(defaults, key)) throw failure('invalid-input', 'Unknown limit: ' + key);
  const result = { ...defaults, ...input };
  for (const [key, value] of Object.entries(result))
    integer(value, 1, key === 'timeoutMs' ? 0x7fffffff : 0xffffffff);
  if (
    result.metadataBytes < 1024 ||
    result.metadataBytes + 1024 > result.messageBytes ||
    result.messageBytes > result.streamWindowBytes ||
    result.streamWindowBytes > result.bufferedBytes ||
    result.streamWindowMessages > result.bufferedMessages
  )
    throw failure(
      'invalid-input',
      'Metadata, message, stream and connection bounds are inconsistent.',
    );
  return Object.freeze(result);
}
export function negotiate(local: ConnectLimits, remote: unknown): ConnectLimits {
  return fromPeer(() => {
    const offered = record(remote),
      result = { ...local };
    for (const key of Object.keys(defaults) as (keyof ConnectLimits)[])
      result[key] = Math.min(
        local[key],
        integer(offered[key], 1, key === 'timeoutMs' ? 0x7fffffff : 0xffffffff),
      );
    return limits(result);
  });
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
