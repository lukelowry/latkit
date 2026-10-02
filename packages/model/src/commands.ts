import type { Domain } from './types.js';
/** Portable command descriptions and values, shared by producers and consumers. */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Common = {
  readonly label?: string;
  readonly description?: string;
  readonly optional?: boolean;
  readonly unit?: string;
};
type Defaults<T> =
  | { readonly multiple?: false; readonly default?: T }
  | { readonly multiple: true; readonly default?: readonly T[] };
export type Parameter = Common &
  (
    | ({
        readonly type: 'number';
        readonly min?: number;
        readonly max?: number;
        readonly integer?: boolean;
      } & Defaults<number>)
    | ({ readonly type: 'text' } & Defaults<string>)
    | ({ readonly type: 'boolean' } & Defaults<boolean>)
    | ({ readonly type: 'choice'; readonly choices: readonly string[] } & Defaults<string>)
    | ({ readonly type: 'reference'; readonly to: string } & Defaults<string>)
    | { readonly type: 'file'; readonly accept?: readonly string[]; readonly multiple?: boolean }
  );
export type Parameters = Readonly<Record<string, Parameter>>;
type Scalar<P extends Parameter> = {
  number: number;
  boolean: boolean;
  file: File;
  text: string;
  reference: string;
  choice: NonNullable<(P & { choices?: readonly string[] })['choices']>[number];
}[P['type']];
type Multiple<M, V> = M extends true ? readonly V[] : V;
type Optional<O, V> = O extends true ? V | undefined : V;
type Value<P extends Parameter> = Multiple<P['multiple'], Scalar<P>>;
export type Arguments<P extends Parameters> = {
  readonly [K in keyof P]: undefined extends (P[K] & { default?: unknown })['default']
    ? Optional<P[K]['optional'], Value<P[K]>>
    : Value<P[K]>;
};
export interface CommandDescription<P extends Parameters = Parameters> {
  readonly label?: string;
  readonly description?: string;
  readonly parameters: P;
}
export type InputValue = Json | File | readonly File[];
export type CommandResult = Json;
export interface Progress {
  readonly completed: number;
  readonly total?: number;
  readonly message?: string;
  /** The coordinates the run covers, once the model knows them, such as its time span. */
  readonly domain?: Domain;
}
export interface Diagnostic {
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly code?: string;
}
/** Log batches report loss explicitly; diagnostics never grow an unbounded queue. */
export interface LogEntry extends Diagnostic {
  readonly dropped?: number;
}
