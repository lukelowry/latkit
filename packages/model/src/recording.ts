import type { Queryable } from './query.js';
import type { Diagnostic } from './routine.js';
import type { Domain, Export, RequestOptions } from './types.js';

export type RecordingStatus = 'idle' | 'running' | 'complete' | 'cancelled' | 'failed';

/**
 * A monitor: its fields' frames for the latest command run on its model since it opened. Idle until
 * one starts. Frames append as they are computed and are never evicted: [0, frames) stays readable
 * until the next command starts it over or it closes. Its status, progress and diagnostics are that
 * command's. Its schema's axis names the coordinate. Emits replace when a command starts it over,
 * append for new frames and status for the rest.
 */
export interface Recording extends Queryable {
  readonly status: RecordingStatus;
  /** Frames recorded so far. */
  readonly frames: number;
  /** The first and last recorded coordinates; null before the first frame. */
  readonly range: Domain | null;
  /** Fraction done, 0 to 1; null when unknown. */
  readonly progress: number | null;
  /** What the command reported, oldest first. Implementations cap it and say so last. */
  readonly diagnostics: readonly Diagnostic[];
  /** These frames, their coordinates and the command, as one Arrow IPC stream. */
  export(options?: RequestOptions): Promise<Export>;
}
