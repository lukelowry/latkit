/** Opaque source-scoped token; compare only for equality. Never reused within its source. */
export type Version = string;

/** Meaning of observation coordinates; never an implicitly chosen wall clock. */
export interface Axis {
  readonly name: string;
  readonly unit?: string;
}

/** Finite, ordered inclusive coordinates. */
export type Domain = readonly [minimum: number, maximum: number];
export type Scalar = number | string | boolean | null;
/** Domain values, including vectors and lists. Numbers must be finite. Null denotes absence. */
export type Value = Scalar | readonly Value[];

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface Bound {
  readonly value: number;
  /** Defaults to true. */
  readonly inclusive?: boolean;
}

export interface Bounds {
  readonly lower?: Bound;
  readonly upper?: Bound;
}

export type ProblemTarget =
  | { readonly kind: 'row'; readonly type: string; readonly id: string }
  | { readonly kind: 'field'; readonly type: string; readonly id: string; readonly field: string }
  | { readonly kind: 'parameter'; readonly id: string }
  | { readonly kind: 'path'; readonly path: readonly (string | number)[] };

export interface Problem {
  readonly code: string;
  readonly message: string;
  readonly target?: ProblemTarget;
  readonly edit?: number;
}

/** Codes and public details survive transport; prototypes and stacks need not. */
export interface Failure extends Error {
  readonly code:
    | 'conflict'
    | 'invalid-input'
    | 'unsupported'
    | 'resource-limit'
    | 'busy'
    | 'aborted'
    | 'closed'
    | 'disconnected'
    | 'protocol'
    | 'timeout'
    | 'io'
    | 'internal';
  readonly target?: ProblemTarget;
  readonly issues?: readonly Problem[];
}
