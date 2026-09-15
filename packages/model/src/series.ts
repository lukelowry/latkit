import { validateDomain, type Domain } from './domain.js';
import { createEmitter } from './emitter.js';
import type { RunFrames } from './run.js';

/** An append-only history over one class's elements and recorded signals. */
export interface Series {
  readonly elementCount: number;
  readonly signalCount: number;
  /** Sorted, unique class indices; omitted for the dense axis starting at zero. */
  readonly elements?: Uint32Array;
  /** Published atomically after append; previously published records remain unchanged. */
  readonly state: {
    readonly frameCount: number;
    readonly timeRange: Domain | null;
    /** Per-signal finite min/max pairs; NaN pairs for missing signals, null if unknown. */
    readonly ranges: Float64Array | null;
  };
  /**
   * Borrow immutable samples. Values are addressed by `frame * stride + element`.
   * A transport must copy borrowed buffers before transferring them.
   */
  read(
    signalIndex: number,
    window: {
      readonly frameOffset: number;
      readonly frameCount: number;
      readonly elementOffset: number;
      readonly elementCount: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly time: Float64Array;
    readonly values: Float32Array | Float64Array;
    readonly stride: number;
  }>;
  /** Half-open interval of times in the inclusive range, within frameCount committed frames. */
  locate(
    range: Domain,
    frameCount: number,
    signal?: AbortSignal,
  ): Promise<readonly [number, number]>;
  /** Appends preserve committed samples and the element/signal ordering. */
  on(event: 'append', listener: () => void): () => void;
}

type Batch = Pick<RunFrames, 'time' | 'values' | 'elementCount' | 'signalCount' | 'elements'> &
  Partial<Pick<RunFrames, 'resultId' | 'classId'>>;
interface Chunk {
  readonly first: number;
  readonly time: Float64Array;
  readonly values: Float32Array | Float64Array;
  readonly stride: number;
  readonly signalStride: number;
}

/** Validate a published series shape without reading samples. */
export function validateSeries(series: Series): void {
  if (!series || typeof series !== 'object') throw new TypeError('series must be an object');
  index(series.elementCount, 'elementCount');
  index(series.signalCount, 'signalCount');
  index(series.state?.frameCount, 'frameCount');
  if (series.state.timeRange !== null) validateDomain(series.state.timeRange, 'series timeRange');
  if ((series.state.frameCount === 0) !== (series.state.timeRange === null))
    throw new RangeError('series timeRange must be null exactly when there are no frames');
  const ranges = series.state.ranges;
  if (ranges !== null) {
    if (!(ranges instanceof Float64Array) || ranges.length !== series.signalCount * 2)
      throw new RangeError('series ranges must contain one f64 pair per signal');
    for (let i = 0; i < ranges.length; i += 2) {
      if (Number.isNaN(ranges[i]) && Number.isNaN(ranges[i + 1])) continue;
      validateDomain([ranges[i]!, ranges[i + 1]!], 'series range');
    }
  }
  if (series.elements) {
    if (!(series.elements instanceof Uint32Array) || series.elements.length !== series.elementCount)
      throw new RangeError('series elements must contain one class index per stored element');
    for (let i = 1; i < series.elements.length; i++)
      if (series.elements[i]! <= series.elements[i - 1]!)
        throw new RangeError('series elements must be sorted and unique');
  }
  for (const key of ['read', 'locate', 'on'] as const)
    if (typeof series[key] !== 'function') throw new TypeError(`series.${key} must be a function`);
}

/**
 * Create an in-memory series. Optional initial samples are signal-major; appended batches
 * are frame-major. Buffers are borrowed: never mutate or detach them after publication.
 * Reads inside a retained chunk are zero-copy views.
 */
export function createSeries(input: {
  readonly elementCount: number;
  readonly signalCount: number;
  readonly elements?: Uint32Array;
  readonly time?: Float64Array;
  readonly values?: Float32Array | Float64Array;
}): Series & {
  append(
    batch: Omit<RunFrames, 'resultId' | 'classId'> &
      Partial<Pick<RunFrames, 'resultId' | 'classId'>>,
  ): number;
} {
  const { elementCount, signalCount } = input;
  index(elementCount, 'elementCount');
  index(signalCount, 'signalCount');
  const elements = input.elements?.slice();
  const chunks: Chunk[] = [];
  const events = createEmitter<{ append: undefined }>();
  let state: Series['state'] = Object.freeze({
    frameCount: 0,
    timeRange: null,
    ranges: new Float64Array(signalCount * 2).fill(NaN),
  });
  let identity: { resultId: string | undefined; classId: string | undefined } | undefined;
  let wide = false;

  function add(batch: Batch, packed: boolean): number {
    if (batch.elementCount !== elementCount || batch.signalCount !== signalCount)
      throw new RangeError('batch disagrees with the series shape');
    if (
      !(batch.time instanceof Float64Array) ||
      !(batch.values instanceof Float32Array || batch.values instanceof Float64Array)
    )
      throw new TypeError('batch requires f64 time and f32 or f64 values');
    const frames = batch.time.length;
    if (batch.values.length !== frames * elementCount * signalCount)
      throw new RangeError(`batch carries ${batch.values.length} values for ${frames} frames`);
    if (identity && (identity.resultId !== batch.resultId || identity.classId !== batch.classId))
      throw new Error('cannot append batches from different results or classes');
    let previous = state.timeRange?.[1] ?? -Infinity;
    for (const time of batch.time) {
      if (!Number.isFinite(time) || time < previous)
        throw new RangeError('series time must be finite and nondecreasing');
      previous = time;
    }
    if (
      batch.elements &&
      (!elements ||
        batch.elements.length !== elements.length ||
        batch.elements.some((e, i) => e !== elements[i]))
    )
      throw new RangeError('batch disagrees with the series elements');
    if (!Number.isSafeInteger(state.frameCount + frames))
      throw new RangeError('series frame count exceeds a safe integer');
    identity ??= { resultId: batch.resultId, classId: batch.classId };
    if (!frames) return state.frameCount;
    const stride = packed ? elementCount : elementCount * signalCount;
    const signalStride = packed ? frames * elementCount : elementCount;
    const ranges = state.ranges!.slice();
    for (let s = 0; s < signalCount; s++) {
      let min = Number.isNaN(ranges[s * 2]) ? Infinity : ranges[s * 2]!;
      let max = Number.isNaN(ranges[s * 2 + 1]) ? -Infinity : ranges[s * 2 + 1]!;
      for (let f = 0; f < frames; f++) {
        const at = s * signalStride + f * stride;
        for (let e = 0; e < elementCount; e++) {
          const value = batch.values[at + e]!;
          if (!Number.isFinite(value)) continue;
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
      ranges[s * 2] = min <= max ? min : NaN;
      ranges[s * 2 + 1] = min <= max ? max : NaN;
    }
    chunks.push({
      first: state.frameCount,
      time: batch.time,
      values: batch.values,
      stride,
      signalStride,
    });
    wide ||= batch.values instanceof Float64Array;
    state = Object.freeze({
      frameCount: state.frameCount + frames,
      timeRange: Object.freeze([state.timeRange?.[0] ?? batch.time[0]!, previous]) as Domain,
      ranges,
    });
    events.emit('append', undefined);
    return state.frameCount;
  }

  function chunkIndex(frame: number): number {
    let lo = 0,
      hi = chunks.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (chunks[mid]!.first <= frame) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  const series: Series & { append(batch: Batch): number } = {
    elementCount,
    signalCount,
    ...(elements && { elements }),
    get state() {
      return state;
    },
    on: (event, listener) => events.on(event, listener),
    append: (batch) => add(batch, false),
    // eslint-disable-next-line @typescript-eslint/require-await -- preserve async errors for the Series contract
    async locate(range, frameCount, signal) {
      signal?.throwIfAborted();
      validateDomain(range, 'series lookup');
      index(frameCount, 'frameCount');
      if (frameCount > state.frameCount) throw new RangeError('lookup exceeds committed frames');
      const bound = (time: number, upper: boolean): number => {
        let lo = 0,
          hi = frameCount;
        while (lo < hi) {
          const mid = lo + Math.floor((hi - lo) / 2);
          const chunk = chunks[chunkIndex(mid)]!;
          const value = chunk.time[mid - chunk.first]!;
          if (value < time || (upper && value === time)) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      return [bound(range[0], false), bound(range[1], true)];
    },
    async read(signalIndex, window, signal) {
      signal?.throwIfAborted();
      index(signalIndex, 'signal');
      if (signalIndex >= signalCount) throw new RangeError(`signal ${signalIndex} out of range`);
      const { frameOffset, frameCount, elementOffset, elementCount: count } = window;
      for (const [key, value] of Object.entries({
        frameOffset,
        frameCount,
        elementOffset,
        elementCount: count,
      }))
        index(value, key);
      if (frameOffset + frameCount > state.frameCount || elementOffset + count > elementCount)
        throw new RangeError('sample window exceeds the committed series');
      if (!frameCount)
        return { time: new Float64Array(0), values: new Float64Array(0), stride: count };
      let chunkNumber = chunkIndex(frameOffset);
      const first = chunks[chunkNumber]!;
      if (frameOffset + frameCount <= first.first + first.time.length) {
        const f = frameOffset - first.first;
        const start = signalIndex * first.signalStride + f * first.stride + elementOffset;
        return {
          time: first.time.subarray(f, f + frameCount),
          values: count
            ? first.values.subarray(start, start + (frameCount - 1) * first.stride + count)
            : new Float64Array(0),
          stride: first.stride,
        };
      }
      const time = new Float64Array(frameCount);
      const values = wide
        ? new Float64Array(frameCount * count)
        : new Float32Array(frameCount * count);
      let chunk = first;
      for (let f = 0; f < frameCount; f++) {
        if (frameOffset + f >= chunk.first + chunk.time.length) chunk = chunks[++chunkNumber]!;
        const row = frameOffset + f - chunk.first;
        time[f] = chunk.time[row]!;
        const start = signalIndex * chunk.signalStride + row * chunk.stride + elementOffset;
        if (count) values.set(chunk.values.subarray(start, start + count), f * count);
        if (f > 0 && f % Math.max(1, Math.floor(65536 / Math.max(1, count))) === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          signal?.throwIfAborted();
        }
      }
      return { time, values, stride: count };
    },
  };
  validateSeries(series);
  if (input.time !== undefined || input.values !== undefined) {
    if (!input.time || !input.values)
      throw new TypeError('initial time and values must be supplied together');
    add({ elementCount, signalCount, time: input.time, values: input.values }, true);
    identity = undefined;
  }
  return series;
}

/** Borrow one signal's element values at a committed frame. */
export async function sample(
  series: Series,
  signalIndex: number,
  frame: number,
  signal?: AbortSignal,
): Promise<Float32Array | Float64Array> {
  const block = await series.read(
    signalIndex,
    { frameOffset: frame, frameCount: 1, elementOffset: 0, elementCount: series.elementCount },
    signal,
  );
  return block.values.subarray(0, series.elementCount);
}

/** Last frame at or before t; repeated timestamps resolve to their last sample. */
export function frameAt(time: Float64Array, t: number, head = time.length): number {
  const n = Math.min(head, time.length);
  if (n <= 1 || t < time[0]!) return 0;
  let lo = 0,
    hi = n;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (time[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function index(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a nonnegative safe integer`);
}
