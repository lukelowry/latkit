/**
 * Packed signals over one element axis and time: the one numeric container, shaped exactly as
 * `@latkit/monitor` loads it.
 */

/**
 * Signal-major samples over one element axis and one time axis.
 *
 * @remarks
 * `values[signal * elementCount * time.length + frame * elementCount + element]`; each signal's
 * block is frame-major and contiguous. `NaN` marks a missing sample. `ranges` holds per-signal
 * finite `[min, max]` pairs, `NaN` when a signal has no finite sample. A `Series` is structurally a
 * `@latkit/monitor` `Series`.
 */
export interface Series {
  readonly time: Float64Array;
  readonly elementCount: number;
  readonly signalCount: number;
  readonly values: Float32Array;
  readonly ranges: Float32Array;
  /** Frames ready to read; omitted means every frame. */
  readonly validFrames?: number;
}

/** Pack per-signal frame-major arrays into one buffer. Internal: `collect` is the public entry. */
export function packSeries(
  time: Float64Array,
  elementCount: number,
  signals: readonly Float32Array[],
): Series {
  const stride = elementCount * time.length;
  const values = new Float32Array(signals.length * stride);
  const ranges = new Float32Array(signals.length * 2);
  signals.forEach((block, signal) => {
    if (block.length !== stride)
      throw new Error(`signal ${signal} has ${block.length} values, expected ${stride}`);
    values.set(block, signal * stride);
    let lo = Infinity;
    let hi = -Infinity;
    for (const value of block) {
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    ranges[signal * 2] = lo <= hi ? lo : NaN;
    ranges[signal * 2 + 1] = lo <= hi ? hi : NaN;
  });
  return { time, elementCount, signalCount: signals.length, values, ranges };
}

/** A zero-copy view of one signal at one frame, `elementCount` long. */
export function sample(series: Series, signal: number, frame: number): Float32Array {
  const { elementCount, time, values } = series;
  if (!Number.isInteger(signal) || signal < 0 || signal >= series.signalCount) {
    throw new RangeError(`signal ${signal} out of range`);
  }
  if (!Number.isInteger(frame) || frame < 0 || frame >= time.length) {
    throw new RangeError(`frame ${frame} out of range`);
  }
  const start = signal * elementCount * time.length + frame * elementCount;
  return values.subarray(start, start + elementCount);
}

/**
 * The largest frame whose time is at most `t`, within the first `head` frames.
 *
 * @remarks
 * `time` must be non-decreasing. At a repeated time this selects the last frame carrying it, so an
 * event that emits two samples at one instant resolves to its post-event state. Before the first
 * frame the answer is `0`; at or after the last it is `head - 1`.
 */
export function frameAt(time: Float64Array, t: number, head = time.length): number {
  const n = Math.min(head, time.length);
  if (n <= 1 || t < time[0]!) return 0;
  if (t >= time[n - 1]!) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (time[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
