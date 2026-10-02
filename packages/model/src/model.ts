import type { DataEvent } from './materialized.js';
import type { FieldSelection } from './query.js';
import type { Command, CommandResult, Routine } from './routine.js';
import type { Schema } from './schema.js';
import type { RequestOptions } from './types.js';

export interface MonitorOptions extends RequestOptions {
  /** Maximum delivered payload. Defaults to the schema limit. */
  readonly maxBlockBytes?: number;
}

/** A passive live producer. Commands and application storage are separate capabilities. */
export interface Model {
  readonly name: string;
  readonly schema: Schema;
  /**
   * Subscribe at invocation. Deliver complete begin/data/end transactions, once, in order.
   * The first transaction may describe current state; there is no historical replay or cursor.
   * Published buffers are immutable and remain valid after unsubscribe or disconnect.
   * Return/throw/abort unsubscribes, including a pending next(). Fail a slow consumer with
   * resource-limit before its bounded delivery queue overflows; never silently drop data.
   * Starting, completing or cancelling a command has no effect on this subscription.
   */
  monitor(fields: readonly FieldSelection[], options?: MonitorOptions): AsyncIterable<DataEvent>;
}

/** Optional control capability. Running a routine does not start or reset monitoring. */
export interface Commands {
  readonly routines: readonly Routine[];
  run(command: Command, options?: RequestOptions): Promise<CommandResult>;
}
