import type { Failure, FailureCode } from './types.js';

/** A Failure: a code and message that survive transport, with an optional target, issues, and cause. */
export function failure(
  code: FailureCode,
  message: string = code,
  details: Pick<Failure, 'target' | 'issues' | 'cause'> = {},
): Failure {
  const { cause, ...rest } = details;
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code,
    ...rest,
  });
}

/** Whether an error is a Failure, of `code` when given, from any latkit package or a peer. */
export function isFailure(error: unknown, code?: FailureCode): error is Failure {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (code === undefined || (error as Failure).code === code)
  );
}
