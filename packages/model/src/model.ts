import type { FieldSelection, Queryable } from './query.js';
import type { Recording } from './recording.js';
import type { Command, CommandResult, Routine } from './routine.js';
import type { Schema } from './schema.js';
import type { RequestOptions } from './types.js';

/**
 * A grid model: its types and data, the commands it runs, and monitors on what they compute.
 * The same object in-process, in a worker, or across a connection. Opening it, and changing its
 * file, belong to its application. Every holder shares it: each monitor streams every command,
 * whoever ran it. Closing ends only this holder's use.
 */
export interface Model extends Queryable {
  readonly name: string;
  /** What run() accepts; fixed for the model's lifetime. Empty when it computes nothing. */
  readonly routines: readonly Routine[];
  /** Its types and their fields, references included. Sampled fields are what monitor() can
   * stream; the model holds no observations of them. */
  describe(options?: RequestOptions): Promise<Schema>;
  /**
   * Stream these sampled fields of every command that starts after this call. Each command that
   * records starts the Recording over: it emits replace, then appends that command's frames as
   * they are computed. retain() keeps one command's frames past the next. Rejects invalid-input
   * for unknown rows or fields that are not sampled.
   */
  monitor(fields: readonly FieldSelection[], options?: RequestOptions): Promise<Recording>;
  /**
   * Run a command; every open monitor streams it. Commands run one at a time, in the order given.
   * Rejects invalid-input, with issues, before anything runs. Resolves with the result once every
   * frame is published. Aborting cancels it, queued or running. A lost reply may have run.
   */
  run(command: Command, options?: RequestOptions): Promise<CommandResult>;
}
