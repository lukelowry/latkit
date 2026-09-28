/**
 * A run: what any engine emits while it executes a command against one model. One run fills one
 * recording, so its frames name only their classes; a plan of several studies is several runs.
 */

import type { Recording } from './recording.js';

/**
 * One block of a run's frames: their times, and every recorded class's values over them,
 * frame-major: `values[classId][(frame * signals + signal) * elements + element]`, signals in the
 * order the recording lists them. A class the block leaves out reads NaN over it. Published
 * buffers are immutable and stay valid after the next block arrives.
 */
export interface RunFrames {
  readonly time: Float64Array;
  readonly values: Readonly<Record<string, Float32Array | Float64Array>>;
}

/** One item off a run stream: where the run stands, its frames and lines, and its one end. */
export type RunUpdate =
  | { readonly type: 'queued'; readonly ahead: number }
  | { readonly type: 'running' }
  | ({ readonly type: 'frames' } & RunFrames)
  | { readonly type: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  | { readonly type: 'done' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'failed'; readonly message: string };

/** A run of a model: the recording it fills, and its updates as it goes. */
export interface Run extends AsyncIterable<RunUpdate> {
  /** Every class that records a signal: appended as frames arrive, sealed when the run ends. */
  readonly recording: Recording;
}

/** Whether `update` ends its run. */
export function ends(update: RunUpdate): boolean {
  return update.type === 'done' || update.type === 'cancelled' || update.type === 'failed';
}
