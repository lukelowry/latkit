import { describe, expect, it } from 'vitest';
import { collect, createSeries, sample, type RunFrames } from '../src/index.js';

function batch(time: number[], values: number[], signalCount = 2, elementCount = 2): RunFrames {
  return {
    resultId: 'base',
    classId: 'bus',
    elementCount,
    signalCount,
    time: Float64Array.from(time),
    values: Float32Array.from(values),
  };
}
const window = (frameOffset: number, frameCount: number, elementOffset = 0, elementCount = 2) => ({
  frameOffset,
  frameCount,
  elementOffset,
  elementCount,
});
async function* stream(batches: RunFrames[]) {
  yield* batches;
}

describe('series', () => {
  it('reads interleaved batches without transposing them and packs only reads crossing batches', async () => {
    const first = batch([0, 1], [1, 2, 10, 20, 3, 4, 30, 40]);
    const series = collect([first, batch([2], [5, NaN, 50, 60])]);
    const block = await series.read(1, window(0, 2));
    expect(block.stride).toBe(4);
    expect(block.values.buffer).toBe(first.values.buffer);
    expect(Array.from(await sample(series, 1, 1))).toEqual([30, 40]);
    const spanning = await series.read(0, window(1, 2));
    expect([...spanning.time]).toEqual([1, 2]);
    expect([...spanning.values]).toEqual([3, 4, 5, NaN]);
    expect(spanning.stride).toBe(2);
    expect([...series.state.ranges!]).toEqual([1, 5, 10, 60]);
  });
  it('publishes metadata only after committing an append and retains the previous state', async () => {
    const series = createSeries({ elementCount: 2, signalCount: 2 });
    const before = series.state;
    let published = before;
    const off = series.on('append', () => {
      published = series.state;
    });
    series.append(batch([0], [1, 2, 10, 20]));
    expect(before.frameCount).toBe(0);
    expect([...before.ranges!]).toEqual([NaN, NaN, NaN, NaN]);
    expect(published).toBe(series.state);
    expect(published.timeRange).toEqual([0, 0]);
    expect(await sample(series, 0, 0)).toEqual(Float32Array.of(1, 2));
    off();
  });
  it('borrows signal-major input and retains f64 differences across appends', async () => {
    const base = 1e12,
      delta = 0.01;
    const values = Float64Array.of(base, base + delta, 3, 4);
    const series = createSeries({
      elementCount: 1,
      signalCount: 2,
      time: Float64Array.of(0, 1),
      values,
    });
    expect((await series.read(0, window(0, 2, 0, 1))).values.buffer).toBe(values.buffer);
    series.append({ ...batch([2], [0, 0], 2, 1), values: Float64Array.of(base + 2 * delta, 5) });
    expect((await sample(series, 0, 2))[0]).toBe(base + 2 * delta);
    expect(series.state.ranges![1]).toBe(base + 2 * delta);
  });
  it('locates complete repeated timestamps across batches at a captured head', async () => {
    const series = createSeries({ elementCount: 1, signalCount: 1 });
    series.append(batch([0, 1, 1], [1, 2, 3], 1, 1));
    const head = series.state.frameCount;
    series.append(batch([1, 2], [4, 5], 1, 1));
    expect(await series.locate([1, 1], head)).toEqual([1, 3]);
    expect(await series.locate([1, 1], 5)).toEqual([1, 4]);
    expect(await series.locate([-1, -1], 5)).toEqual([0, 0]);
    expect(await series.locate([3, 3], 5)).toEqual([5, 5]);
    expect(await series.locate([0.5, 0.8], 5)).toEqual([1, 1]);
  });
  it('rejects mixed identities and invalid time without changing published data', () => {
    const series = createSeries({ elementCount: 2, signalCount: 2 });
    series.append(batch([1], [1, 2, 3, 4]));
    const state = series.state;
    expect(() => series.append({ ...batch([2], [1, 2, 3, 4]), resultId: 'other' })).toThrow(
      /different results/,
    );
    expect(() => series.append({ ...batch([2], [1, 2, 3, 4]), classId: 'other' })).toThrow(
      /different results/,
    );
    expect(() => series.append(batch([0], [1, 2, 3, 4]))).toThrow(/nondecreasing/);
    expect(() => series.append(batch([Infinity], [1, 2, 3, 4]))).toThrow(/finite/);
    expect(series.state).toBe(state);
  });
  it('validates read bounds and cancellation', async () => {
    const series = collect([batch([0], [1, 2, 3, 4])]);
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
  });
  it('keeps sparse class indices stable and ignores all nonfinite values in ranges', () => {
    const series = createSeries({
      elementCount: 2,
      signalCount: 1,
      elements: Uint32Array.of(3, 500),
    });
    series.append(batch([0, 1], [NaN, Infinity, -Infinity, 7], 1));
    expect(series.elements).toEqual(Uint32Array.of(3, 500));
    expect([...series.state.ranges!]).toEqual([7, 7]);
    expect(() =>
      createSeries({ elementCount: 2, signalCount: 1, elements: Uint32Array.of(3, 3) }),
    ).toThrow(/unique/);
  });
});

describe('collect', () => {
  it('validates identity, shape, and expected frame count for arrays and streams', async () => {
    const batches = [batch([0], [1, 2, 3, 4]), batch([1], [5, 6, 7, 8])];
    expect((await collect(stream(batches), 2)).state.frameCount).toBe(2);
    await expect(collect(stream(batches), 1)).rejects.toThrow(/more than/);
    await expect(collect(stream(batches), 3)).rejects.toThrow(/received 2 of 3/);
    await expect(collect(stream([]), -1)).rejects.toThrow(/non-negative/);
    expect(collect([]).state.frameCount).toBe(0);
    expect(() => collect([batch([0], [1])])).toThrow(/carries/);
    expect(() => collect([batches[0]!, batch([1], [1, 2], 1)])).toThrow(/disagrees/);
    expect(() => collect([{ ...batches[0]!, resultId: '' }])).toThrow(/resultId/);
    expect(() => collect([batches[0]!, { ...batches[1]!, resultId: 'other' }])).toThrow(
      /different results/,
    );
  });
});

it('collects sparse batches without losing class indices and rejects a changed element axis', async () => {
  const first = { ...batch([0], [1, 2], 1), elements: Uint32Array.of(3, 90000) };
  const series = await collect(stream([first, { ...first, time: Float64Array.of(1) }]));
  expect(() => collect([first, batch([1], [3, 4], 1)])).toThrow(/sparse elements/);
  expect(series.elements).toEqual(first.elements);
  expect(await sample(series, 0, 1)).toEqual(Float32Array.of(1, 2));
  expect(() => collect([first, { ...first, elements: Uint32Array.of(3, 90001) }])).toThrow(
    /elements/,
  );
});
