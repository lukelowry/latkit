import { describe, expect, it, vi } from 'vitest';

import { Recording, type Series } from '../src/index.js';
import { block, byHand, ended, Player, sampleModel } from './fixture.js';

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
  it('holds every class that records a signal, and what its engine declares', () => {
    const model = sampleModel();
    const { recording, recorder } = byHand(model, { id: 'run' });
    expect(recording.model).toBe(model);
    expect(recording).toMatchObject({
      id: 'run',
      label: 'run',
      span: null,
      expectedFrames: null,
      classes: ['bus', 'gen'],
    });
    expect(recording.state).toEqual({
      status: 'recording',
      ahead: 0,
      frameCount: 0,
      timeRange: null,
      error: null,
    });
    recorder.declare({ span: [0, 10], expectedFrames: 100 });
    expect(recording).toMatchObject({ span: [0, 10], expectedFrames: 100 });
    recorder.declare({ expectedFrames: null });
    expect(recording).toMatchObject({ span: [0, 10], expectedFrames: null });
    const bus = recording.series('bus')!;
    expect(bus).toMatchObject({ signals: ['Vm'], elementCount: 3 });
    expect(recording.series('gen')!.signals).toEqual(['P']);
    expect(recording.series('branch')).toBeNull();
    expect(recording.series('bus')).toBe(bus);
    expect(byHand(sampleModel(), { label: 'Bare' }).recording).toMatchObject({ label: 'Bare' });
  });

  it('commits every class on one clock, a class a block leaves out reading NaN there', async () => {
    const { recording, recorder } = byHand(sampleModel());
    const bus = recording.series('bus')!;
    const gen = recording.series('gen')!;
    const first = block([0, 1], { bus: [1, 2, 3, 4, 5, 6], gen: [10, 20, 30, 40] });
    recorder.append(first.time, first.values);
    const second = block([2], { bus: [7, 8, 9] });
    recorder.append(second.time, second.values);
    expect(recording.state).toMatchObject({
      frameCount: 3,
      timeRange: [0, 2],
      status: 'recording',
    });
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
    const { recording, recorder } = byHand(sampleModel());
    expect(recording.frameAt(5)).toBe(-1);
    const frames = block([0, 1, 1], { bus: [0, 0, 0, 1, 1, 1, 2, 2, 2] });
    recorder.append(frames.time, frames.values);
    recorder.append(Float64Array.of(2.5), {});
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

  it('changes every series before itself, once per append and once when it ends', async () => {
    const { recording, recorder, complete } = byHand(sampleModel());
    const bus = recording.series('bus')!;
    const heard: string[] = [];
    bus.on('change', () => heard.push(`bus:${bus.state.frameCount}`));
    recording.on('change', () =>
      heard.push(`recording:${recording.state.frameCount}:${recording.state.status}`),
    );
    const frames = block([0], { bus: [1, 2, 3] });
    recorder.append(frames.time, frames.values);
    recorder.append(new Float64Array(0), {});
    await complete();
    recording.stop();
    expect(heard).toEqual(['bus:1', 'recording:1:recording', 'bus:1', 'recording:1:complete']);
    expect(bus.state.live).toBe(false);
    expect(() => recorder.append(frames.time, frames.values)).toThrow(/ended/);
  });

  it('refuses frames that do not fit, changing nothing', () => {
    const { recording, recorder } = byHand(sampleModel());
    const frames = block([1], { bus: [1, 2, 3] });
    recorder.append(frames.time, frames.values);
    const state = recording.state;
    const changed = vi.fn();
    recording.on('change', changed);
    expect(() => recorder.append(Float64Array.of(2), { bus: Float32Array.of(1, 2) })).toThrow(
      /carry 2 values/,
    );
    expect(() => recorder.append(Float64Array.of(2), { branch: Float32Array.of(1, 2) })).toThrow(
      /does not record class 'branch'/,
    );
    expect(() => recorder.append(Float64Array.of(0), frames.values)).toThrow(/nondecreasing/);
    expect(() => recorder.append(Float64Array.of(2), null as never)).toThrow(/map class ids/);
    expect(() => recorder.append([2] as never, frames.values)).toThrow(/f64 time/);
    expect(recording.state).toBe(state);
    expect(changed).not.toHaveBeenCalled();
  });

  it('refuses what an engine declares that it cannot hold', () => {
    const { recorder } = byHand(sampleModel());
    expect(() => recorder.declare({ span: [2, 1] })).toThrow(RangeError);
    expect(() => recorder.declare({ expectedFrames: -1 })).toThrow(/expectedFrames/);
    expect(() => recorder.wait(-1)).toThrow(/ahead/);
    expect(() => recorder.log('loud' as never, 'x')).toThrow(/level and a message/);
  });

  it('keeps its engine’s log and says how it failed, keeping its frames', async () => {
    const { recording, recorder, fail } = byHand(sampleModel());
    recorder.log('info', 'start');
    recorder.log('warn', 'slow');
    const frames = block([0], { bus: [1, 2, 3] });
    recorder.append(frames.time, frames.values);
    await fail('diverged');
    expect(recording.log).toEqual([
      { level: 'info', message: 'start' },
      { level: 'warn', message: 'slow' },
    ]);
    expect(recording.state).toMatchObject({ status: 'failed', error: 'diverged', frameCount: 1 });
    recorder.log('info', 'after');
    expect(recording.log).toHaveLength(2);
  });

  it('waits its turn behind an engine’s concurrency, saying how many wait before it', async () => {
    const model = sampleModel();
    const engine = new Player([block([0], { bus: [1, 2, 3] }), block([1], { bus: [4, 5, 6] })]);
    const first = engine.record(model, 2);
    const second = engine.record(model, 1);
    const third = engine.record(model, 1);
    expect(first.state).toMatchObject({ status: 'recording', ahead: 0 });
    expect(second.state).toMatchObject({ status: 'waiting', ahead: 0 });
    expect(third.state).toMatchObject({ status: 'waiting', ahead: 1 });
    third.stop();
    expect(third.state.status).toBe('stopped');
    await ended(first);
    expect(first.state).toMatchObject({ status: 'complete', frameCount: 2, timeRange: [0, 1] });
    expect(first.span).toEqual([0, 10]);
    expect(first.log).toEqual([{ level: 'info', message: 'appended 2' }]);
    await ended(second);
    expect(second.state).toMatchObject({ status: 'complete', frameCount: 1 });
    expect(third.state.frameCount).toBe(0);
  });

  it('stops where it is when its host stops it, and its engine stops too', async () => {
    const model = sampleModel();
    const { recording, recorder } = byHand(model);
    recorder.append(Float64Array.of(0), { bus: Float32Array.of(1, 2, 3) });
    recording.stop();
    expect(recorder.signal.aborted).toBe(true);
    expect(recording.state).toMatchObject({ status: 'stopped', frameCount: 1, error: null });
    expect(recording.series('bus')!.state.live).toBe(false);
    expect(() => recorder.append(Float64Array.of(1), { bus: Float32Array.of(4, 5, 6) })).toThrow(
      /ended/,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recording.state.status).toBe('stopped');
    const next = new Player([block([0], { bus: [1, 2, 3] })]).record(model, 1);
    await ended(next);
    expect(next.state.status).toBe('complete');
  });

  it('refuses at once an input its engine refuses, recording nothing', () => {
    expect(() => new Player([]).record(sampleModel(), 'many')).toThrow(/how many blocks/);
  });
});

describe('recording.source and Recording.from', () => {
  it('describes the recording, and hands out windows the caller owns', async () => {
    const { recording, recorder } = byHand(sampleModel(), { id: 'run', label: 'Run' });
    const frames = block([0, 1], { bus: [1, 2, 3, 4, 5, 6], gen: [10, 20, 30, 40] });
    recorder.append(frames.time, frames.values);
    const source = recording.source();

    expect(await source.describe()).toEqual({
      id: 'run',
      label: 'Run',
      classes: [
        { classId: 'bus', signals: ['Vm'], elementCount: 3 },
        { classId: 'gen', signals: ['P'], elementCount: 2 },
      ],
    });
    const bus = recording.series('bus')!;
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

  it('streams its clock and log from the first frame, then each change, until it ends', async () => {
    const { recording, recorder, complete } = byHand(sampleModel());
    const frames = block([0, 1], { bus: [1, 2, 3, 4, 5, 6] });
    recorder.append(frames.time, frames.values);
    recorder.log('info', 'one');
    const changes = recording.source().changes()[Symbol.asyncIterator]();

    const first = await take(changes);
    expect([...first.time]).toEqual([0, 1]);
    expect(first).toMatchObject({ status: 'recording', ahead: 0, error: null, span: null });
    expect(first.log).toEqual([{ level: 'info', message: 'one' }]);
    expect([...first.ranges['bus']!]).toEqual([1, 6]);
    expect([...first.ranges['gen']!]).toEqual([NaN, NaN]);

    const next = take(changes);
    recorder.append(Float64Array.of(2), { gen: Float32Array.of(7, 8) });
    const second = await next;
    expect([...second.time]).toEqual([2]);
    expect(second.log).toEqual([]);
    expect([...second.ranges['gen']!]).toEqual([7, 8]);

    const declared = take(changes);
    recorder.declare({ span: [0, 5] });
    expect((await declared).span).toEqual([0, 5]);

    const last = take(changes);
    await complete();
    expect(await last).toMatchObject({ status: 'complete' });
    expect((await last).time.length).toBe(0);
    expect((await changes.next()).done).toBe(true);
  });

  it('ends its changes when their signal aborts', async () => {
    const { recording } = byHand(sampleModel());
    const controller = new AbortController();
    const changes = recording.source().changes(controller.signal)[Symbol.asyncIterator]();
    await changes.next();
    const next = changes.next();
    controller.abort();
    expect((await next).done).toBe(true);
  });

  it('opens a recording held elsewhere, its clock at hand and its samples read on demand', async () => {
    const { recording: origin, recorder } = byHand(sampleModel(), { id: 'run' });
    recorder.declare({ expectedFrames: 10 });
    const frames = block([0, 1, 1], { bus: [1, 2, 3, 4, 5, 6, 7, 8, 9], gen: [1, 2, 3, 4, 5, 6] });
    recorder.append(frames.time, frames.values);
    const source = origin.source();
    const read = vi.spyOn(source, 'read');

    const mirror = await Recording.from(origin.model, source);
    expect(mirror).toMatchObject({
      id: 'run',
      label: 'run',
      expectedFrames: 10,
      classes: ['bus', 'gen'],
    });
    expect(mirror.state).toEqual({
      status: 'recording',
      ahead: 0,
      frameCount: 3,
      timeRange: [0, 1],
      error: null,
    });
    expect(mirror.frameAt(1)).toBe(2);
    expect(mirror.timeAt(1)).toBe(1);
    const bus = mirror.series('bus')!;
    expect(bus).toMatchObject({ signals: ['Vm'], elementCount: 3 });
    expect([...bus.state.ranges!]).toEqual([1, 9]);
    expect(await bus.locate([1, 1], 3)).toEqual([1, 3]);
    expect(read).not.toHaveBeenCalled();
    expect(await values(bus)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(read).toHaveBeenCalledOnce();
    mirror.close();
  });

  it('follows the recording it mirrors, its log and its end, every series changing first', async () => {
    const { recording: origin, recorder, fail } = byHand(sampleModel());
    const mirror = await Recording.from(origin.model, origin.source());
    expect(mirror.state).toMatchObject({ frameCount: 0, timeRange: null, status: 'recording' });
    const gen = mirror.series('gen')!;
    const heard: string[] = [];
    gen.on('change', () => heard.push(`gen:${gen.state.frameCount}`));
    mirror.on('change', () => heard.push(`recording:${mirror.state.frameCount}`));

    recorder.append(Float64Array.of(0, 2), { gen: Float32Array.of(1, 2, 3, 4) });
    await vi.waitFor(() => expect(mirror.state.frameCount).toBe(2));
    expect(heard).toEqual(['gen:2', 'recording:2']);
    expect([...gen.state.ranges!]).toEqual([1, 4]);
    expect(mirror.timeAt(1)).toBe(2);

    recorder.log('error', 'singular');
    await fail('diverged');
    await ended(mirror);
    expect(mirror.state).toMatchObject({ status: 'failed', error: 'diverged' });
    expect(mirror.log).toEqual([{ level: 'error', message: 'singular' }]);
    expect(gen.state.live).toBe(false);
    mirror.close();
  });

  it('stops following when stopped, and closes its source when closed', async () => {
    const { recording: origin, recorder } = byHand(sampleModel());
    const source = origin.source();
    const close = vi.fn();
    const mirror = await Recording.from(origin.model, { ...source, close });
    mirror.stop();
    expect(mirror.state.status).toBe('stopped');
    expect(mirror.series('bus')!.state.live).toBe(false);
    recorder.append(Float64Array.of(0), { bus: Float32Array.of(1, 2, 3) });
    await Promise.resolve();
    await Promise.resolve();
    expect(mirror.state.frameCount).toBe(0);
    expect(close).not.toHaveBeenCalled();
    mirror.close();
    mirror.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('refuses a source that describes an invalid recording or sends a bad change', async () => {
    const { recording: origin } = byHand(sampleModel(), { id: 'run' });
    const source = origin.source();
    const described = await source.describe();
    const close = vi.fn();
    const describing = (value: unknown) => ({
      ...source,
      close,
      describe: async () => value as typeof described,
    });
    await expect(
      Recording.from(origin.model, describing({ ...described, id: '' })),
    ).rejects.toThrow('recording id must be non-empty');
    await expect(
      Recording.from(
        origin.model,
        describing({ ...described, classes: [described.classes[0], described.classes[0]] }),
      ),
    ).rejects.toThrow('name each class once');
    await expect(
      Recording.from(
        origin.model,
        describing({ ...described, classes: [{ classId: 'bus', signals: [], elementCount: -1 }] }),
      ),
    ).rejects.toThrow(RangeError);
    expect(close).toHaveBeenCalled();

    const good = {
      time: Float64Array.of(0),
      ranges: {},
      status: 'recording',
      ahead: 0,
      error: null,
      span: null,
      expectedFrames: null,
      log: [],
    };
    const changing = (change: unknown) => ({
      ...source,
      async *changes() {
        yield change as never;
      },
    });
    await expect(Recording.from(origin.model, changing({ ...good, time: [0] }))).rejects.toThrow(
      'frames require f64 time',
    );
    await expect(
      Recording.from(origin.model, changing({ ...good, ranges: { bus: Float64Array.of(1) } })),
    ).rejects.toThrow('one f64 pair per signal');
    await expect(
      Recording.from(origin.model, changing({ ...good, status: 'done' })),
    ).rejects.toThrow('where its recording stands');
    await expect(
      Recording.from(origin.model, changing({ ...good, log: [{ level: 'x' }] })),
    ).rejects.toThrow('lines logged');
    await expect(Recording.from(origin.model, changing({ ...good, span: [3, 1] }))).rejects.toThrow(
      RangeError,
    );
    await expect(
      Recording.from(origin.model, {
        ...source,
        // eslint-disable-next-line require-yield
        async *changes() {
          return;
        },
      }),
    ).rejects.toThrow('ended before its clock');
    await expect(Recording.from(origin.model, source, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('refuses a source that does not fit the model it records', async () => {
    const { recording: origin } = byHand(sampleModel());
    const source = origin.source();
    const described = await source.describe();
    const holding = (classes: readonly unknown[]) => ({
      ...source,
      describe: async () => ({ ...described, classes: classes as typeof described.classes }),
    });
    await expect(
      Recording.from(
        origin.model,
        holding([{ classId: 'nope', signals: ['Vm'], elementCount: 3 }]),
      ),
    ).rejects.toThrow("class 'nope', which its model lacks");
    await expect(
      Recording.from(origin.model, holding([{ classId: 'bus', signals: ['Q'], elementCount: 3 }])),
    ).rejects.toThrow("signal 'Q', which class 'bus' does not declare");
    await expect(
      Recording.from(origin.model, holding([{ classId: 'bus', signals: ['Vm'], elementCount: 4 }])),
    ).rejects.toThrow("do not fit its model's 3");
    await expect(
      Recording.from(
        origin.model,
        holding([
          { classId: 'bus', signals: ['Vm'], elementCount: 1, elements: Uint32Array.of(3) },
        ]),
      ),
    ).rejects.toThrow("do not fit its model's 3");
    const sparse = await Recording.from(
      origin.model,
      holding([
        { classId: 'bus', signals: ['Vm'], elementCount: 2, elements: Uint32Array.of(0, 2) },
      ]),
    );
    expect(sparse.model).toBe(origin.model);
    sparse.close();
  });

  it('refuses a window a source returns that is not the one asked for', async () => {
    const { recording: origin, recorder } = byHand(sampleModel());
    recorder.append(Float64Array.of(0), { bus: Float32Array.of(1, 2, 3) });
    const source = origin.source();
    const mirror = await Recording.from(origin.model, {
      ...source,
      read: async () => ({ time: Float64Array.of(0, 1), values: new Float32Array(3), stride: 3 }),
    });
    const bus = mirror.series('bus')!;
    await expect(
      bus.read(0, { frameOffset: 0, frameCount: 1, elementOffset: 0, elementCount: 3 }),
    ).rejects.toThrow('invalid samples block');
    mirror.close();
  });

  it('reads a window larger than one read in pieces, each within the bound', async () => {
    const model = sampleModel();
    const { recording: origin, recorder } = byHand(model);
    const frames = 50_000;
    const values = new Float32Array(frames * 3);
    for (let i = 0; i < values.length; i++) values[i] = i;
    recorder.append(
      Float64Array.from({ length: frames }, (_, frame) => frame),
      { bus: values },
    );
    const source = origin.source();
    const read = vi.spyOn(source, 'read');
    const mirror = await Recording.from(origin.model, source);
    const bus = mirror.series('bus')!;
    const block = await bus.read(0, {
      frameOffset: 0,
      frameCount: frames,
      elementOffset: 0,
      elementCount: 3,
    });
    expect(block.stride).toBe(3);
    expect(block.values[3 * (frames - 1) + 2]).toBe(3 * (frames - 1) + 2);
    expect(block.time[frames - 1]).toBe(frames - 1);
    expect(read.mock.calls.length).toBeGreaterThan(1);
    for (const [, , window] of read.mock.calls)
      expect(window.frameCount * (window.elementCount + 1) * 8).toBeLessThanOrEqual(1 << 20);
    mirror.close();
  });
});

describe('Recording.follow', () => {
  it('ignores an opening signal after the first change has been received', async () => {
    const { recording: origin, recorder, complete } = byHand(sampleModel());
    const opening = new AbortController();
    const mirror = await Recording.from(origin.model, origin.source(), opening.signal);
    opening.abort();
    recorder.append(Float64Array.of(0), { bus: Float32Array.of(1, 2, 3) });
    await complete();
    await vi.waitFor(() => expect(mirror.state.status).toBe('complete'));
    expect(mirror.state.frameCount).toBe(1);
    mirror.close();
  });

  it('does not apply a pending source change after being stopped', async () => {
    const { recording: origin } = byHand(sampleModel());
    const first = await take(origin.source().changes()[Symbol.asyncIterator]());
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const finished = vi.fn();
    const mirror = Recording.follow(
      origin.model,
      {},
      {
        ...origin.source(),
        async *changes() {
          try {
            await waiting;
            yield first;
          } finally {
            finished();
          }
        },
      },
    );
    mirror.stop();
    release();
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(mirror.state.status).toBe('stopped');
    mirror.close();
    origin.close();
  });

  it('follows a recording made elsewhere from before its first change, shaped as its model', async () => {
    const { recording: origin, recorder, complete } = byHand(sampleModel());
    const { changes, read } = origin.source();
    const close = vi.fn();
    const here = Recording.follow(origin.model, { id: 'here' }, { changes, read, close });
    expect(here).toMatchObject({ id: 'here', label: 'here', classes: ['bus', 'gen'] });
    expect(here.state).toMatchObject({ status: 'waiting', frameCount: 0 });
    const frames = block([0, 1], { bus: [1, 2, 3, 4, 5, 6] });
    recorder.append(frames.time, frames.values);
    await vi.waitFor(() => expect(here.state.frameCount).toBe(2));
    expect(await values(here.series('bus')!)).toEqual([1, 2, 3, 4, 5, 6]);
    await complete();
    await ended(here);
    expect(here.state).toMatchObject({ status: 'complete', frameCount: 2 });
    here.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails when its source fails or ends before the recording does, keeping what it had', async () => {
    const model = sampleModel();
    const unread = (): Promise<never> => Promise.reject(new Error('unread'));
    const broken = Recording.follow(
      model,
      {},
      {
        // eslint-disable-next-line require-yield
        async *changes() {
          throw new Error('the socket closed');
        },
        read: unread,
      },
    );
    await ended(broken);
    expect(broken.state).toMatchObject({ status: 'failed', error: 'the socket closed' });

    const { recording: origin, recorder } = byHand(model);
    recorder.append(Float64Array.of(0), { bus: Float32Array.of(1, 2, 3) });
    const first = await take(origin.source().changes()[Symbol.asyncIterator]());
    const cut = Recording.follow(
      model,
      {},
      {
        async *changes() {
          yield first;
        },
        read: unread,
      },
    );
    await ended(cut);
    expect(cut.state).toMatchObject({
      status: 'failed',
      error: 'the recording source ended before the recording did',
      frameCount: 1,
    });
  });
});
