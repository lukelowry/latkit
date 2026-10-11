import type { Domain } from '../data/column.js';
import type { Data } from '../data/data.js';
import type { Query } from '../query/query.js';
import type { Schema } from '../schema/schema.js';

/**
 * A model: its types, a way to read its fields, and the commands it runs. `@latkit/connect` carries
 * one across a socket in either direction; using one needs no socket.
 */
export interface Model<
  C extends Record<string, Command.Parameters> = Record<string, Command.Parameters>,
> {
  readonly name: string;
  readonly schema: Schema;
  /** Read `fields`, once or live. Absent when the model offers no reading. */
  readonly monitor?: (
    fields: readonly Query.Selection[],
    context: Model.MonitorContext,
  ) => Iterable<Data.Batch | Model.Publication> | AsyncIterable<Data.Batch | Model.Publication>;
  readonly commands?: { readonly [K in keyof C]: Command<C[K]> };
}
export declare namespace Model {
  /**
   * Batches published together. A group within a connection's message bounds arrives as one atomic
   * message; a larger one arrives as several, in order, cutting sample batches only between frames.
   */
  type Publication = readonly Data.Batch[];
  interface MonitorContext {
    readonly signal: AbortSignal;
    /**
     * The batch size to publish in, which a connection sets from its message bounds. Larger sample
     * batches are cut between frames; a row batch must fit one message.
     */
    readonly maxBlockBytes: number;
  }
}

/** A command a model runs: its description, and the run itself. */
export interface Command<
  P extends Command.Parameters = Command.Parameters,
> extends Command.Description<P> {
  run(
    values: Command.Arguments<P>,
    context: Command.Context,
  ): Command.Result | void | Promise<Command.Result | void>;
}
type Common = {
  readonly label?: string;
  readonly description?: string;
  readonly optional?: boolean;
  readonly unit?: string;
};
type Defaults<T> =
  | { readonly multiple?: false; readonly default?: T }
  | { readonly multiple: true; readonly default?: readonly T[] };
type ScalarOf<P extends Command.Parameter> = {
  number: number;
  boolean: boolean;
  file: File;
  text: string;
  reference: string;
  choice: NonNullable<(P & { choices?: readonly string[] })['choices']>[number];
}[P['type']];
type Multiple<M, V> = M extends true ? readonly V[] : V;
type Optional<O, V> = O extends true ? V | undefined : V;
type ValueOf<P extends Command.Parameter> = Multiple<P['multiple'], ScalarOf<P>>;
/** Portable command descriptions and values, shared by producers and consumers. */
export declare namespace Command {
  type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
  type Parameter = Common &
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
  type Parameters = Readonly<Record<string, Parameter>>;
  /** The values a run receives for its parameters. */
  type Arguments<P extends Parameters> = {
    readonly [K in keyof P]: undefined extends (P[K] & { default?: unknown })['default']
      ? Optional<P[K]['optional'], ValueOf<P[K]>>
      : ValueOf<P[K]>;
  };
  interface Description<P extends Parameters = Parameters> {
    readonly label?: string;
    readonly description?: string;
    readonly parameters: P;
  }
  /** A value a caller supplies for a parameter, before it is checked. */
  type Input = Json | File | readonly File[];
  type Result = Json;
  interface Progress {
    readonly completed: number;
    readonly total?: number;
    readonly message?: string;
    /** The coordinates the run covers, once the model knows them, such as its time span. */
    readonly domain?: Domain;
  }
  interface Diagnostic {
    readonly severity: 'info' | 'warning' | 'error';
    readonly message: string;
    readonly code?: string;
  }
  /** Log batches report loss explicitly; diagnostics never grow an unbounded queue. */
  interface LogEntry extends Diagnostic {
    readonly dropped?: number;
  }
  /**
   * Where a run reports, the same on both sides of a connection: the model publishes into it, and
   * whoever runs the command supplies it.
   */
  interface Context extends Model.MonitorContext {
    readonly outputs: readonly Query.Selection[];
    /**
     * Resolves once the publication may be reused and the next may follow; await it before
     * publishing again.
     */
    readonly publish: (publication: Data.Batch | Model.Publication) => Promise<void>;
    /** Synchronous; coalesced on the way. */
    readonly progress: (value: Progress) => void;
    /** Synchronous; bounded on the way, with losses reported as `dropped`. */
    readonly log: (value: LogEntry) => void;
  }
}
