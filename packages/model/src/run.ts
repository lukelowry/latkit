import { createSeries, type Series } from './series.js';

/** Executes vendor-encoded commands against one model. */
export interface Runner {
  /** Ends with one done, cancelled, or failed update; throws only when the runner breaks. */
  run(command: Uint8Array, signal?: AbortSignal): AsyncIterable<RunUpdate>;
}

/**
 * One batch, ordered within its result/class pair. Values use
 * `values[frame * signalCount * elementCount + signal * elementCount + element]`.
 * Published buffers are immutable and remain valid after the next batch arrives.
 */
export interface RunFrames {
  readonly resultId: string;
  readonly classId: string;
  readonly elementCount: number;
  /** Sorted class indices when the recorded element axis is sparse. */
  readonly elements?: Uint32Array;
  readonly signalCount: number;
  readonly time: Float64Array;
  readonly values: Float32Array | Float64Array;
}

/** One item off a run stream. */
export type RunUpdate =
  | { readonly type: 'started'; readonly id: string }
  | ({ readonly type: 'frames' } & RunFrames)
  | { readonly type: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  | { readonly type: 'done' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'failed'; readonly message: string };

/** Recorded classes belonging to one result, live or complete. The host owns their resources. */
export interface Results {
  readonly id: string;
  series(classId: string, signal?: AbortSignal): Promise<Series>;
  /** Read batches with signals in requested order; null selects every recorded signal. */
  read(
    classId: string,
    signals: readonly number[] | null,
    signal?: AbortSignal,
  ): AsyncIterable<RunFrames>;
}

/** Collect one result/class's batches without transposing a full-history buffer. */
export function collect(batches: readonly RunFrames[]): Series;
export function collect(batches: AsyncIterable<RunFrames>, frames?: number): Promise<Series>;
export function collect(
  batches: readonly RunFrames[] | AsyncIterable<RunFrames>,
  frames?: number,
): Series | Promise<Series> {
  if (Symbol.asyncIterator in batches) return collectStream(batches, frames);
  const series = createSeries({
    elementCount: batches[0]?.elementCount ?? 0,
    signalCount: batches[0]?.signalCount ?? 0,
    elements: batches[0]?.elements,
  });
  for (const batch of batches) {
    validateIdentity(batch);
    if (!!series.elements !== !!batch.elements)
      throw new RangeError('batches disagree on sparse elements');
    series.append(batch);
  }
  return series;
}

async function collectStream(batches: AsyncIterable<RunFrames>, frames?: number): Promise<Series> {
  if (frames !== undefined && (!Number.isSafeInteger(frames) || frames < 0))
    throw new RangeError('frames must be a non-negative integer');
  let series: ReturnType<typeof createSeries> | undefined;
  for await (const batch of batches) {
    validateIdentity(batch);
    series ??= createSeries({
      elementCount: batch.elementCount,
      signalCount: batch.signalCount,
      elements: batch.elements,
    });
    if (!!series.elements !== !!batch.elements)
      throw new RangeError('batches disagree on sparse elements');
    series.append(batch);
    if (frames !== undefined && series.state.frameCount > frames)
      throw new RangeError(`received more than ${frames} frames`);
  }
  series ??= createSeries({ elementCount: 0, signalCount: 0 });
  if (frames !== undefined && series.state.frameCount !== frames)
    throw new RangeError(`received ${series.state.frameCount} of ${frames} frames`);
  return series;
}

function validateIdentity(batch: RunFrames): void {
  if (
    typeof batch.resultId !== 'string' ||
    !batch.resultId ||
    typeof batch.classId !== 'string' ||
    !batch.classId
  )
    throw new TypeError('batch requires resultId and classId');
}
