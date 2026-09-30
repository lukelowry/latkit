import type { MonitorConfig, Recording } from './recording.js';
import type { Command, CommandEvent, CommandResult, Diagnostic, Routine } from './routine.js';
import type { Input } from './input.js';
import type { Problem, RequestOptions } from './types.js';

export interface CallOptions extends RequestOptions {
  /** Unique for this model's lifetime; generated if omitted. Rejected calls also consume it.
   * Reuse rejects conflict, never retries. */
  readonly id?: string;
}

/** One compute context attached to shared inputs. Suitable for isolated work or a live peer.
 * Storage and transport are optional. Implementations schedule/exclusively bind external peers. */
export interface Model {
  readonly id: string;
  readonly label: string;
  readonly documentId: string;
  /** Nonempty requires call. Publish replacements before the routines notification. */
  readonly routines: readonly Routine[];
  parse?(input: Input, options?: RequestOptions): Promise<Command>;
  /** Preflight metadata/current-input constraints without consuming content streams. */
  validate?(command: Command, options?: RequestOptions): Promise<readonly Problem[]>;
  /**
   * Validate independently, accept against current inputs, bind armed monitors, then emit queued.
   * Isolated inputs are pinned at acceptance, not when a monitor is armed or work starts running.
   * A binding failure fails that recording without rejecting an otherwise valid command.
   * Rejected calls fail matching armed monitors. Resolve on completion; abort requests cancellation,
   * not rollback. Terminal events follow final output publication. Never retry side effects after
   * a lost transport reply. Implementations may share immutable input backing between commands.
   */
  call?(command: Command, options?: CallOptions): Promise<CommandResult>;
  /**
   * Resolve once armed. Command scope registers interest without pinning inputs; live scope binds
   * now. Command IDs must not have been submitted previously; late registration rejects conflict.
   * Cancelled/rejected setup leaves no active capture. After resolution, use stop/close.
   * Binding checks routine monitoring support and current schema/row coverage independently of call.
   * Admission may reject resource-limit for shared input/native working-memory budgets.
   */
  monitor?(config: MonitorConfig, options?: RequestOptions): Promise<Recording>;
  /** Cancel this context's commands and close its recordings. Reinitialize computation against
   * current inputs; never edit or replace the shared Document. New work rejects busy until ready. */
  reset(): Promise<void>;
  on(event: 'routines' | 'reset', listener: () => void): () => void;
  on(event: 'command', listener: (event: CommandEvent) => void): () => void;
  on(event: 'diagnostic', listener: (diagnostic: Diagnostic) => void): () => void;
  /** Cancel work and release this context and its document retention. Later operations reject closed. Idempotent. */
  close(): Promise<void>;
}
