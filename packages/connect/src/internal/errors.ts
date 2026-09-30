import type { Failure } from '@latkit/model-new';
const codes = new Set<Failure['code']>([
  'conflict',
  'expired',
  'invalid-input',
  'unsupported',
  'resource-limit',
  'busy',
  'aborted',
  'closed',
  'disconnected',
  'io',
  'internal',
]);
export function failure(code: Failure['code'], message: string = code): Failure {
  return Object.assign(new Error(message), { code });
}
export function errorValue(value: unknown): Failure {
  if (value instanceof Error) {
    const code =
      'code' in value && codes.has(value.code as Failure['code'])
        ? (value.code as Failure['code'])
        : 'internal';
    return Object.assign(
      new Error(value.message),
      { code },
      'target' in value ? { target: value.target } : {},
      'issues' in value ? { issues: value.issues } : {},
    ) as Failure;
  }
  return failure('internal', typeof value === 'string' ? value : 'Operation failed.');
}
export function encodeError(value: unknown): Record<string, unknown> {
  const error = errorValue(value);
  return {
    code: error.code,
    message: error.message,
    ...(error.target ? { target: error.target } : {}),
    ...(error.issues ? { issues: error.issues } : {}),
  };
}
export function decodeError(value: unknown): Failure {
  if (!value || typeof value !== 'object')
    return failure('disconnected', 'Invalid remote failure.');
  const v = value as Record<string, unknown>;
  if (typeof v.message !== 'string' || !codes.has(v.code as Failure['code']))
    return failure('disconnected', 'Invalid remote failure.');
  return Object.assign(new Error(v.message), {
    code: v.code as Failure['code'],
    ...(v.target === undefined ? {} : { target: v.target }),
    ...(v.issues === undefined ? {} : { issues: v.issues }),
  }) as Failure;
}
export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw failure('aborted');
}
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
export function interrupt<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(failure('aborted'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(failure('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(errorValue(error));
      },
    );
  });
}
