/** Codes and public details survive transport; prototypes and stacks need not. */
export interface Failure extends Error {
  readonly code: Failure.Code;
  readonly target?: Failure.Target;
  readonly issues?: readonly Failure.Problem[];
}
export declare namespace Failure {
  /** Why an operation failed, the same in every latkit package and across a connection. */
  type Code =
    | 'invalid-input'
    | 'resource-limit'
    | 'conflict'
    | 'unsupported'
    | 'busy'
    | 'aborted'
    | 'closed'
    | 'unavailable'
    | 'device-lost'
    | 'precision'
    | 'disconnected'
    | 'protocol'
    | 'timeout'
    | 'io'
    | 'internal';
  /** What a failure or a problem is about: a row, a field of one, a parameter, or a path in a value. */
  type Target =
    | { readonly kind: 'row'; readonly type: string; readonly id: string }
    | { readonly kind: 'field'; readonly type: string; readonly id: string; readonly field: string }
    | { readonly kind: 'parameter'; readonly id: string }
    | { readonly kind: 'path'; readonly path: readonly (string | number)[] };
  /** One reason a value is invalid, as validation reports it. */
  interface Problem {
    readonly code: string;
    readonly message: string;
    readonly target?: Target;
  }
}

/** A Failure: a code and message that survive transport, with an optional target, issues, and cause. */
export function failure(
  code: Failure.Code,
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
export function isFailure(error: unknown, code?: Failure.Code): error is Failure {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (code === undefined || (error as Failure).code === code)
  );
}
