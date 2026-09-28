import { describe, expect, it, vi } from 'vitest';

import { Series, validateSeries } from '../src/index.js';
import { Clock } from '../src/series.js';

/** Frames at `time` over two elements and two signals, frame-major as a run appends them. */
function frames(time: number[], values: number[]) {
  return { time: Float64Array.from(time), values: Float32Array.from(values) };
}
const window = (frameOffset: number, frameCount: number, elementOffset = 0, elementCount = 2) => ({
  frameOffset,
  frameCount,
  elementOffset,
  elementCount,
});
/** One signal's values at one frame. */
async function at(series: Series, signal: number, frame: number): Promise<number[]> {
  const block = await series.read(signal, window(frame, 1, 0, series.elementCount));
  return Array.from(block.values.subarray(0, series.elementCount));
}

describe('series', () => {
  it('names its signals and reads appends without transposing them, packing only reads across them', async () => {
    const series = Series.create({ signals: ['P', 'Q'], elementCount: 2 });
    expect(series.signals).toEqual(['P', 'Q']);
    expect(Object.isFrozen(series.signals)).toBe(true);
    const first = frames([0, 1], [1, 2, 10, 20, 3, 4, 30, 40]);
    series.append(first);
    series.append(frames([2], [5, NaN, 50, 60]));
    const block = await series.read(1, window(0, 2));
    expect(block.stride).toBe(4);
    expect(block.values.buffer).toBe(first.values.buffer);
    expect(await at(series, 1, 1)).toEqual([30, 40]);
    const spanning = await series.read(0, window(1, 2));
    expect([...spanning.time]).toEqual([1, 2]);
    expect([...spanning.values]).toEqual([3, 4, 5, NaN]);
    expect(spanning.stride).toBe(2);
    expect([...series.state.ranges!]).toEqual([1, 5, 10, 60]);
  });

  it('publishes a state only once an append commits, and keeps the one before', async () => {
    const series = Series.create({ signals: ['P', 'Q'], elementCount: 2 });
    const before = series.state;
    let published = before;
    const off = series.on('change', () => (published = series.state));
    series.append(frames([0], [1, 2, 10, 20]));
    expect(before.frameCount).toBe(0);
    expect([...before.ranges!]).toEqual([NaN, NaN, NaN, NaN]);
    expect(published).toBe(series.state);
    expect(published).toMatchObject({ frameCount: 1, timeRange: [0, 0], live: true });
    expect(await at(series, 0, 0)).toEqual([1, 2]);
    off();
  });

  it('seals once: live turns false, listeners hear it, and nothing appends after', () => {
    const series = Series.create({ signals: ['P'], elementCount: 1 });
    series.append({ time: Float64Array.of(0), values: Float32Array.of(1) });
    const changed = vi.fn();
    series.on('change', changed);
    const state = series.state;
    series.seal();
    series.seal();
    expect(changed).toHaveBeenCalledOnce();
    expect(series.state).toMatchObject({ frameCount: 1, live: false });
    expect(state.live).toBe(true);
    expect(() => series.append({ time: Float64Array.of(1), values: Float32Array.of(2) })).toThrow(
      /sealed/,
    );
  });

  it('borrows signal-major input and retains f64 differences across appends', async () => {
    const base = 1e12,
      delta = 0.01;
    const values = Float64Array.of(base, base + delta, 3, 4);
    const series = Series.create({
      signals: ['a', 'b'],
      elementCount: 1,
      time: Float64Array.of(0, 1),
      values,
    });
    expect((await series.read(0, window(0, 2, 0, 1))).values.buffer).toBe(values.buffer);
    series.append({ time: Float64Array.of(2), values: Float64Array.of(base + 2 * delta, 5) });
    expect((await at(series, 0, 2))[0]).toBe(base + 2 * delta);
    expect(series.state.ranges![1]).toBe(base + 2 * delta);
  });

  it('locates complete repeated timestamps across appends at a captured head', async () => {
    const series = Series.create({ signals: ['a'], elementCount: 1 });
    series.append({ time: Float64Array.of(0, 1, 1), values: Float32Array.of(1, 2, 3) });
    const head = series.state.frameCount;
    series.append({ time: Float64Array.of(1, 2), values: Float32Array.of(4, 5) });
    expect(await series.locate([1, 1], head)).toEqual([1, 3]);
    expect(await series.locate([1, 1], 5)).toEqual([1, 4]);
    expect(await series.locate([-1, -1], 5)).toEqual([0, 0]);
    expect(await series.locate([3, 3], 5)).toEqual([5, 5]);
    expect(await series.locate([0.5, 0.8], 5)).toEqual([1, 1]);
    await expect(series.locate([0, 1], 6)).rejects.toThrow(/exceeds/);
  });

  it('rejects an invalid append without changing published data', () => {
    const series = Series.create({ signals: ['P', 'Q'], elementCount: 2 });
    series.append(frames([1], [1, 2, 3, 4]));
    const state = series.state;
    expect(() => series.append(frames([0], [1, 2, 3, 4]))).toThrow(/nondecreasing/);
    expect(() => series.append(frames([Infinity], [1, 2, 3, 4]))).toThrow(/finite/);
    expect(() => series.append(frames([2], [1, 2, 3]))).toThrow(/carry 3 values for 1 frames/);
    expect(() =>
      series.append({ time: [2] as unknown as Float64Array, values: Float32Array.of(1, 2, 3, 4) }),
    ).toThrow(/f64 time/);
    expect(() =>
      series.append({ time: Float64Array.of(2), values: [1, 2, 3, 4] as unknown as Float32Array }),
    ).toThrow(/f32 or f64 values/);
    series.append(frames([], []));
    expect(series.state).toBe(state);
  });

  it('validates read bounds and cancellation', async () => {
    const series = Series.create({ signals: ['P', 'Q'], elementCount: 2 });
    series.append(frames([0], [1, 2, 3, 4]));
    await expect(series.read(2, window(0, 1))).rejects.toThrow(/signal/);
    await expect(series.read(0, window(1, 1))).rejects.toThrow(/exceeds/);
    await expect(series.read(0, window(0, 1, 1, 2))).rejects.toThrow(/exceeds/);
    await expect(series.read(0, window(-1, 1))).rejects.toThrow(/nonnegative/);
    await expect(series.read(0, window(0, 1), AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(series.locate([0, 1], 1, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(await series.read(0, window(0, 0))).toMatchObject({ stride: 2 });
    expect([...(await series.read(0, window(0, 1, 0, 0))).time]).toEqual([0]);
  });

  it('keeps sparse class indices stable and ignores every nonfinite value in ranges', () => {
    const series = Series.create({
      signals: ['a'],
      elementCount: 2,
      elements: Uint32Array.of(3, 500),
    });
    series.append({
      time: Float64Array.of(0, 1),
      values: Float32Array.of(NaN, Infinity, -Infinity, 7),
    });
    expect(series.elements).toEqual(Uint32Array.of(3, 500));
    expect([...series.state.ranges!]).toEqual([7, 7]);
    expect(() =>
      Series.create({ signals: ['a'], elementCount: 2, elements: Uint32Array.of(3, 3) }),
    ).toThrow(/unique/);
  });

  it('refuses signal ids that are missing, empty, or repeated', () => {
    expect(() => Series.create({ signals: 2 as unknown as string[], elementCount: 1 })).toThrow(
      /array of ids/,
    );
    expect(() => Series.create({ signals: [''], elementCount: 1 })).toThrow(/non-empty/);
    expect(() => Series.create({ signals: ['a', 'a'], elementCount: 1 })).toThrow(/unique/);
    expect(() =>
      Series.create({ signals: ['a'], elementCount: 1, time: Float64Array.of(0) }),
    ).toThrow(/together/);
  });
});

describe('validateSeries', () => {
  const series = () => Series.create({ signals: ['a', 'b'], elementCount: 1 });
  /** A series as a plain object: what a renderer may be handed from anywhere. */
  const plain = (patch: Record<string, unknown>): Series => {
    const made = series();
    return {
      signals: made.signals,
      elementCount: made.elementCount,
      state: made.state,
      read: made.read.bind(made),
      locate: made.locate.bind(made),
      on: made.on.bind(made),
      ...patch,
    } as unknown as Series;
  };

  it('accepts what Series.create publishes and names the first field that is wrong', () => {
    expect(() => validateSeries(series())).not.toThrow();
    expect(() => validateSeries(plain({}))).not.toThrow();
    expect(() => validateSeries(null as unknown as Series)).toThrow(/must be an object/);
    expect(() => validateSeries(plain({ signals: ['a', 1] }))).toThrow(/signals/);
    expect(() => validateSeries(plain({ state: { frameCount: -1 } }))).toThrow(/frameCount/);
    expect(() => validateSeries(plain({ state: { ...series().state, live: 'yes' } }))).toThrow(
      /live must be a boolean/,
    );
    expect(() =>
      validateSeries(plain({ state: { ...series().state, timeRange: [0, 1] } })),
    ).toThrow(/timeRange must be null exactly when/);
    expect(() =>
      validateSeries(plain({ state: { ...series().state, ranges: new Float64Array(2) } })),
    ).toThrow(/one f64 pair per signal/);
    expect(() => validateSeries(plain({ read: null }))).toThrow('series.read must be a function');
  });
});

describe('Clock', () => {
  it('copies committed times across chunks', () => {
    const clock = new Clock();
    for (const chunk of [[0, 1], [2], [3, 4, 5]])
      clock.commit(clock.admit(Float64Array.from(chunk)));
    expect([...clock.slice(1, 5)]).toEqual([1, 2, 3, 4]);
    expect([...clock.slice(0, 6)]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(clock.slice(6, 6).length).toBe(0);
    expect(new Clock().slice(0, 0).length).toBe(0);
  });
});
