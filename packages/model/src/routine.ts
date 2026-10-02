import type { Bounds, Problem, Scalar, Value } from './types.js';

/** A command a Model can run. */
export interface Routine {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly parameters: readonly Parameter[];
}

export type Parameter = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly optional?: boolean;
  readonly when?: Readonly<Record<string, Scalar>>;
} & (
  | ({
      readonly type: 'number';
      readonly unit?: string;
      readonly integer?: boolean;
      readonly bounds?: Bounds;
    } & (
      | { readonly multiple?: false; readonly default?: number }
      | { readonly multiple: true; readonly default?: readonly number[] }
    ))
  | ((
      | { readonly type: 'text' }
      | {
          readonly type: 'choice';
          readonly choices: readonly { readonly id: string; readonly label: string }[];
        }
      /** The id of a row of type `to`. */
      | { readonly type: 'reference'; readonly to: string }
    ) &
      (
        | { readonly multiple?: false; readonly default?: string }
        | { readonly multiple: true; readonly default?: readonly string[] }
      ))
  | ({ readonly type: 'boolean' } & (
      | { readonly multiple?: false; readonly default?: boolean }
      | { readonly multiple: true; readonly default?: readonly boolean[] }
    ))
  | { readonly type: 'file'; readonly extensions?: readonly string[]; readonly multiple?: boolean }
);

/** A file parameter's value: its bytes, consumed once. */
export interface Input {
  readonly name?: string;
  readonly mediaType?: string;
  /** Immutable chunks. Cancel on failure. Transports must not detach unowned backing. */
  readonly stream: ReadableStream<Uint8Array>;
}

export type InputValue = Value | Input | readonly Input[];
export interface Command {
  readonly routine: string;
  readonly values: Readonly<Record<string, InputValue>>;
}

/** Results are portable values. Frames belong in monitors, not command return values. */
export type CommandResult = Readonly<Record<string, Value>>;

export interface Diagnostic extends Problem {
  readonly severity: 'info' | 'warning' | 'error';
}
