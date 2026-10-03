import type {
  Arguments,
  CommandDescription,
  CommandResult,
  LogEntry,
  Parameters,
  Progress,
} from './commands.js';
import type { DataBatch } from './materialized.js';
import type { FieldSelection } from './query.js';
import type { Schema } from './schema.js';

/** Batches published together. A group within a connection's message bounds arrives as one atomic
 *  message; a larger one arrives as several, in order, cutting sample batches only between frames. */
export type Publication = readonly DataBatch[];

/**
 * A model: its types, a way to read its fields, and the commands it runs. `@latkit/connect` carries
 * one across a socket in either direction; using one needs no socket.
 */
export interface Model<C extends Record<string, Parameters> = Record<string, Parameters>> {
  readonly name: string;
  readonly schema: Schema;
  /** Read `fields`, once or live. Absent when the model offers no reading. */
  readonly monitor?: (
    fields: readonly FieldSelection[],
    context: MonitorContext,
  ) => Iterable<DataBatch | Publication> | AsyncIterable<DataBatch | Publication>;
  readonly commands?: { readonly [K in keyof C]: Command<C[K]> };
}

/** A command a model runs: its description, and the run itself. */
export interface Command<P extends Parameters = Parameters> extends CommandDescription<P> {
  run(
    values: Arguments<P>,
    context: CommandContext,
  ): CommandResult | void | Promise<CommandResult | void>;
}

export interface MonitorContext {
  readonly signal: AbortSignal;
  /** The batch size to publish in, which a connection sets from its message bounds. Larger sample
   *  batches are cut between frames; a row batch must fit one message. */
  readonly maxBlockBytes: number;
}

/** Where a run reports, the same on both sides of a connection: the model publishes into it, and
 *  whoever runs the command supplies it. */
export interface CommandContext extends MonitorContext {
  readonly outputs: readonly FieldSelection[];
  /** Resolves once the publication may be reused and the next may follow; await it before
   *  publishing again. */
  readonly publish: (publication: DataBatch | Publication) => Promise<void>;
  /** Synchronous; coalesced on the way. */
  readonly progress: (value: Progress) => void;
  /** Synchronous; bounded on the way, with losses reported as `dropped`. */
  readonly log: (value: LogEntry) => void;
}
