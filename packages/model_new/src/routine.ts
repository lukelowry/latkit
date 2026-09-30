import type { Bounds, Failure, Problem, Scalar, Value, Version } from './types.js';
import type { Input, InputMetadata } from './input.js';

export interface Routine {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /**
   * Isolated: accepted inputs are pinned, outputs belong only to this command, and edits/reload do
   * not invalidate work. Live: operates on current state; external input changes cancel it. Neither
   * mode promises parallel execution. Implementations order conflicting work; no implicit clones.
   */
  readonly mode: 'isolated' | 'live';
  /** Supported output routes. Omitted/empty means no monitorable output. Isolated routines may
   * advertise only command; live routines may advertise live, command, or both when correlated. */
  readonly monitoring?: readonly ('live' | 'command')[];
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
      | { readonly type: 'element'; readonly table: string }
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

export type InputValue = Value | Input | readonly Input[];
export interface Command {
  readonly routine: string;
  readonly values: Readonly<Record<string, InputValue>>;
}

/** Results are portable values. Large output belongs in Queryable, not command return values. */
export type CommandResult = Readonly<Record<string, Value>>;

export type CommandEntry = {
  readonly id: string;
  readonly routine: string;
  readonly values: Readonly<Record<string, Value | InputMetadata | readonly InputMetadata[]>>;
  readonly documentVersion: Version;
  readonly firstFrame: number;
  /** Exclusive. May equal firstFrame if no samples were observed. */
  readonly endFrame: number;
} & (
  | { readonly status: 'queued' | 'running' | 'cancelled' }
  | { readonly status: 'complete'; readonly result: CommandResult }
  | { readonly status: 'failed'; readonly error: Failure }
);

export type CommandEvent = { readonly id: string; readonly documentVersion: Version } & (
  | { readonly kind: 'queued' | 'running' | 'cancelled' }
  | {
      readonly kind: 'progress';
      readonly completed: number;
      readonly total?: number;
      readonly message?: string;
    }
  | { readonly kind: 'complete'; readonly result: CommandResult }
  | { readonly kind: 'failed'; readonly error: Failure }
);

export interface Diagnostic extends Problem {
  /** Monotone model-wide sequence, including diagnostics not retained by a recording. */
  readonly sequence: number;
  readonly severity: 'info' | 'warning' | 'error';
  readonly command?: string;
}
