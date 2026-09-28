import { describe, expect, it, vi } from 'vitest';

import { Model, type Recording, type Series } from '@latkit/model';

import { connect, connectRecording, loopback, protocol, serveRecording } from '../src/index.js';
import { byHand, ended, fixture } from './fixture.js';

/** The fixture's bus voltage over two buses, at times 0 and 0.5, recorded by hand as `run`. */
function recorded() {
  const hand = byHand(fixture(), { id: 'run', label: 'Run' });
  hand.recorder.declare({ span: [0, 2], expectedFrames: 4 });
  hand.recorder.append(Float64Array.of(0, 0.5), { bus: Float32Array.of(1, 2, 3, 4) });
  return hand;
}

/** Every committed frame of every element. */
const all = (series: Series) => ({
  frameOffset: 0,
  frameCount: series.state.frameCount,
  elementOffset: 0,
  elementCount: series.elementCount,
});

describe('recording service', () => {
  it('opens with the header, the clock, and every class, so lookups answer on the far side', async () => {
    const [server, client] = loopback();
    serveRecording(server, recorded().recording);
    const remote = await connectRecording(client, fixture(), 'run');
    expect(remote).toMatchObject({
      id: 'run',
      label: 'Run',
      span: [0, 2],
      expectedFrames: 4,
      classes: ['bus'],
    });
    expect(remote.state).toEqual({
      status: 'recording',
      ahead: 0,
      frameCount: 2,
      timeRange: [0, 0.5],
      error: null,
    });
    expect(remote.frameAt(-1)).toBe(0);
    expect(remote.frameAt(0.25)).toBe(0);
    expect(remote.frameAt(9)).toBe(1);
    expect(remote.timeAt(1)).toBe(0.5);
    expect(() => remote.timeAt(2)).toThrow(/not committed/);
    const bus = remote.series('bus')!;
    expect(bus).toMatchObject({ signals: ['Vm'], elementCount: 2 });
    expect([...bus.state.ranges!]).toEqual([1, 4]);
    expect(await bus.locate([0.5, 0.5], 2)).toEqual([1, 2]);
    expect(remote.series('line')).toBeNull();
    const block = await bus.read(0, all(bus));
    expect([...block.time]).toEqual([0, 0.5]);
    expect([...block.values]).toEqual([1, 2, 3, 4]);
    remote.close();
  });

  it('follows appends, the log, and the end, every series changing before the recording', async () => {
    const [server, client] = loopback();
    const { recording: local, recorder, complete } = recorded();
    serveRecording(server, local);
    const remote = await connectRecording(client, fixture(), 'run');
    const bus = remote.series('bus')!;
    const heard: string[] = [];
    bus.on('change', () => heard.push(`bus:${bus.state.frameCount}:${bus.state.live}`));
    remote.on('change', () => heard.push(`recording:${remote.state.frameCount}`));

    recorder.append(Float64Array.of(1), { bus: Float32Array.of(-5, 9) });
    await vi.waitFor(() => expect(remote.state.frameCount).toBe(3));
    recorder.log('info', 'converged');
    await complete();
    await ended(remote);

    expect(heard).toEqual([
      'bus:3:true',
      'recording:3',
      'bus:3:true',
      'recording:3',
      'bus:3:false',
      'recording:3',
    ]);
    expect(remote.state).toEqual({
      status: 'complete',
      ahead: 0,
      frameCount: 3,
      timeRange: [0, 1],
      error: null,
    });
    expect(remote.log).toEqual([{ level: 'info', message: 'converged' }]);
    expect([...bus.state.ranges!]).toEqual([-5, 9]);
    expect(remote.timeAt(2)).toBe(1);
    expect([...(await bus.read(0, all(bus))).values]).toEqual([1, 2, 3, 4, -5, 9]);
  });

  it('keeps every frame appended while the far side opens', async () => {
    const [server, client] = loopback();
    const { recording: local, recorder } = byHand(fixture(), { id: 'run' });
    serveRecording(server, local);
    const opening = connectRecording(client, fixture(), 'run');
    for (let frame = 0; frame < 6; frame++) {
      recorder.append(Float64Array.of(frame), { bus: Float32Array.of(frame, -frame) });
      await Promise.resolve();
    }
    const remote = await opening;
    await vi.waitFor(() => expect(remote.state.frameCount).toBe(6));
    expect([0, 1, 2, 3, 4, 5].map((frame) => remote.timeAt(frame))).toEqual([0, 1, 2, 3, 4, 5]);
    const bus = remote.series('bus')!;
    expect([...bus.state.ranges!]).toEqual([-5, 5]);

    const time = Float64Array.from({ length: 200 }, (_, i) => 6 + i);
    recorder.append(time, { bus: new Float32Array(400) });
    await vi.waitFor(() => expect(remote.state.frameCount).toBe(206));
    expect(remote.timeAt(205)).toBe(205);
    expect(remote.frameAt(100.5)).toBe(100);
    expect(await bus.locate([6, 205], 206)).toEqual([6, 206]);
  });

  it('reads strided f64 samples as owned copies, never the producer buffers', async () => {
    const [server, client] = loopback();
    const { recording: local, recorder } = byHand(fixture(), { id: 'run' });
    const values = Float64Array.of(1e12, 1e12 + 0.125, 1e12 + 0.25, 1e12 + 0.375);
    recorder.append(Float64Array.of(0, 1), { bus: values });
    serveRecording(server, local);
    const bus = (await connectRecording(client, fixture(), 'run')).series('bus')!;
    const block = await bus.read(0, {
      frameOffset: 0,
      frameCount: 2,
      elementOffset: 1,
      elementCount: 1,
    });
    expect(block.values).toBeInstanceOf(Float64Array);
    expect([...block.values]).toEqual([1e12 + 0.125, 1e12 + 0.375]);
    expect(block.stride).toBe(1);
    expect(values.byteLength).toBe(32);
  });

  it('refuses oversized and out-of-bounds windows before reading the producer', async () => {
    const [server, client] = loopback();
    const { recording: local, recorder } = byHand(fixture(), { id: 'run' });
    // Two buses over 200,000 frames: all of them at once is 4.8 MB, past the 4 MiB cap.
    const frames = 200_000;
    recorder.append(
      Float64Array.from({ length: frames }, (_, frame) => frame),
      { bus: new Float32Array(frames * 2).fill(1) },
    );
    const read = vi.spyOn(local.series('bus')!, 'read');
    serveRecording(server, local);
    const connection = connect(client, protocol<unknown, unknown>('recording:run'));
    const window = (frameOffset: number, frameCount: number, elementCount = 1) => ({
      frameOffset,
      frameCount,
      elementOffset: 0,
      elementCount,
    });
    await expect(
      connection.call({ op: 'read', classId: 'bus', signalIndex: 0, window: window(0, frames, 2) }),
    ).rejects.toThrow('4 MiB');
    const bus = (await connectRecording(client, fixture(), 'run')).series('bus')!;
    await expect(bus.read(1, window(0, 1))).rejects.toThrow('signal 1 out of range');
    await expect(bus.read(0, window(frames, 1))).rejects.toThrow('committed');
    expect(read).not.toHaveBeenCalled();
    expect((await bus.read(0, window(0, 1))).values[0]).toBe(1);
  });

  it('samples a class too large for one window a piece at a time, across the port', async () => {
    const count = 600_000;
    class Large extends Model {
      constructor() {
        super({
          format: 'test',
          id: 'large',
          name: 'Large',
          topology: { vertexCount: 0, edges: new Uint32Array(0), polylineStart: Uint32Array.of(0) },
          classes: [
            {
              id: 'meter',
              label: 'Meter',
              count,
              columns: [],
              signals: [{ id: 'x', label: 'X', unit: '', recorded: true }],
            },
          ],
        });
      }
      protected values(): Promise<Model.Values> {
        return Promise.resolve({ labels: Array.from({ length: count }, String), values: [] });
      }
      bytes(): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array(0));
      }
    }
    const model = new Large();
    const { recording: local, recorder } = byHand(model, { id: 'run' });
    recorder.append(Float64Array.of(0), {
      meter: Float32Array.from({ length: count }, (_, element) => element),
    });
    const [server, client] = loopback();
    serveRecording(server, local);
    const remote = await connectRecording(client, model, 'run');
    const field = (await remote.field({ classId: 'meter', kind: 'signal', id: 'x' }))!;
    const values = await field.at(0);
    expect(values.length).toBe(count);
    expect([values[0], values[65_536], values[count - 1]]).toEqual([0, 65_536, count - 1]);
    remote.close();
  });

  it('refuses a request its check refuses, saying why, and keeps serving', async () => {
    const [server, client] = loopback();
    serveRecording(server, recorded().recording);
    const raw = connect(client, protocol<unknown, unknown>('recording:run'));
    const window = { frameOffset: 0, frameCount: 1, elementOffset: 0, elementCount: 1 };
    for (const [request, reason] of [
      [{ op: 'read', classId: 'bus' }, 'request.signalIndex must be a nonnegative safe integer'],
      [
        { op: 'read', classId: 'bus', signalIndex: 0, window: { ...window, frameCount: 0.5 } },
        'request.window.frameCount must be a nonnegative safe integer',
      ],
      [{ op: 'nope' }, 'request.op must be one of describe, changes, read'],
      ['describe', 'request must be an object'],
    ] as const) {
      await expect(raw.call(request)).rejects.toThrow(`recording:run ${reason}`);
    }
    await expect(raw.call({ op: 'read', classId: 'gen', signalIndex: 0, window })).rejects.toThrow(
      "recording 'run' has no class 'gen'",
    );
    expect(await raw.call({ op: 'describe' })).toMatchObject({ id: 'run', label: 'Run' });
  });

  it('ends reads when either side closes', async () => {
    const [server, client] = loopback();
    const stop = serveRecording(server, recorded().recording);
    const remote = await connectRecording(client, fixture(), 'run');
    const bus = remote.series('bus')!;
    stop();
    await expect(bus.read(0, all(bus))).rejects.toThrow(/service was closed/);

    const [otherServer, otherClient] = loopback();
    serveRecording(otherServer, recorded().recording);
    const other = await connectRecording(otherClient, fixture(), 'run');
    const otherBus = other.series('bus')!;
    other.close();
    await expect(otherBus.read(0, all(otherBus))).rejects.toThrow(/connection was closed/);
  });

  it('refuses a recording that cannot open, and one without an id', async () => {
    const [server, client] = loopback();
    const { recording: local } = recorded();
    const own = local.source();
    vi.spyOn(local, 'source').mockReturnValue({
      ...own,
      describe: () => Promise.reject(new Error('gone')),
    });
    serveRecording(server, local);
    await expect(connectRecording(client, fixture(), 'run')).rejects.toThrow('gone');
    expect(() => serveRecording(server, { id: '' } as unknown as Recording)).toThrow(/needs an id/);
    await expect(connectRecording(client, fixture(), '')).rejects.toThrow(/needs an id/);
  });
});
