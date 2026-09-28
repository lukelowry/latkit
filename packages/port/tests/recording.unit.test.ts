import { describe, expect, it, vi } from 'vitest';

import type { Recording, Series } from '@latkit/model';

import { connect, connectRecording, loopback, protocol, serveRecording } from '../src/index.js';
import { fixture } from './fixture.js';

/** The fixture's bus voltage over two buses, at times 0 and 0.5. */
function recorded() {
  const recording = fixture().record({ id: 'run', label: 'Run', span: [0, 2], expectedFrames: 4 });
  recording.append({ time: Float64Array.of(0, 0.5), values: { bus: Float32Array.of(1, 2, 3, 4) } });
  return recording;
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
    serveRecording(server, recorded());
    const remote = await connectRecording(client, 'run');
    expect(remote).toMatchObject({
      id: 'run',
      label: 'Run',
      span: [0, 2],
      expectedFrames: 4,
      classes: ['bus'],
    });
    expect(remote.state).toEqual({ frameCount: 2, timeRange: [0, 0.5], live: true });
    expect(remote.frameAt(-1)).toBe(0);
    expect(remote.frameAt(0.25)).toBe(0);
    expect(remote.frameAt(9)).toBe(1);
    expect(remote.timeAt(1)).toBe(0.5);
    expect(() => remote.timeAt(2)).toThrow(/not committed/);
    const bus = (await remote.series('bus'))!;
    expect(bus).toMatchObject({ signals: ['Vm'], elementCount: 2 });
    expect([...bus.state.ranges!]).toEqual([1, 4]);
    expect(await bus.locate([0.5, 0.5], 2)).toEqual([1, 2]);
    expect(await remote.series('line')).toBeNull();
    const block = await bus.read(0, all(bus));
    expect([...block.time]).toEqual([0, 0.5]);
    expect([...block.values]).toEqual([1, 2, 3, 4]);
    remote.close();
  });

  it('follows appends and the seal, every series changing before the recording', async () => {
    const [server, client] = loopback();
    const local = recorded();
    serveRecording(server, local);
    const remote = await connectRecording(client, 'run');
    const bus = (await remote.series('bus'))!;
    const heard: string[] = [];
    bus.on('change', () => heard.push(`bus:${bus.state.frameCount}:${bus.state.live}`));
    remote.on('change', () => heard.push(`recording:${remote.state.frameCount}`));

    local.append({ time: Float64Array.of(1), values: { bus: Float32Array.of(-5, 9) } });
    await vi.waitFor(() => expect(remote.state.frameCount).toBe(3));
    local.seal();
    await vi.waitFor(() => expect(remote.state.live).toBe(false));

    expect(heard).toEqual(['bus:3:true', 'recording:3', 'bus:3:false', 'recording:3']);
    expect(remote.state).toEqual({ frameCount: 3, timeRange: [0, 1], live: false });
    expect([...bus.state.ranges!]).toEqual([-5, 9]);
    expect(remote.timeAt(2)).toBe(1);
    expect([...(await bus.read(0, all(bus))).values]).toEqual([1, 2, 3, 4, -5, 9]);
  });

  it('keeps every frame appended while the far side opens', async () => {
    const [server, client] = loopback();
    const local = fixture().record({ id: 'run' });
    serveRecording(server, local);
    const opening = connectRecording(client, 'run');
    for (let frame = 0; frame < 6; frame++) {
      local.append({
        time: Float64Array.of(frame),
        values: { bus: Float32Array.of(frame, -frame) },
      });
      await Promise.resolve();
    }
    const remote = await opening;
    await vi.waitFor(() => expect(remote.state.frameCount).toBe(6));
    expect([0, 1, 2, 3, 4, 5].map((frame) => remote.timeAt(frame))).toEqual([0, 1, 2, 3, 4, 5]);
    const bus = (await remote.series('bus'))!;
    expect([...bus.state.ranges!]).toEqual([-5, 5]);

    const time = Float64Array.from({ length: 200 }, (_, i) => 6 + i);
    local.append({ time, values: { bus: new Float32Array(400) } });
    await vi.waitFor(() => expect(remote.state.frameCount).toBe(206));
    expect(remote.timeAt(205)).toBe(205);
    expect(remote.frameAt(100.5)).toBe(100);
    expect(await bus.locate([6, 205], 206)).toEqual([6, 206]);
  });

  it('reads strided f64 samples as owned copies, never the producer buffers', async () => {
    const [server, client] = loopback();
    const local = fixture().record({ id: 'run' });
    const values = Float64Array.of(1e12, 1e12 + 0.125, 1e12 + 0.25, 1e12 + 0.375);
    local.append({ time: Float64Array.of(0, 1), values: { bus: values } });
    serveRecording(server, local);
    const bus = (await (await connectRecording(client, 'run')).series('bus'))!;
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
    const local = recorded();
    const read = vi.spyOn((await local.series('bus'))!, 'read');
    serveRecording(server, local, { maxBytes: 16 });
    const bus = (await (await connectRecording(client, 'run')).series('bus'))!;
    const window = (frameOffset: number, frameCount: number, elementCount = 1) => ({
      frameOffset,
      frameCount,
      elementOffset: 0,
      elementCount,
    });
    await expect(bus.read(0, window(0, 2, 2))).rejects.toThrow('maxBytes');
    await expect(bus.read(1, window(0, 1))).rejects.toThrow('signal 1 out of range');
    await expect(bus.read(0, window(2, 1))).rejects.toThrow('committed');
    expect(read).not.toHaveBeenCalled();
    expect((await bus.read(0, window(0, 1))).values[0]).toBe(1);
    expect(() => serveRecording(server, local, { maxBytes: 8 })).toThrow(RangeError);
  });

  it('refuses a request its check refuses, saying why, and keeps serving', async () => {
    const [server, client] = loopback();
    serveRecording(server, recorded());
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
    const stop = serveRecording(server, recorded());
    const remote = await connectRecording(client, 'run');
    const bus = (await remote.series('bus'))!;
    stop();
    await expect(bus.read(0, all(bus))).rejects.toThrow(/service was closed/);

    const [otherServer, otherClient] = loopback();
    serveRecording(otherServer, recorded());
    const other = await connectRecording(otherClient, 'run');
    const otherBus = (await other.series('bus'))!;
    other.close();
    await expect(otherBus.read(0, all(otherBus))).rejects.toThrow(/connection was closed/);
  });

  it('refuses a recording that cannot open, and one without an id', async () => {
    const [server, client] = loopback();
    const local = recorded();
    const broken: Recording = {
      ...local,
      source: () => ({ ...local.source(), describe: () => Promise.reject(new Error('gone')) }),
    };
    serveRecording(server, broken);
    await expect(connectRecording(client, 'run')).rejects.toThrow('gone');
    expect(() => serveRecording(server, { ...recorded(), id: '' })).toThrow(/needs an id/);
    await expect(connectRecording(client, '')).rejects.toThrow(/needs an id/);
  });
});
