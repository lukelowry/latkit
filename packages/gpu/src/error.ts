/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- Preserve native AbortSignal reasons. */
import { failure } from '@latkit/model';

export function integer(
  value: number,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw failure('invalid-input', `${label} must be an integer in [${minimum}, ${maximum}]`);
  return value;
}

export function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** Observe both outcomes even when cancellation wins. */
export function interruptible<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
