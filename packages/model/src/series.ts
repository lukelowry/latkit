/**
 * Series: histories over an element axis and time, read in bounded windows, and what every view
 * follows. Every series keeps its frames on a clock, the times committed as the chunks they came
 * in, and a recording's classes share one clock, so frame `f` is one instant in every one of them.
 * A series holds its samples itself, reads them from wherever its recording is held, or gathers
 * them from another series over other items.
 */

import { breathe } from './breathe.js';
import { validateDomain, type Domain } from './domain.js';
import { listeners } from './listeners.js';

/** The most one read asks for, time included: within any port's cap. */
const READ_BYTES = 1 << 20;

/** The most elements one read spans: one frame of them is half of `READ_BYTES` in f64. */
const READ_ELEMENTS = READ_BYTES / 16;

/** How far apart two gathered elements may sit and still share a read. */
const GAP = 64;

/** An element no item holds. */
const NONE = 0xffffffff;

type Values = Float32Array | Float64Array;

/**
 * A history a view follows: signals over time for an element axis, read in bounded windows. A
 * subclass holds the samples and publishes what it holds; the base checks every read and tells
 * the listeners. `Series.create` holds samples in memory for their creator to append.
 */
export abstract class Series {
  /** The signals it holds, by id; a read names one by its index here. */
  readonly signals: readonly string[];
  readonly elementCount: number;
  /** Sorted, unique class indices of the stored elements; absent for the dense axis from zero. */
  readonly elements?: Uint32Array;
  #state: Series.State;
  readonly #changes = listeners();

  /**
   * @throws RangeError or TypeError when the shape is invalid.
   */
  protected constructor(shape: Series.Shape) {
    this.signals = signalIds(shape.signals);
    index(shape.elementCount, 'elementCount');
    this.elementCount = shape.elementCount;
    if (shape.elements !== undefined) {
      const elements = shape.elements;
      if (!(elements instanceof Uint32Array) || elements.length !== shape.elementCount)
        throw new RangeError('series elements must contain one class index per stored element');
      for (let i = 1; i < elements.length; i++)
        if (elements[i]! <= elements[i - 1]!)
          throw new RangeError('series elements must be sorted and unique');
      this.elements = elements.slice();
    }
    this.#state = Object.freeze({
      frameCount: 0,
      timeRange: null,
      ranges: new Float64Array(this.signals.length * 2).fill(NaN),
      live: true,
    });
  }

  /** Published atomically after each change; a previous state never changes. */
  get state(): Series.State {
    return this.#state;
  }

  /**
   * Borrow one signal's samples in `window`, addressed `frame * stride + element`. Never mutate
   * them; a transport copies them before transferring them.
   *
   * @throws RangeError for a signal it lacks or a window beyond the committed frames.
   */
  async read(
    signalIndex: number,
    window: Series.Window,
    signal?: AbortSignal,
  ): Promise<Series.Block> {
    signal?.throwIfAborted();
    if (
      checkRead(signalIndex, window, this.signals.length, this.state.frameCount, this.elementCount)
    )
      return {
        time: new Float64Array(0),
        values: new Float64Array(0),
        stride: window.elementCount,
      };
    return this.fetch(signalIndex, window, signal);
  }

  /**
   * The half-open frames, among the first `frameCount`, whose times fall in the inclusive `range`.
   *
   * @throws RangeError or TypeError for a bad range, or more frames than are committed.
   */
  abstract locate(
    range: Domain,
    frameCount: number,
    signal?: AbortSignal,
  ): Promise<readonly [number, number]>;

  /** Its state changed: frames were appended, or it was sealed. Appends keep what was committed. */
  on(_event: 'change', listener: () => void): () => void {
    return this.#changes.on(listener);
  }

  /** Read a checked, nonempty window of committed frames. */
  protected abstract fetch(
    signalIndex: number,
    window: Series.Window,
    signal?: AbortSignal,
  ): Promise<Series.Block>;

  /** Check and publish what it holds now, then tell every listener. */
  protected publish(state: Series.State): void {
    checkState(state, this.signals.length);
    this.#state = Object.freeze({ ...state });
    this.#changes.emit();
  }

  /** Stop telling listeners. */
  protected silence(): void {
    this.#changes.clear();
  }

  /**
   * A series held in memory for its creator to append to and seal. Initial samples are
   * signal-major, `values[(signal * frames + frame) * elements + element]`; appended frames are
   * frame-major, `values[(frame * signals + signal) * elements + element]`. Buffers are taken, not
   * copied: never mutate or detach them after handing them over.
   *
   * @throws RangeError or TypeError when the shape or the initial samples are invalid.
   */
  static create(
    input: Series.Shape & { readonly time?: Float64Array; readonly values?: Values },
  ): Series & {
    /** Commit frames after those committed; nothing changes when they are invalid. */
    append(frames: { readonly time: Float64Array; readonly values: Values }): void;
    /** No frame follows. */
    seal(): void;
  } {
    return new Held(input);
  }
}

/** A series' shape and state, and the windows it reads. */
export declare namespace Series {
  /** Its signals and its element axis. */
  interface Shape {
    readonly signals: readonly string[];
    readonly elementCount: number;
    /** Sorted, unique class indices; omitted for the dense axis from zero. */
    readonly elements?: Uint32Array;
  }
  /** Where a series stands. */
  interface State {
    readonly frameCount: number;
    readonly timeRange: Domain | null;
    /** Per-signal finite min/max pairs; NaN pairs for a signal with none yet; null if unknown. */
    readonly ranges: Float64Array | null;
    /** Whether frames may still follow; false once sealed. */
    readonly live: boolean;
  }
  /** The frames and elements a read asks for. */
  interface Window {
    readonly frameOffset: number;
    readonly frameCount: number;
    readonly elementOffset: number;
    readonly elementCount: number;
  }
  /** What a read returns: one row of `stride` values per frame. */
  interface Block {
    readonly time: Float64Array;
    readonly values: Float32Array | Float64Array;
    readonly stride: number;
  }
  /**
   * Where a series held here keeps its values: one lane for each chunk its clock commits, written
   * once, then read by rows. In memory unless its host keeps them elsewhere, such as on disk.
   */
  interface Store {
    /** Keep `values` as the next lane, taking the buffer; the lane's number, counting from 0. */
    put(values: Float32Array | Float64Array): number;
    /**
     * `rows` rows of `count` values of `lane`, the first at `offset` and each `stride` values
     * after the one before: a view of the lane with them `stride` apart, or rows of their own.
     */
    get(
      lane: number,
      at: {
        readonly offset: number;
        readonly count: number;
        readonly rows: number;
        readonly stride: number;
      },
      signal?: AbortSignal,
    ): Promise<Pick<Block, 'values' | 'stride'>>;
    /** Resolves once it can take more lanes; absent for a store that always can. */
    readonly ready?: Promise<void>;
    /** Let every lane go. */
    close(): void;
  }
}

/** A store that holds its lanes in memory and lends each as it is. */
export function memoryStore(): Series.Store {
  let lanes: Values[] | null = [];
  return {
    put: (values) => lanes!.push(values) - 1,
    get(lane, { offset, count, rows, stride }) {
      const values = lanes?.[lane];
      if (!values) return Promise.reject(new Error('the series was closed'));
      return Promise.resolve({
        values: values.subarray(offset, offset + (rows - 1) * stride + count),
        stride,
      });
    },
    close() {
      lanes = null;
    },
  };
}

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

  /** The times of committed frames `from` up to `to`, copied a chunk at a time. */
  slice(from: number, to: number): Float64Array {
    const out = new Float64Array(to - from);
    for (let chunk = this.chunkOf(from), at = from; at < to; chunk++) {
      const first = this.#firsts[chunk]!;
      const end = Math.min(to, first + this.#times[chunk]!.length);
      out.set(this.#times[chunk]!.subarray(at - first, end - first), at - from);
      at = end;
    }
    return out;
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

/** A series whose frames are a clock's: it locates by that clock, and publishes what it holds. */
abstract class Clocked extends Series {
  readonly #clock: Clock;

  constructor(clock: Clock, shape: Series.Shape) {
    super(shape);
    this.#clock = clock;
  }

  protected get clock(): Clock {
    return this.#clock;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- preserve async errors for the Series contract
  async locate(
    range: Domain,
    frameCount: number,
    signal?: AbortSignal,
  ): Promise<readonly [number, number]> {
    signal?.throwIfAborted();
    validateDomain(range, 'series lookup');
    index(frameCount, 'frameCount');
    if (frameCount > this.state.frameCount) throw new RangeError('lookup exceeds committed frames');
    return [
      this.#clock.bound(range[0], false, frameCount),
      this.#clock.bound(range[1], true, frameCount),
    ];
  }

  /** Publish what the clock holds now with `ranges`, and tell every listener. */
  protected settle(ranges: Float64Array | null): void {
    this.publish({
      frameCount: this.#clock.frameCount,
      timeRange: this.#clock.timeRange,
      ranges,
      live: this.#clock.live,
    });
  }
}

/** One chunk's lane in the store, and how its values lie in it. */
interface Lane {
  readonly lane: number;
  readonly stride: number;
  readonly signalStride: number;
}

/**
 * A series over a clock that holds its values: its owner adds one lane per chunk the clock
 * commits, kept in `store`. Reads within one chunk get the rows as the store gives them; reads
 * across chunks copy.
 */
export class Tracked extends Clocked {
  readonly #lanes: (Lane | null)[] = [];
  readonly #store: Series.Store;
  #ranges: Float64Array;
  #wide = false;

  constructor(clock: Clock, shape: Series.Shape, store: Series.Store = memoryStore()) {
    super(clock, shape);
    this.#store = store;
    this.#ranges = new Float64Array(this.signals.length * 2).fill(NaN);
  }

  /** Check frame-major `values` for `frames` frames, changing nothing. */
  admit(values: unknown, frames: number): Values {
    if (!(values instanceof Float32Array || values instanceof Float64Array))
      throw new TypeError('frames require f32 or f64 values');
    if (values.length !== frames * this.elementCount * this.signals.length)
      throw new RangeError(`frames carry ${values.length} values for ${frames} frames`);
    return values;
  }

  /**
   * Store the next chunk and return what commits its lane and ranges once every class is
   * stored. Values are frame-major, signal-major when `packed`, or NaN when null.
   */
  stage(values: Values | null, frames: number, packed: boolean): () => void {
    if (!values) return () => void this.#lanes.push(null);
    const { elementCount } = this;
    const signalCount = this.signals.length;
    const stride = packed ? elementCount : elementCount * signalCount;
    const signalStride = packed ? frames * elementCount : elementCount;
    const next = this.#ranges.slice();
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
    const wide = values instanceof Float64Array;
    const lane = this.#store.put(values);
    return () => {
      this.#ranges = next;
      this.#wide ||= wide;
      this.#lanes.push({ lane, stride, signalStride });
    };
  }

  /** Publish what the clock and the lanes hold now, and tell every listener. */
  update(): void {
    this.settle(this.#ranges);
  }

  protected async fetch(
    signalIndex: number,
    window: Series.Window,
    signal?: AbortSignal,
  ): Promise<Series.Block> {
    const { frameOffset, frameCount, elementOffset, elementCount: count } = window;
    const clock = this.clock;
    let chunk = clock.chunkOf(frameOffset);
    const first = clock.firstOf(chunk);
    const times = clock.timesOf(chunk);
    if (frameOffset + frameCount <= first + times.length) {
      const f = frameOffset - first;
      const time = times.subarray(f, f + frameCount);
      if (!count) return { time, values: new Float64Array(0), stride: count };
      const rows = await this.#rows(
        chunk,
        signalIndex,
        f,
        frameCount,
        elementOffset,
        count,
        signal,
      );
      return rows
        ? { time, ...rows }
        : { time, values: this.#nan(frameCount * count), stride: count };
    }
    const time = new Float64Array(frameCount);
    const values = this.#wide
      ? new Float64Array(frameCount * count)
      : new Float32Array(frameCount * count);
    for (let done = 0, copied = 0; done < frameCount; chunk++) {
      const f = frameOffset + done - clock.firstOf(chunk);
      const chunkTimes = clock.timesOf(chunk);
      const frames = Math.min(chunkTimes.length - f, frameCount - done);
      time.set(chunkTimes.subarray(f, f + frames), done);
      const rows = count
        ? await this.#rows(chunk, signalIndex, f, frames, elementOffset, count, signal)
        : null;
      if (count && !rows) values.fill(NaN, done * count, (done + frames) * count);
      for (let row = 0; rows && row < frames; row++)
        values.set(
          rows.values.subarray(row * rows.stride, row * rows.stride + count),
          (done + row) * count,
        );
      done += frames;
      if ((copied += frames * count) >= 65536) {
        copied = 0;
        await breathe();
        signal?.throwIfAborted();
      }
    }
    return { time, values, stride: count };
  }

  /**
   * One signal's `rows` rows of `chunk`, from its row `f`, as the store gives them; null for a
   * chunk that reads NaN.
   */
  async #rows(
    chunk: number,
    signalIndex: number,
    f: number,
    rows: number,
    elementOffset: number,
    count: number,
    signal?: AbortSignal,
  ): Promise<Pick<Series.Block, 'values' | 'stride'> | null> {
    const lane = this.#lanes[chunk];
    if (!lane) return null;
    const offset = signalIndex * lane.signalStride + f * lane.stride + elementOffset;
    return this.#store.get(lane.lane, { offset, count, rows, stride: lane.stride }, signal);
  }

  #nan(length: number): Values {
    return (this.#wide ? new Float64Array(length) : new Float32Array(length)).fill(NaN);
  }
}

/** A series in memory that its creator appends to over a clock of its own. */
class Held extends Tracked {
  constructor(input: Series.Shape & { readonly time?: Float64Array; readonly values?: Values }) {
    super(new Clock(), input);
    if (input.time === undefined && input.values === undefined) return;
    if (!input.time || !input.values)
      throw new TypeError('initial time and values must be supplied together');
    const time = this.clock.admit(input.time);
    const values = this.admit(input.values, time.length);
    if (!time.length) return;
    const commit = this.stage(values, time.length, true);
    this.clock.commit(time);
    commit();
    this.update();
  }

  append(frames: { readonly time: Float64Array; readonly values: Values }): void {
    const time = this.clock.admit(frames.time);
    const values = this.admit(frames.values, time.length);
    if (!time.length) return;
    const commit = this.stage(values, time.length, false);
    this.clock.commit(time);
    commit();
    this.update();
  }

  seal(): void {
    if (this.clock.seal()) this.update();
  }
}

/**
 * A series over a clock whose values are held elsewhere: `read` fetches them in windows no larger
 * than `READ_BYTES`, however large the window asked for, and its owner publishes the ranges the
 * holder reports.
 */
export class Sourced extends Clocked {
  readonly #read: (
    signalIndex: number,
    window: Series.Window,
    signal?: AbortSignal,
  ) => Promise<Series.Block>;

  constructor(
    clock: Clock,
    shape: Series.Shape,
    read: (
      signalIndex: number,
      window: Series.Window,
      signal?: AbortSignal,
    ) => Promise<Series.Block>,
  ) {
    super(clock, shape);
    this.#read = read;
  }

  /**
   * Publish what the clock holds now with the ranges its holder reports.
   *
   * @throws RangeError when `ranges` is not one f64 pair per signal.
   */
  follow(ranges: Float64Array | null): void {
    if (
      ranges !== null &&
      (!(ranges instanceof Float64Array) || ranges.length !== this.signals.length * 2)
    )
      throw new RangeError('series ranges must contain one f64 pair per signal');
    this.settle(ranges);
  }

  /** Stop telling listeners. */
  forget(): void {
    this.silence();
  }

  protected async fetch(
    signalIndex: number,
    window: Series.Window,
    signal?: AbortSignal,
  ): Promise<Series.Block> {
    const { frameOffset, frameCount, elementOffset, elementCount } = window;
    if (frameCount * (elementCount + 1) * 8 <= READ_BYTES) {
      const block = await this.#read(signalIndex, window, signal);
      signal?.throwIfAborted();
      checkBlock(block, window);
      return block;
    }
    // A window larger than one read: frames and elements in pieces, into one block of its own.
    const span = Math.min(elementCount, READ_ELEMENTS);
    const step = Math.max(1, Math.floor(READ_BYTES / (8 * (span + 1))));
    const time = new Float64Array(frameCount);
    const values = new Float64Array(frameCount * elementCount);
    for (let done = 0; done < frameCount; done += step) {
      const frames = Math.min(step, frameCount - done);
      for (let from = 0; from === 0 || from < elementCount; from += span) {
        const count = Math.min(span, elementCount - from);
        const piece = {
          frameOffset: frameOffset + done,
          frameCount: frames,
          elementOffset: elementOffset + from,
          elementCount: count,
        };
        const block = await this.#read(signalIndex, piece, signal);
        signal?.throwIfAborted();
        checkBlock(block, piece);
        if (from === 0) time.set(block.time, done);
        for (let f = 0; f < frames; f++)
          values.set(
            block.values.subarray(f * block.stride, f * block.stride + count),
            (done + f) * elementCount + from,
          );
      }
    }
    return { time, values, stride: elementCount };
  }
}

/**
 * Signal `signalIndex` of `source` over other items: item `i` holds class element `picks[i]`, NaN
 * for `0xffffffff` or an element a sparse source does not hold. It shares the source's clock,
 * changes, and recorded range, and reads the source in runs of the elements a window needs.
 */
export class Gathered extends Series {
  readonly #source: Series;
  readonly #signal: number;
  /** Each item's position on the source's element axis, or -1. */
  readonly #positions: Int32Array;
  #seen: Series.State | null = null;
  #derived: Series.State | null = null;

  constructor(source: Series, signalIndex: number, picks: Uint32Array) {
    super({ signals: [source.signals[signalIndex]!], elementCount: picks.length });
    this.#source = source;
    this.#signal = signalIndex;
    const stored = source.elements;
    this.#positions = Int32Array.from(picks, (element) =>
      element === NONE ? -1 : stored ? positionOf(stored, element) : element,
    );
  }

  override get state(): Series.State {
    const current = this.#source.state;
    if (current !== this.#seen || !this.#derived) {
      this.#seen = current;
      const at = this.#signal * 2;
      this.#derived = Object.freeze({
        frameCount: current.frameCount,
        timeRange: current.timeRange,
        ranges: current.ranges && current.ranges.slice(at, at + 2),
        live: current.live,
      });
    }
    return this.#derived;
  }

  locate(
    range: Domain,
    frameCount: number,
    signal?: AbortSignal,
  ): Promise<readonly [number, number]> {
    return this.#source.locate(range, frameCount, signal);
  }

  override on(event: 'change', listener: () => void): () => void {
    return this.#source.on(event, listener);
  }

  protected async fetch(
    _signalIndex: number,
    window: Series.Window,
    signal?: AbortSignal,
  ): Promise<Series.Block> {
    const { frameOffset, frameCount, elementOffset, elementCount } = window;
    const positions = this.#positions;
    // The window's items in source order, split into runs of nearby elements read side by side,
    // each in windows under `READ_BYTES`; a window of none reads its times alone.
    const runs: { from: number; to: number; items: number[] }[] = [];
    const items = Array.from({ length: elementCount }, (_, item) => item)
      .filter((item) => positions[elementOffset + item]! >= 0)
      .sort((a, b) => positions[elementOffset + a]! - positions[elementOffset + b]!);
    for (const item of items) {
      const position = positions[elementOffset + item]!;
      const run = runs.at(-1);
      if (run && position - run.to <= GAP && position + 1 - run.from <= READ_ELEMENTS) {
        run.to = Math.max(run.to, position + 1);
        run.items.push(item);
      } else runs.push({ from: position, to: position + 1, items: [item] });
    }
    if (!runs.length) runs.push({ from: 0, to: 0, items: [] });
    const time = new Float64Array(frameCount);
    const values = new Float64Array(frameCount * elementCount).fill(NaN);
    await Promise.all(
      runs.map(async ({ from, to, items: run }) => {
        const span = to - from;
        const step = Math.max(1, Math.floor(READ_BYTES / (8 * (span + 1))));
        for (let done = 0; done < frameCount; done += step) {
          const frames = Math.min(step, frameCount - done);
          const block = await this.#source.read(
            this.#signal,
            {
              frameOffset: frameOffset + done,
              frameCount: frames,
              elementOffset: from,
              elementCount: span,
            },
            signal,
          );
          time.set(block.time, done);
          for (const item of run) {
            const column = positions[elementOffset + item]! - from;
            for (let f = 0; f < frames; f++)
              values[(done + f) * elementCount + item] = block.values[f * block.stride + column]!;
          }
        }
      }),
    );
    return { time, values, stride: elementCount };
  }
}

/** Check that a block read from elsewhere is the window asked for. */
function checkBlock(block: Series.Block, window: Series.Window): void {
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
 * Check a read of one of `signals` signals within `frames` committed frames and `elements`
 * elements; true when it asks for no frame at all.
 */
function checkRead(
  signalIndex: number,
  window: Series.Window,
  signals: number,
  frames: number,
  elements: number,
): boolean {
  index(signalIndex, 'signal');
  if (signalIndex >= signals) throw new RangeError(`signal ${signalIndex} out of range`);
  const { frameOffset, frameCount, elementOffset, elementCount } = window;
  for (const [key, value] of Object.entries({
    frameOffset,
    frameCount,
    elementOffset,
    elementCount,
  }))
    index(value, key);
  if (frameOffset + frameCount > frames || elementOffset + elementCount > elements)
    throw new RangeError('sample window exceeds the committed series');
  return frameCount === 0;
}

/** Where class element `element` sits on a sparse axis, or -1 when it holds none. */
function positionOf(elements: Uint32Array, element: number): number {
  let lo = 0,
    hi = elements.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (elements[mid]! < element) lo = mid + 1;
    else hi = mid;
  }
  return elements[lo] === element ? lo : -1;
}

/**
 * Check a series' shape and published state without reading samples: what a renderer runs on a
 * series it is given, however it was made.
 *
 * @throws TypeError or RangeError naming the first thing that is wrong.
 */
export function validateSeries(series: Series): void {
  if (!series || typeof series !== 'object') throw new TypeError('series must be an object');
  signalIds(series.signals);
  index(series.elementCount, 'elementCount');
  checkState(series.state, series.signals.length);
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

/** Validate a state before publishing it or accepting a foreign series. */
function checkState(state: Series.State, signalCount: number): void {
  if (!state || typeof state !== 'object') throw new TypeError('series state must be an object');
  index(state.frameCount, 'frameCount');
  if (typeof state.live !== 'boolean') throw new TypeError('series live must be a boolean');
  if (state.timeRange !== null) validateDomain(state.timeRange, 'series timeRange');
  if ((state.frameCount === 0) !== (state.timeRange === null))
    throw new RangeError('series timeRange must be null exactly when there are no frames');
  const ranges = state.ranges;
  if (ranges !== null) {
    if (!(ranges instanceof Float64Array) || ranges.length !== signalCount * 2)
      throw new RangeError('series ranges must contain one f64 pair per signal');
    for (let i = 0; i < ranges.length; i += 2) {
      if (Number.isNaN(ranges[i]) && Number.isNaN(ranges[i + 1])) continue;
      validateDomain([ranges[i]!, ranges[i + 1]!], 'series range');
    }
  }
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
