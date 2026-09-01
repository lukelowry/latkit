/**
 * The shape of a run: what any engine, local or remote, emits while it executes a model, and how
 * its frames fold into a `Series`.
 *
 * @remarks
 * The model package defines only this output contract. A command is vendor bytes; a `Runner` is
 * something a host holds when it has an engine, never a method on a model.
 */

import { packSeries, type Series } from './series.js';

/** Executes vendor-encoded commands against one model. */
export interface Runner {
  /**
   * Start a run. The stream ends with exactly one terminal update (`done`, `cancelled`, or
   * `failed`) and throws only when the runner itself breaks.
   */
  run(command: Uint8Array, signal?: AbortSignal): AsyncIterable<RunUpdate>;
}

/**
 * One batch of recorded samples for one class.
 *
 * @remarks
 * Frame-major: `values[frame * signalCount * elementCount + signal * elementCount + element]`.
 * Signals appear in the class's recorded order; batches for one class arrive in time order.
 */
export interface RunFrames {
  readonly classId: string;
  readonly elementCount: number;
  readonly signalCount: number;
  readonly time: Float64Array;
  readonly values: Float32Array;
}

/** One item off a run stream. */
export type RunUpdate =
  | { readonly type: 'started'; readonly id: string }
  | ({ readonly type: 'frames' } & RunFrames)
  | { readonly type: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  | { readonly type: 'done' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'failed'; readonly message: string };

/**
 * Fold one class's batches, in arrival order, into a signal-major `Series`.
 *
 * @throws Error when batches disagree on shape or a batch's values do not match its frames.
 */
export function collect(batches: readonly RunFrames[]): Series {
  const first = batches[0];
  if (!first) return packSeries(new Float64Array(0), 0, []);
  const { elementCount, signalCount } = first;
  const rowWidth = signalCount * elementCount;
  let frames = 0;
  for (const batch of batches) {
    if (batch.elementCount !== elementCount || batch.signalCount !== signalCount) {
      throw new Error(`batch for '${batch.classId}' disagrees with the first batch's shape`);
    }
    if (batch.values.length !== batch.time.length * rowWidth) {
      throw new Error(
        `batch for '${batch.classId}' carries ${batch.values.length} values for ${batch.time.length} frames`,
      );
    }
    frames += batch.time.length;
  }
  const time = new Float64Array(frames);
  const signals = Array.from(
    { length: signalCount },
    () => new Float32Array(frames * elementCount),
  );
  let frame = 0;
  for (const batch of batches) {
    time.set(batch.time, frame);
    for (let row = 0; row < batch.time.length; row++, frame++) {
      const base = row * rowWidth;
      for (let signal = 0; signal < signalCount; signal++) {
        const start = base + signal * elementCount;
        signals[signal]!.set(
          batch.values.subarray(start, start + elementCount),
          frame * elementCount,
        );
      }
    }
  }
  return packSeries(time, elementCount, signals);
}
