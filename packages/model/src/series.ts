/**
 * Series: append-only histories over an element axis and time, read in bounded windows. Every
 * series keeps its frames on a clock, the times it committed as the chunks they came in, and a
 * recording's classes share one clock, so frame `f` is one instant in every one of them. A series
 * holds its values itself, or reads them from wherever its recording is held.
 */

import { breathe } from './breathe.js';
import { validateDomain, type Domain } from './domain.js';
import { listeners } from './listeners.js';

/** An append-only history over one class's elements and signals. */
export interface Series {
  /** The signals it holds, by id; a read names one by its index here. */
  readonly signals: readonly string[];
  readonly elementCount: number;
  /** Sorted, unique class indices; omitted for the dense axis starting at zero. */
  readonly elements?: Uint32Array;
  /** Published atomically after each change; a previous state never changes. */
  readonly state: {
    readonly frameCount: number;
    readonly timeRange: Domain | null;
    /** Per-signal finite min/max pairs; NaN pairs for missing signals, null if unknown. */
    readonly ranges: Float64Array | null;
    /** Whether frames may still follow; false once sealed. */
    readonly live: boolean;
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
  /** Its state changed: frames were appended, or it was sealed. Appends keep what was committed. */
  on(event: 'change', listener: () => void): () => void;
}

/** The frames, elements, and signal a read asks for. */
export type Window = Parameters<Series['read']>[1];

/** What a read returns. */
export type Block = Awaited<ReturnType<Series['read']>>;

/** A series' shape: its signals and its element axis. */
export interface Shape {
  readonly signals: readonly string[];
  readonly elementCount: number;
  readonly elements?: Uint32Array;
}

type Values = Float32Array | Float64Array;

/** The frames one or more series share: their times, as the chunks they were committed in. */
export class Clock {
  readonly #firsts: number[] = [];
  readonly #times: Float64Array[] = [];
  #frameCount = 0;
  #timeRange: Domain | null = null;
  #live = true;

  get frameCount(): number {
    return this.#frameCount;
  }

  get timeRange(): Domain | null {
    return this.#timeRange;
  }

  get live(): boolean {
    return this.#live;
  }

  /** Check that `time` may follow the committed frames, changing nothing. */
  admit(time: unknown): Float64Array {
    if (!this.#live) throw new Error('frames cannot follow a sealed series');
    if (!(time instanceof Float64Array)) throw new TypeError('frames require f64 time');
    let previous = this.#timeRange?.[1] ?? -Infinity;
    for (const value of time) {
      if (!Number.isFinite(value) || value < previous)
        throw new RangeError('series time must be finite and nondecreasing');
      previous = value;
    }
    if (!Number.isSafeInteger(this.#frameCount + time.length))
      throw new RangeError('series frame count exceeds a safe integer');
    return time;
  }

  /** Commit an admitted, nonempty `time` as the next chunk. */
  commit(time: Float64Array): void {
    this.#firsts.push(this.#frameCount);
    this.#times.push(time);
    this.#frameCount += time.length;
    this.#timeRange = Object.freeze([
      this.#timeRange?.[0] ?? time[0]!,
      time[time.length - 1]!,
    ]) as Domain;
  }

  /** No frame follows; false when it was sealed already. */
  seal(): boolean {
    if (!this.#live) return false;
    this.#live = false;
    return true;
  }

  /** The chunk holding committed `frame`. */
  chunkOf(frame: number): number {
    let lo = 0,
      hi = this.#firsts.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (this.#firsts[mid]! <= frame) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  /** The first frame of `chunk`. */
  firstOf(chunk: number): number {
    return this.#firsts[chunk]!;
  }

  /** The times of `chunk`. */
  timesOf(chunk: number): Float64Array {
    return this.#times[chunk]!;
  }

  /** The time of committed `frame`. */
  timeAt(frame: number): number {
    const chunk = this.chunkOf(frame);
    return this.#times[chunk]![frame - this.#firsts[chunk]!]!;
  }

  /** How many of the first `frameCount` frames come before `time`, or at it too when `upper`. */
  bound(time: number, upper: boolean, frameCount: number): number {
    let lo = 0,
      hi = frameCount;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const value = this.timeAt(mid);
      if (value < time || (upper && value === time)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The latest frame at or before `time`, the first before it starts; -1 while empty. */
  frameAt(time: number): number {
    if (!Number.isFinite(time)) throw new RangeError('time must be finite');
    return this.#frameCount === 0 ? -1 : Math.max(0, this.bound(time, true, this.#frameCount) - 1);
  }
}

/** A series its owner publishes: after each change, with the ranges its values reach. */
interface Published {
  readonly series: Series;
  /** Publish what the clock holds now with `ranges`, and tell every listener. */
  publish(ranges: Float64Array | null): void;
  /** Stop telling listeners. */
  clear(): void;
}

/**
 * The series every kind shares over `clock`: its shape, its published state, `locate`, and its
 * listeners, reading a checked window of committed frames through `read`.
 */
function shell(
  clock: Clock,
  shape: Shape,
  read: (signalIndex: number, window: Window, signal?: AbortSignal) => Promise<Block>,
): Published {
  const signals = signalIds(shape.signals);
  const { elementCount } = shape;
  index(elementCount, 'elementCount');
  const elements = shape.elements?.slice();
  const changes = listeners();
  let state: Series['state'] = snapshot(new Float64Array(signals.length * 2).fill(NaN));

  function snapshot(ranges: Float64Array | null): Series['state'] {
    return Object.freeze({
      frameCount: clock.frameCount,
      timeRange: clock.timeRange,
      ranges,
      live: clock.live,
    });
  }

  const series: Series = {
    signals,
    elementCount,
    ...(elements && { elements }),
    get state() {
      return state;
    },
    on: (_event, listener) => changes.on(listener),
    // eslint-disable-next-line @typescript-eslint/require-await -- preserve async errors for the Series contract
    async locate(range, frameCount, signal) {
      signal?.throwIfAborted();
      validateDomain(range, 'series lookup');
      index(frameCount, 'frameCount');
      if (frameCount > state.frameCount) throw new RangeError('lookup exceeds committed frames');
      return [clock.bound(range[0], false, frameCount), clock.bound(range[1], true, frameCount)];
    },
    async read(signalIndex, window, signal) {
      signal?.throwIfAborted();
      index(signalIndex, 'signal');
      if (signalIndex >= signals.length) throw new RangeError(`signal ${signalIndex} out of range`);
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
      return read(signalIndex, window, signal);
    },
  };
  validateSeries(series);

  return {
    series,
    publish(ranges) {
      state = snapshot(ranges);
      changes.emit();
    },
    clear: () => changes.clear(),
  };
}

/** One chunk of a series' values; `values` null reads NaN for that chunk's frames. */
interface Lane {
  readonly values: Values | null;
  readonly stride: number;
  readonly signalStride: number;
}

/** A series whose frames are a clock's: its owner adds one lane per chunk the clock commits. */
export interface Track {
  readonly series: Series;
  /** Check frame-major `values` for `frames` frames, changing nothing. */
  admit(values: unknown, frames: number): Values;
  /**
   * Add the lane of the chunk the clock just committed: frame-major, signal-major when `packed`,
   * or NaN throughout when `values` is null.
   */
  push(values: Values | null, frames: number, packed: boolean): void;
  /** Publish what the clock and the lanes hold now, and tell every listener. */
  publish(): void;
}

/**
 * The series over `clock` with `shape` that holds its values, empty until its owner pushes lanes.
 *
 * @throws RangeError or TypeError when the shape is invalid.
 */
export function track(clock: Clock, shape: Shape): Track {
  const signalCount = signalIds(shape.signals).length;
  const { elementCount } = shape;
  const lanes: (Lane | null)[] = [];
  let ranges = new Float64Array(signalCount * 2).fill(NaN);
  let wide = false;

  function nan(length: number): Values {
    return (wide ? new Float64Array(length) : new Float32Array(length)).fill(NaN);
  }

  const published = shell(clock, shape, async (signalIndex, window, signal) => {
    const { frameOffset, frameCount, elementOffset, elementCount: count } = window;
    let chunk = clock.chunkOf(frameOffset);
    let first = clock.firstOf(chunk);
    let times = clock.timesOf(chunk);
    let lane = lanes[chunk]!;
    if (frameOffset + frameCount <= first + times.length) {
      const f = frameOffset - first;
      const time = times.subarray(f, f + frameCount);
      if (!count) return { time, values: new Float64Array(0), stride: count };
      if (!lane.values) return { time, values: nan(frameCount * count), stride: count };
      const start = signalIndex * lane.signalStride + f * lane.stride + elementOffset;
      return {
        time,
        values: lane.values.subarray(start, start + (frameCount - 1) * lane.stride + count),
        stride: lane.stride,
      };
    }
    const time = new Float64Array(frameCount);
    const values = wide
      ? new Float64Array(frameCount * count)
      : new Float32Array(frameCount * count);
    for (let f = 0; f < frameCount; f++) {
      if (frameOffset + f >= first + times.length) {
        chunk++;
        first = clock.firstOf(chunk);
        times = clock.timesOf(chunk);
        lane = lanes[chunk]!;
      }
      const row = frameOffset + f - first;
      time[f] = times[row]!;
      if (count && !lane.values) values.fill(NaN, f * count, (f + 1) * count);
      else if (count) {
        const start = signalIndex * lane.signalStride + row * lane.stride + elementOffset;
        values.set(lane.values!.subarray(start, start + count), f * count);
      }
      if (f > 0 && f % Math.max(1, Math.floor(65536 / Math.max(1, count))) === 0) {
        await breathe();
        signal?.throwIfAborted();
      }
    }
    return { time, values, stride: count };
  });

  return {
    series: published.series,
    admit(values, frames) {
      if (!(values instanceof Float32Array || values instanceof Float64Array))
        throw new TypeError('frames require f32 or f64 values');
      if (values.length !== frames * elementCount * signalCount)
        throw new RangeError(`frames carry ${values.length} values for ${frames} frames`);
      return values;
    },
    push(values, frames, packed) {
      if (!values) {
        lanes.push({ values: null, stride: 0, signalStride: 0 });
        return;
      }
      const stride = packed ? elementCount : elementCount * signalCount;
      const signalStride = packed ? frames * elementCount : elementCount;
      const next = ranges.slice();
      for (let s = 0; s < signalCount; s++) {
        let min = Number.isNaN(next[s * 2]) ? Infinity : next[s * 2]!;
        let max = Number.isNaN(next[s * 2 + 1]) ? -Infinity : next[s * 2 + 1]!;
        for (let f = 0; f < frames; f++) {
          const at = s * signalStride + f * stride;
          for (let e = 0; e < elementCount; e++) {
            const value = values[at + e]!;
            if (!Number.isFinite(value)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
          }
        }
        next[s * 2] = min <= max ? min : NaN;
        next[s * 2 + 1] = min <= max ? max : NaN;
      }
      ranges = next;
      lanes.push({ values, stride, signalStride });
      wide ||= values instanceof Float64Array;
    },
    publish: () => published.publish(ranges),
  };
}

/**
 * The series over `clock` with `shape` whose values are held elsewhere: `read` fetches a checked
 * window, and its owner publishes the ranges the holder reports.
 *
 * @throws RangeError or TypeError when the shape is invalid.
 */
export function sourced(
  clock: Clock,
  shape: Shape,
  read: (signalIndex: number, window: Window, signal?: AbortSignal) => Promise<Block>,
): Published {
  const published = shell(clock, shape, async (signalIndex, window, signal) => {
    const block = await read(signalIndex, window, signal);
    signal?.throwIfAborted();
    checkBlock(block, window);
    return block;
  });
  const signalCount = published.series.signals.length;
  return {
    series: published.series,
    publish(ranges) {
      if (
        ranges !== null &&
        (!(ranges instanceof Float64Array) || ranges.length !== signalCount * 2)
      )
        throw new RangeError('series ranges must contain one f64 pair per signal');
      published.publish(ranges);
    },
    clear: published.clear,
  };
}

/** Check that a block read from elsewhere is the window asked for. */
function checkBlock(block: Block, window: Window): void {
  const required =
    window.frameCount && window.elementCount
      ? (window.frameCount - 1) * block.stride + window.elementCount
      : 0;
  if (
    !block ||
    !(block.time instanceof Float64Array) ||
    !(block.values instanceof Float32Array || block.values instanceof Float64Array) ||
    !Number.isSafeInteger(block.stride) ||
    block.stride < window.elementCount ||
    block.time.length !== window.frameCount ||
    block.values.length < required
  )
    throw new Error('invalid samples block');
}

/**
 * Check a series' shape and published state without reading samples: what a renderer runs on a
 * series it is given, and what a series made elsewhere must pass.
 *
 * @throws TypeError or RangeError naming the first thing that is wrong.
 */
export function validateSeries(series: Series): void {
  if (!series || typeof series !== 'object') throw new TypeError('series must be an object');
  signalIds(series.signals);
  index(series.elementCount, 'elementCount');
  const state = series.state as Series['state'] | undefined;
  if (!state || typeof state !== 'object') throw new TypeError('series state must be an object');
  index(state.frameCount, 'frameCount');
  if (typeof state.live !== 'boolean') throw new TypeError('series live must be a boolean');
  if (state.timeRange !== null) validateDomain(state.timeRange, 'series timeRange');
  if ((state.frameCount === 0) !== (state.timeRange === null))
    throw new RangeError('series timeRange must be null exactly when there are no frames');
  const ranges = state.ranges;
  if (ranges !== null) {
    if (!(ranges instanceof Float64Array) || ranges.length !== series.signals.length * 2)
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
 * Create an in-memory series. Optional initial samples are signal-major; appended frames are
 * frame-major, `values[(frame * signals + signal) * elements + element]`. Buffers are borrowed:
 * never mutate or detach them after publication. Reads inside one append are zero-copy views.
 *
 * @throws RangeError or TypeError when the shape or the initial samples are invalid.
 */
export function createSeries(input: {
  readonly signals: readonly string[];
  readonly elementCount: number;
  readonly elements?: Uint32Array;
  readonly time?: Float64Array;
  readonly values?: Float32Array | Float64Array;
}): Series & {
  /** Commit frames after those committed; nothing changes when they are invalid. */
  append(frames: {
    readonly time: Float64Array;
    readonly values: Float32Array | Float64Array;
  }): void;
  /** No frame follows. */
  seal(): void;
} {
  const clock = new Clock();
  const history = track(clock, input);
  if (input.time !== undefined || input.values !== undefined) {
    if (!input.time || !input.values)
      throw new TypeError('initial time and values must be supplied together');
    const time = clock.admit(input.time);
    const values = history.admit(input.values, time.length);
    if (time.length) {
      clock.commit(time);
      history.push(values, time.length, true);
      history.publish();
    }
  }
  return Object.assign(history.series, {
    append(frames: { readonly time: Float64Array; readonly values: Values }) {
      const time = clock.admit(frames.time);
      const values = history.admit(frames.values, time.length);
      if (!time.length) return;
      clock.commit(time);
      history.push(values, time.length, false);
      history.publish();
    },
    seal() {
      if (clock.seal()) history.publish();
    },
  });
}

/** The signal ids of a series: distinct, non-empty strings, as a frozen copy. */
function signalIds(signals: unknown): readonly string[] {
  if (!Array.isArray(signals)) throw new TypeError('series signals must be an array of ids');
  for (const id of signals as unknown[])
    if (typeof id !== 'string' || id === '')
      throw new TypeError('series signals must be non-empty strings');
  if (new Set(signals).size !== signals.length)
    throw new RangeError('series signals must be unique');
  return Object.freeze([...(signals as string[])]);
}

function index(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a nonnegative safe integer`);
}
