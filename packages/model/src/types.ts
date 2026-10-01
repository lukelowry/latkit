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
  | { readonly kind: 'element'; readonly id: string }
  | { readonly kind: 'field'; readonly element: string; readonly field: string }
  | { readonly kind: 'port'; readonly element: string; readonly port: string }
  | { readonly kind: 'parameter'; readonly id: string }
  | { readonly kind: 'path'; readonly path: readonly (string | number)[] };

export interface Problem {
  readonly code: string;
  readonly message: string;
  readonly target?: ProblemTarget;
  readonly edit?: number;
}

/** Export pins exactly one version until consumed or cancelled by its caller. */
export interface Export {
  readonly version: Version;
  readonly mediaType: string;
  readonly stream: ReadableStream<Uint8Array>;
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
    | 'io'
    | 'internal';
  readonly target?: ProblemTarget;
  readonly issues?: readonly Problem[];
}
