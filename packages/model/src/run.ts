/**
 * The shape of a run: what any engine, local or remote, emits while it executes a model, how its
 * frames fold into a `Series`, and how what it recorded is read back afterwards.
 *
 * @remarks
 * The model package defines only these contracts. A command is vendor bytes; a `Runner` is
 * something a host holds when it has an engine, never a method on a model; `Results` is what that
 * host holds once the run is over.
 */

import { packedSeries, type Series } from './series.js';

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
 * What a run leaves behind: recorded samples a host holds, one table per class, read back as the
 * batches the run streamed. A store on disk, a file a solver wrote, or series held in memory all
 * read the same way; the format is the implementation's business.
 */
export interface Results {
  /**
   * One class's batches in frame order. `signals` selects recorded-order indexes, or every recorded
   * signal when null; each batch's `signalCount` is the selection's length, in selection order.
   * A class or signal the results do not record fails the iteration.
   */
  read(
    classId: string,
    signals: readonly number[] | null,
    signal?: AbortSignal,
  ): AsyncIterable<RunFrames>;
}

/** A series being filled batch by batch, straight into its final signal-major layout. */
class Fill {
  readonly time: Float64Array;
  readonly values: Float32Array;
  #at = 0;

  constructor(
    readonly elementCount: number,
    readonly signalCount: number,
    readonly frames: number,
  ) {
    this.time = new Float64Array(frames);
    this.values = new Float32Array(signalCount * frames * elementCount);
  }

  /** Append one batch; every batch must share the first one's shape and fit the frame count. */
  add(batch: RunFrames): void {
    const { elementCount, signalCount, frames } = this;
    const rowWidth = signalCount * elementCount;
    if (batch.elementCount !== elementCount || batch.signalCount !== signalCount) {
      throw new Error(`batch for '${batch.classId}' disagrees with the first batch's shape`);
    }
    if (batch.values.length !== batch.time.length * rowWidth) {
      throw new Error(
        `batch for '${batch.classId}' carries ${batch.values.length} values for ${batch.time.length} frames`,
      );
    }
    if (this.#at + batch.time.length > frames) {
      throw new Error(`batch for '${batch.classId}' overruns the ${frames} frames expected`);
    }
    this.time.set(batch.time, this.#at);
    const stride = frames * elementCount;
    for (let row = 0; row < batch.time.length; row++) {
      const base = row * rowWidth;
      const into = (this.#at + row) * elementCount;
      for (let signal = 0; signal < signalCount; signal++) {
        const start = base + signal * elementCount;
        this.values.set(batch.values.subarray(start, start + elementCount), signal * stride + into);
      }
    }
    this.#at += batch.time.length;
  }

  /** The complete series; throws while frames are still missing. */
  finish(): Series {
    if (this.#at !== this.frames) {
      throw new Error(`received ${this.#at} of ${this.frames} frames`);
    }
    return packedSeries(this.time, this.elementCount, this.signalCount, this.values);
  }
}

function emptySeries(): Series {
  return packedSeries(new Float64Array(0), 0, 0, new Float32Array(0));
}

/**
 * Fold one class's batches, in arrival order, into a signal-major `Series`: an array at once, or a
 * stream as it arrives. `frames`, the exact frame count, lets a stream fill a preallocated series;
 * without it the batches are held and folded at the end.
 *
 * @throws Error when batches disagree on shape, a batch's values do not match its frames, or a
 * stream carries other than `frames` frames.
 */
export function collect(batches: readonly RunFrames[]): Series;
export function collect(batches: AsyncIterable<RunFrames>, frames?: number): Promise<Series>;
export function collect(
  batches: readonly RunFrames[] | AsyncIterable<RunFrames>,
  frames?: number,
): Series | Promise<Series> {
  return isAsync(batches) ? collectStream(batches, frames) : collectAll(batches);
}

function isAsync(
  batches: readonly RunFrames[] | AsyncIterable<RunFrames>,
): batches is AsyncIterable<RunFrames> {
  return Symbol.asyncIterator in batches;
}

function collectAll(batches: readonly RunFrames[]): Series {
  const first = batches[0];
  if (!first) return emptySeries();
  const fill = new Fill(
    first.elementCount,
    first.signalCount,
    batches.reduce((frames, batch) => frames + batch.time.length, 0),
  );
  for (const batch of batches) fill.add(batch);
  return fill.finish();
}

async function collectStream(batches: AsyncIterable<RunFrames>, frames?: number): Promise<Series> {
  if (frames === undefined) {
    const held: RunFrames[] = [];
    for await (const batch of batches) held.push(batch);
    return collectAll(held);
  }
  if (!Number.isSafeInteger(frames) || frames < 0) {
    throw new Error(`frames must be a non-negative integer, not ${frames}`);
  }
  let fill: Fill | null = null;
  for await (const batch of batches) {
    fill ??= new Fill(batch.elementCount, batch.signalCount, frames);
    fill.add(batch);
  }
  if (fill) return fill.finish();
  if (frames === 0) return emptySeries();
  throw new Error(`received 0 of ${frames} frames`);
}
