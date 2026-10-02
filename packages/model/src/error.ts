import type { Failure } from './types.js';

export function failure(code: Failure['code'], message: string = code): Failure {
  return Object.assign(new Error(message), { code });
}

export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw failure('aborted', 'Operation was aborted.');
}
