import { describe, expect, it, vi } from 'vitest';

import { openRecording, type Series } from '../src/index.js';
import { sourceOf } from '../src/recording.js';
import type { RunFrames } from '../src/run.js';
import { sampleModel } from './fixture.js';

/** Frames at `time`: buses record Vm over three elements, generators P over two. */
function block(time: number[], values: Partial<Record<'bus' | 'gen', number[]>>): RunFrames {
  return {
    time: Float64Array.from(time),
    values: Object.fromEntries(
      Object.entries(values).map(([classId, list]) => [classId, Float32Array.from(list)]),
    ),
  };
}

/** The next item `iterator` yields. */
async function take<T>(iterator: AsyncIterator<T>): Promise<T> {
  const result = await iterator.next();
  if (result.done) throw new Error('the iteration ended');
  return result.value;
}

/** Every value of signal 0 of `series`, frame after frame. */
async function values(series: Series): Promise<number[]> {
  const { frameCount } = series.state;
  const read = await series.read(0, {
    frameOffset: 0,
    frameCount,
    elementOffset: 0,
    elementCount: series.elementCount,
  });
  const out: number[] = [];
  for (let frame = 0; frame < frameCount; frame++)
    out.push(
      ...read.values.subarray(frame * read.stride, frame * read.stride + series.elementCount),
    );
  return out;
}

describe('recording', () => {
  it('declares what it covers and records every class that records a signal', async () => {
    const recording = sampleModel().record({ id: 'run', span: [0, 10], expectedFrames: 100 });
    expect(recording).toMatchObject({
      id: 'run',
      label: 'run',
      span: [0, 10],
      expectedFrames: 100,
      classes: ['bus', 'gen'],
    });
    expect(recording.state).toEqual({ frameCount: 0, timeRange: null, live: true });
    const bus = await recording.series('bus');
    expect(bus).toMatchObject({ signals: ['Vm'], elementCount: 3 });
    expect((await recording.series('gen'))!.signals).toEqual(['P']);
    expect(await recording.series('branch')).toBeNull();
    expect(await recording.series('nope')).toBeNull();
    expect(await recording.series('bus')).toBe(bus);
    await expect(recording.series('bus', AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(sampleModel().record({ id: 'bare', label: 'Bare' })).toMatchObject({
      label: 'Bare',
      span: null,
      expectedFrames: null,
    });
  });

  it('commits every class on one clock, a class a block leaves out reading NaN there', async () => {
    const recording = sampleModel().record({ id: 'run' });
    const bus = (await recording.series('bus'))!;
    const gen = (await recording.series('gen'))!;
    recording.append(block([0, 1], { bus: [1, 2, 3, 4, 5, 6], gen: [10, 20, 30, 40] }));
    recording.append(block([2], { bus: [7, 8, 9] }));
    expect(recording.state).toEqual({ frameCount: 3, timeRange: [0, 2], live: true });
    for (const series of [bus, gen]) expect(series.state.frameCount).toBe(3);
    expect(await values(bus)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await values(gen)).toEqual([10, 20, 30, 40, NaN, NaN]);
    const missing = await gen.read(0, {
      frameOffset: 2,
      frameCount: 1,
      elementOffset: 0,
      elementCount: 2,
    });
    expect([...missing.values]).toEqual([NaN, NaN]);
    expect([...gen.state.ranges!]).toEqual([10, 40]);
  });

  it('finds the frame at a time on its own clock, and the time of a frame', () => {
    const recording = sampleModel().record({ id: 'run' });
    expect(recording.frameAt(5)).toBe(-1);
    recording.append(block([0, 1, 1], { bus: [0, 0, 0, 1, 1, 1, 2, 2, 2] }));
    recording.append(block([2.5], {}));
    expect(recording.frameAt(-4)).toBe(0);
    expect(recording.frameAt(0.5)).toBe(0);
    expect(recording.frameAt(1)).toBe(2);
    expect(recording.frameAt(2.5)).toBe(3);
    expect(recording.frameAt(99)).toBe(3);
    expect(() => recording.frameAt(Number.NaN)).toThrow(RangeError);
    expect([0, 1, 2, 3].map((frame) => recording.timeAt(frame))).toEqual([0, 1, 1, 2.5]);
    expect(() => recording.timeAt(4)).toThrow(/not committed/);
    expect(() => recording.timeAt(0.5)).toThrow(RangeError);
  });

  it('changes every series before itself, once per append and once when sealed', async () => {
    const recording = sampleModel().record({ id: 'run' });
    const bus = (await recording.series('bus'))!;
    const heard: string[] = [];
    bus.on('change', () => heard.push(`bus:${bus.state.frameCount}`));
    recording.on('change', () => heard.push(`recording:${recording.state.frameCount}`));
    recording.append(block([0], { bus: [1, 2, 3] }));
    recording.append(block([], {}));
    recording.seal();
    recording.seal();
    expect(heard).toEqual(['bus:1', 'recording:1', 'bus:1', 'recording:1']);
    expect(recording.state.live).toBe(false);
    expect(bus.state.live).toBe(false);
    expect(() => recording.append(block([1], { bus: [1, 2, 3] }))).toThrow(/sealed/);
  });

  it('refuses a block that does not fit, changing nothing', () => {
    const recording = sampleModel().record({ id: 'run' });
    recording.append(block([1], { bus: [1, 2, 3] }));
    const state = recording.state;
    const changed = vi.fn();
    recording.on('change', changed);
    expect(() => recording.append(block([2], { bus: [1, 2] }))).toThrow(/carry 2 values/);
    expect(() => recording.append(block([2], { branch: [1, 2] } as never))).toThrow(
      /does not record class 'branch'/,
    );
    expect(() => recording.append(block([0], { bus: [1, 2, 3] }))).toThrow(/nondecreasing/);
    expect(() => recording.append({ time: Float64Array.of(2), values: null as never })).toThrow(
      /map class ids/,
    );
    expect(() => recording.append(null as never)).toThrow(/must be an object/);
    expect(recording.state).toBe(state);
    expect(changed).not.toHaveBeenCalled();
  });

  it('refuses a header it cannot hold', () => {
    const model = sampleModel();
    expect(() => model.record({ id: '' })).toThrow(/id must be non-empty/);
    expect(() => model.record({ id: 'run', label: 3 as never })).toThrow(/label must be a string/);
    expect(() => model.record({ id: 'run', span: [2, 1] })).toThrow(RangeError);
    expect(() => model.record({ id: 'run', expectedFrames: -1 })).toThrow(/expectedFrames/);
  });
});

describe('recording.source and openRecording', () => {
  it('describes the recording, and hands out windows the caller owns', async () => {
    const recording = sampleModel().record({ id: 'run', label: 'Run', span: [0, 9] });
    recording.append(block([0, 1], { bus: [1, 2, 3, 4, 5, 6], gen: [10, 20, 30, 40] }));
    const source = recording.source();

    expect(await source.describe()).toEqual({
      id: 'run',
      label: 'Run',
      span: [0, 9],
      expectedFrames: null,
      classes: [
        { classId: 'bus', signals: ['Vm'], elementCount: 3 },
        { classId: 'gen', signals: ['P'], elementCount: 2 },
      ],
    });
    const bus = (await recording.series('bus'))!;
    const lent = await bus.read(0, {
      frameOffset: 0,
      frameCount: 2,
      elementOffset: 1,
      elementCount: 2,
    });
    const owned = await source.read('bus', 0, {
      frameOffset: 0,
      frameCount: 2,
      elementOffset: 1,
      elementCount: 2,
    });
    expect(owned).toEqual({
      time: Float64Array.of(0, 1),
      values: Float32Array.of(2, 3, 5, 6),
      stride: 2,
    });
    expect(owned.values.buffer).not.toBe(lent.values.buffer);
    expect(owned.time.buffer).not.toBe(lent.time.buffer);
    await expect(
      source.read('branch', 0, {
        frameOffset: 0,
        frameCount: 1,
        elementOffset: 0,
        elementCount: 1,
      }),
    ).rejects.toThrow("recording 'run' has no class 'branch'");
  });

  it('streams its clock from the first frame, then each change, until the seal', async () => {
    const recording = sampleModel().record({ id: 'run' });
    recording.append(block([0, 1], { bus: [1, 2, 3, 4, 5, 6] }));
    const changes = recording.source().changes()[Symbol.asyncIterator]();

    const first = await take(changes);
    expect([...first.time]).toEqual([0, 1]);
    expect(first.live).toBe(true);
    expect([...first.ranges['bus']!]).toEqual([1, 6]);
    expect([...first.ranges['gen']!]).toEqual([NaN, NaN]);

    const next = take(changes);
    recording.append(block([2], { gen: [7, 8] }));
    const second = await next;
    expect([...second.time]).toEqual([2]);
    expect([...second.ranges['gen']!]).toEqual([7, 8]);

    recording.seal();
    const last = await take(changes);
    expect(last.time.length).toBe(0);
    expect(last.live).toBe(false);
    expect((await changes.next()).done).toBe(true);
  });

  it('refuses to describe a class the recording lists but cannot resolve', async () => {
    const recording = sampleModel().record({ id: 'run' });
    const broken = { ...recording, series: async () => null };
    const source = sourceOf(broken);
    await expect(source.describe()).rejects.toThrow("recording 'run' has no series for 'bus'");
  });

  it('ends its changes when their signal aborts', async () => {
    const recording = sampleModel().record({ id: 'run' });
    const controller = new AbortController();
    const changes = recording.source().changes(controller.signal)[Symbol.asyncIterator]();
    await changes.next();
    const next = changes.next();
    controller.abort();
    expect((await next).done).toBe(true);
  });

  it('opens a recording held elsewhere, its clock at hand and its samples read on demand', async () => {
    const origin = sampleModel().record({ id: 'run', expectedFrames: 10 });
    origin.append(block([0, 1, 1], { bus: [1, 2, 3, 4, 5, 6, 7, 8, 9], gen: [1, 2, 3, 4, 5, 6] }));
    const source = origin.source();
    const read = vi.spyOn(source, 'read');

    const mirror = await openRecording(source);
    expect(mirror).toMatchObject({
      id: 'run',
      label: 'run',
      expectedFrames: 10,
      classes: ['bus', 'gen'],
    });
    expect(mirror.state).toEqual({ frameCount: 3, timeRange: [0, 1], live: true });
    expect(mirror.frameAt(1)).toBe(2);
    expect(mirror.timeAt(1)).toBe(1);
    const bus = (await mirror.series('bus'))!;
    expect(bus).toMatchObject({ signals: ['Vm'], elementCount: 3 });
    expect([...bus.state.ranges!]).toEqual([1, 9]);
    expect(await bus.locate([1, 1], 3)).toEqual([1, 3]);
    expect(read).not.toHaveBeenCalled();
    expect(await values(bus)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(read).toHaveBeenCalledOnce();
    mirror.close();
  });

  it('follows the recording it mirrors, every series changing before it', async () => {
    const origin = sampleModel().record({ id: 'run' });
    const mirror = await openRecording(origin.source());
    expect(mirror.state).toEqual({ frameCount: 0, timeRange: null, live: true });
    const gen = (await mirror.series('gen'))!;
    const heard: string[] = [];
    gen.on('change', () => heard.push(`gen:${gen.state.frameCount}`));
    mirror.on('change', () => heard.push(`recording:${mirror.state.frameCount}`));

    origin.append(block([0, 2], { gen: [1, 2, 3, 4] }));
    await vi.waitFor(() => expect(mirror.state.frameCount).toBe(2));
    expect(heard).toEqual(['gen:2', 'recording:2']);
    expect([...gen.state.ranges!]).toEqual([1, 4]);
    expect(mirror.timeAt(1)).toBe(2);

    origin.seal();
    await vi.waitFor(() => expect(mirror.state.live).toBe(false));
    expect(gen.state.live).toBe(false);
    mirror.close();
  });

  it('closes its source and stops following when closed', async () => {
    const origin = sampleModel().record({ id: 'run' });
    const source = origin.source();
    const close = vi.fn();
    const mirror = await openRecording({ ...source, close });
    mirror.close();
    expect(close).toHaveBeenCalledOnce();
    origin.append(block([0], { bus: [1, 2, 3] }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mirror.state.frameCount).toBe(0);
  });

  it('refuses a source that describes an invalid recording or sends a bad change', async () => {
    const origin = sampleModel().record({ id: 'run' });
    const source = origin.source();
    const described = await source.describe();
    const close = vi.fn();
    const describing = (value: unknown) => ({
      ...source,
      close,
      describe: async () => value as typeof described,
    });
    await expect(openRecording(describing({ ...described, id: '' }))).rejects.toThrow(
      'recording id must be non-empty',
    );
    await expect(
      openRecording(
        describing({ ...described, classes: [described.classes[0], described.classes[0]] }),
      ),
    ).rejects.toThrow('name each class once');
    await expect(
      openRecording(
        describing({ ...described, classes: [{ classId: 'bus', signals: [], elementCount: -1 }] }),
      ),
    ).rejects.toThrow(RangeError);
    expect(close).toHaveBeenCalled();

    const changing = (change: unknown) => ({
      ...source,
      async *changes() {
        yield change as never;
      },
    });
    await expect(openRecording(changing({ time: [0], live: true, ranges: {} }))).rejects.toThrow(
      'frames require f64 time',
    );
    await expect(
      openRecording(
        changing({ time: Float64Array.of(0), live: true, ranges: { bus: Float64Array.of(1) } }),
      ),
    ).rejects.toThrow('one f64 pair per signal');
    await expect(
      openRecording({
        ...source,
        // eslint-disable-next-line require-yield
        async *changes() {
          return;
        },
      }),
    ).rejects.toThrow('ended before its clock');
    await expect(openRecording(source, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('refuses a window a source returns that is not the one asked for', async () => {
    const origin = sampleModel().record({ id: 'run' });
    origin.append(block([0], { bus: [1, 2, 3] }));
    const source = origin.source();
    const mirror = await openRecording({
      ...source,
      read: async () => ({ time: Float64Array.of(0, 1), values: new Float32Array(3), stride: 3 }),
    });
    const bus = (await mirror.series('bus'))!;
    await expect(
      bus.read(0, { frameOffset: 0, frameCount: 1, elementOffset: 0, elementCount: 3 }),
    ).rejects.toThrow('invalid samples block');
    mirror.close();
  });
});
