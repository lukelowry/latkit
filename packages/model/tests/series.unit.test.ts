import { describe, expect, it } from 'vitest';

import { collect, frameAt, sample, type RunFrames } from '../src/index.js';

function batch(time: number[], values: number[], signalCount = 2, elementCount = 2): RunFrames {
  return {
    classId: 'bus',
    elementCount,
    signalCount,
    time: Float64Array.from(time),
    values: Float32Array.from(values),
  };
}

describe('collect', () => {
  it('folds frame-major batches into a signal-major series with ranges', () => {
    // frame 0: s0 = [1, 2], s1 = [10, 20]; frame 1: s0 = [3, NaN], s1 = [30, 40]
    const series = collect([batch([0], [1, 2, 10, 20]), batch([1], [3, NaN, 30, 40])]);
    expect(series.elementCount).toBe(2);
    expect(series.signalCount).toBe(2);
    expect(Array.from(series.time)).toEqual([0, 1]);
    expect(Array.from(series.values)).toEqual([1, 2, 3, NaN, 10, 20, 30, 40]);
    expect(Array.from(series.ranges)).toEqual([1, 3, 10, 40]);
    expect(Array.from(sample(series, 1, 1))).toEqual([30, 40]);
  });

  it('is empty for no batches and NaN-ranged for an all-missing signal', () => {
    const empty = collect([]);
    expect(empty.time.length).toBe(0);
    expect(empty.signalCount).toBe(0);
    const missing = collect([batch([0], [NaN, NaN, 1, 1])]);
    expect(Array.from(missing.ranges)).toEqual([NaN, NaN, 1, 1]);
  });

  it('rejects inconsistent batches', () => {
    expect(() => collect([batch([0], [1, 2, 3, 4]), batch([1], [1, 2], 1)])).toThrow(/disagrees/);
    expect(() => collect([batch([0, 1], [1, 2, 3, 4])])).toThrow(/carries 4 values for 2 frames/);
  });
});

async function* stream(batches: readonly RunFrames[]): AsyncIterable<RunFrames> {
  for (const entry of batches) {
    await Promise.resolve();
    yield entry;
  }
}

describe('collect from a stream', () => {
  const batches = [batch([0], [1, 2, 10, 20]), batch([1], [3, NaN, 30, 40])];

  it('fills a preallocated series when the frame count is known', async () => {
    const series = await collect(stream(batches), 2);
    expect(Array.from(series.time)).toEqual([0, 1]);
    expect(Array.from(series.values)).toEqual([1, 2, 3, NaN, 10, 20, 30, 40]);
    expect(Array.from(series.ranges)).toEqual([1, 3, 10, 40]);
  });

  it('holds the batches and folds at the end when the count is unknown', async () => {
    expect(await collect(stream(batches))).toEqual(collect(batches));
    expect((await collect(stream([]))).signalCount).toBe(0);
  });

  it('rejects a stream that carries other than the expected frames', async () => {
    await expect(collect(stream(batches.slice(0, 1)), 2)).rejects.toThrow(/received 1 of 2 frames/);
    await expect(collect(stream(batches), 1)).rejects.toThrow(/overruns the 1 frames/);
    await expect(collect(stream([]), 3)).rejects.toThrow(/received 0 of 3 frames/);
    await expect(collect(stream([]), -1)).rejects.toThrow(/non-negative integer/);
    expect((await collect(stream([]), 0)).time.length).toBe(0);
  });

  it('rejects inconsistent batches as the array form does', async () => {
    const mixed = [batch([0], [1, 2, 3, 4]), batch([1], [1, 2], 1)];
    await expect(collect(stream(mixed), 2)).rejects.toThrow(/disagrees/);
    await expect(collect(stream([batch([0, 1], [1, 2, 3, 4])]), 2)).rejects.toThrow(/carries/);
  });
});

describe('sample', () => {
  it('views one signal at one frame and refuses out-of-range indices', () => {
    const series = collect([batch([0, 1], [1, 2, 10, 20, 3, 4, 30, 40])]);
    const view = sample(series, 0, 1);
    expect(Array.from(view)).toEqual([3, 4]);
    expect(view.buffer).toBe(series.values.buffer);
    expect(() => sample(series, 2, 0)).toThrow(RangeError);
    expect(() => sample(series, 0, 2)).toThrow(RangeError);
  });
});

describe('frameAt', () => {
  const time = Float64Array.of(0, 1, 1, 2, 5);

  it('finds the largest frame at or before t, the last of a repeated time', () => {
    expect(frameAt(time, -1)).toBe(0);
    expect(frameAt(time, 0.5)).toBe(0);
    expect(frameAt(time, 1)).toBe(2);
    expect(frameAt(time, 4.9)).toBe(3);
    expect(frameAt(time, 5)).toBe(4);
    expect(frameAt(time, 99)).toBe(4);
  });

  it('honors a head shorter than the axis', () => {
    expect(frameAt(time, 99, 2)).toBe(1);
    expect(frameAt(time, 1, 1)).toBe(0);
    expect(frameAt(new Float64Array(0), 3)).toBe(0);
  });
});
