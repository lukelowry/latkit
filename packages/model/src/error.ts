import type { Failure } from './types.js';

/** A Failure: a code and message that survive transport, with an optional target and issues. */
export function failure(
  code: Failure['code'],
  message: string = code,
  details: Pick<Failure, 'target' | 'issues'> = {},
): Failure {
  return Object.assign(new Error(message), { code, ...details });
}

export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw failure('aborted', 'Operation was aborted.');
}
