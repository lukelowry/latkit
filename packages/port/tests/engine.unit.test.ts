import { describe, expect, it, vi } from 'vitest';

import type { Engine, Model } from '@latkit/model';

import {
  connect,
  connectEngine,
  connectModel,
  loopback,
  protocol,
  serveEngine,
  serveModel,
} from '../src/index.js';
import { ended, Fixture, fixture, FRAMES, Scripted, settle } from './fixture.js';

describe('engine service', () => {
  it('records a model its realm serves where it lives, filling a recording on the far side', async () => {
    const [modelServer, modelClient] = loopback();
    const [engineServer, engineClient] = loopback();
    const served = fixture();
    const engine = new Scripted(async (recorder) => {
      recorder.wait(2);
      recorder.start();
      recorder.declare({ span: [0, 1], expectedFrames: 2 });
      await recorder.ready;
      recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
      recorder.log('warn', 'step halved');
    });
    const source = vi.spyOn(served, 'source');
    serveModel(modelServer, served);
    serveEngine(engineServer, engine);
    const model = await connectModel(modelClient);
    const remote = connectEngine(engineClient);
    const opens = source.mock.calls.length;

    const heard: string[] = [];
    const recording = remote.record(model, { app: 'dynamic' }, { id: 'study', label: 'Study' });
    recording.on('change', () => heard.push(`${recording.state.status}:${recording.state.ahead}`));
    await ended(recording);
    expect(engine.inputs).toEqual([{ app: 'dynamic' }]);
    expect(engine.models).toEqual([served]);
    expect(engine.models[0]).toBe(served);
    expect(source.mock.calls.length).toBe(opens);
    expect(recording.model).toBe(model);
    expect(recording).toMatchObject({
      id: 'study',
      label: 'Study',
      span: [0, 1],
      expectedFrames: 2,
    });
    expect(recording.state).toEqual({
      status: 'complete',
      ahead: 0,
      frameCount: 1,
      timeRange: [0.5, 0.5],
      error: null,
    });
    expect(recording.log).toEqual([{ level: 'warn', message: 'step halved' }]);
    expect(heard).toContain('waiting:2');
    expect([...recording.series('bus')!.state.ranges!]).toEqual([1, 2]);
  });

  it('lends any other model by its source, which the engine reads only as it asks', async () => {
    const [server, client] = loopback();
    const read: string[] = [];
    const local = new Fixture('Local', {
      source: (own) => ({
        ...own,
        class: (id, signal) => {
          read.push(id);
          return own.class(id, signal);
        },
      }),
    });
    const seen: string[] = [];
    const engine = new Scripted(async (recorder, _input, model) => {
      seen.push(new TextDecoder().decode(await model.bytes()));
      seen.push(...(await model.load('bus')).labels);
      recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
    });
    serveEngine(server, engine);
    const recording = connectEngine(client).record(local, null);
    await ended(recording);
    expect(recording.state).toMatchObject({ status: 'complete', frameCount: 1 });
    expect(recording.model).toBe(local);
    expect(seen).toEqual(['Local', 'Bus 1', 'Bus 2']);
    expect(read).toEqual(['bus']);
    expect(engine.models[0]).not.toBe(local);
    expect(engine.models[0]!.name).toBe('Local');
  });

  it('takes back what it lent once the recording ends', async () => {
    const [server, client] = loopback();
    let kept!: Model;
    serveEngine(
      server,
      new Scripted(async (_recorder, _input, model) => {
        kept = model;
      }),
    );
    await ended(connectEngine(client).record(fixture(), null));
    await expect(kept.bytes()).rejects.toThrow('the model is no longer lent');
  });

  it('hands a recording’s frames over without a copy, and leaves the caller its input', async () => {
    const [server, client] = loopback();
    const transfers: ArrayBuffer[][] = [];
    const spied = {
      ...server,
      post: (message: unknown, transfer: readonly ArrayBuffer[] = []) => {
        transfers.push([...transfer]);
        server.post(message, transfer);
      },
    };
    const time = Float64Array.of(0);
    const values = Float32Array.of(3, 4);
    serveEngine(spied, new Scripted(async (recorder) => recorder.append(time, { bus: values })));
    const clientTransfers: ArrayBuffer[][] = [];
    const remote = connectEngine({
      ...client,
      post: (message: unknown, transfer: readonly ArrayBuffer[] = []) => {
        clientTransfers.push([...transfer]);
        client.post(message, transfer);
      },
    });
    const input = { edits: Uint8Array.of(1, 2, 3) };
    const recording = remote.record(fixture(), input);
    await ended(recording);
    expect(transfers.flat()).toEqual(expect.arrayContaining([time.buffer, values.buffer]));
    expect(input.edits.byteLength).toBe(3);
    expect(recording.state.frameCount).toBe(1);
    const block = await recording.series('bus')!.read(0, {
      frameOffset: 0,
      frameCount: 1,
      elementOffset: 0,
      elementCount: 2,
    });
    expect([...block.values]).toEqual([3, 4]);
    // Only the lent core crossed from this side, handed over.
    expect(clientTransfers.flat()).toHaveLength(1);
  });

  it('fails a recording with why the served engine refused its input or failed', async () => {
    const [server, client] = loopback();
    serveEngine(
      server,
      new Scripted(
        async (recorder) => {
          recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
          throw new Error('engine crashed');
        },
        {
          parse: (input) => {
            if (input !== 'good') throw new TypeError('the engine takes only good input');
            return input;
          },
        },
      ),
    );
    const remote = connectEngine(client);
    const refused = remote.record(fixture(), 'bad');
    await ended(refused);
    expect(refused.state).toMatchObject({
      status: 'failed',
      error: 'the engine takes only good input',
    });
    const crashed = remote.record(fixture(), 'good');
    await ended(crashed);
    expect(crashed.state).toMatchObject({
      status: 'failed',
      error: 'engine crashed',
      frameCount: 1,
    });
  });

  it('stops the served engine when the far recording stops, keeping what arrived', async () => {
    const [server, client] = loopback();
    let aborted = false;
    serveEngine(
      server,
      new Scripted(async (recorder) => {
        recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
        await new Promise<void>((resolve) =>
          recorder.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        aborted = true;
        recorder.signal.throwIfAborted();
      }),
    );
    const recording = connectEngine(client).record(fixture(), null);
    await vi.waitFor(() => expect(recording.state.frameCount).toBe(1));
    recording.stop();
    expect(recording.state.status).toBe('stopped');
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(recording.state).toMatchObject({ status: 'stopped', frameCount: 1 });
  });

  it('queues what the served engine cannot take at once, and each learns its place', async () => {
    const [server, client] = loopback();
    const finish: (() => void)[] = [];
    serveEngine(server, new Scripted(() => new Promise<void>((resolve) => finish.push(resolve))));
    const remote = connectEngine(client);
    const first = remote.record(fixture(), 1);
    const second = remote.record(fixture(), 2);
    await vi.waitFor(() => expect(second.state).toMatchObject({ status: 'waiting', ahead: 0 }));
    expect(first.state.status).toBe('recording');
    finish.shift()!();
    await ended(first);
    await vi.waitFor(() => expect(second.state.status).toBe('recording'));
    finish.shift()!();
    await ended(second);
    expect(second.state.status).toBe('complete');
  });

  it('awaits the port drain between recorder calls, so backpressure reaches the wire', async () => {
    const [server, client] = loopback();
    const drain = vi.fn(async () => {});
    serveEngine(
      { ...server, drain },
      new Scripted(async (recorder) => {
        recorder.log('info', 'a');
        recorder.log('info', 'b');
      }),
    );
    await ended(connectEngine(client).record(fixture(), null));
    // Start, two lines: three calls, each awaited before the next crosses.
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('tells an engine it is not ready while its calls wait on the port', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    let blocked = true;
    const readiness: boolean[] = [];
    serveEngine(
      {
        ...server,
        drain: () =>
          blocked ? new Promise<void>((resolve) => (release = () => resolve())) : Promise.resolve(),
      },
      new Scripted(async (recorder: Engine.Recorder) => {
        for (let i = 0; i < 40; i++) recorder.log('info', String(i));
        let ready = false;
        void recorder.ready.then(() => (ready = true));
        await settle();
        readiness.push(ready);
        blocked = false;
        release();
        await recorder.ready;
        readiness.push(true);
      }),
    );
    const recording = connectEngine(client).record(fixture(), null);
    await ended(recording);
    expect(readiness).toEqual([false, true]);
    expect(recording.log).toHaveLength(40);
  });

  it('serves an engine that is still opening, and fails recordings of one that cannot', async () => {
    const [server, client] = loopback();
    let release!: (engine: Scripted) => void;
    serveEngine(server, new Promise<Scripted>((resolve) => (release = resolve)));
    const recording = connectEngine(client).record(fixture(), null);
    await settle();
    release(new Scripted(async (recorder) => recorder.log('info', 'late')));
    await ended(recording);
    expect(recording.log).toEqual([{ level: 'info', message: 'late' }]);

    const [failing, failed] = loopback();
    serveEngine(failing, Promise.reject(new Error('no solver')));
    const refused = connectEngine(failed).record(fixture(), null);
    await ended(refused);
    expect(refused.state).toMatchObject({ status: 'failed', error: 'no solver' });
  });

  it('refuses a request its check refuses, saying why', async () => {
    const [server, client] = loopback();
    serveEngine(server, new Scripted(async () => {}));
    const raw = connect(client, protocol<unknown, unknown>('engine:record'));
    const stream = (request: unknown) => raw.stream(request)[Symbol.asyncIterator]().next();
    await expect(stream({ input: 1 })).rejects.toThrow(
      'engine:record request.lent must be a nonnegative safe integer',
    );
    await expect(stream({ input: 1, lent: 1, home: 5 })).rejects.toThrow(
      'engine:record request.home must be a string',
    );
    await expect(stream('record')).rejects.toThrow('engine:record request must be an object');
  });

  it('ends when either side closes', async () => {
    const [server, client] = loopback();
    const onClose = vi.fn();
    serveEngine(server, new Scripted(async () => {}), { onClose });
    const remote = connectEngine(client);
    remote.close();
    await settle();
    expect(onClose).toHaveBeenCalledOnce();
    const recording = remote.record(fixture(), null);
    await ended(recording);
    expect(recording.state).toMatchObject({
      status: 'failed',
      error: 'The connection was closed.',
    });

    const [otherServer, otherClient] = loopback();
    const stop = serveEngine(otherServer, new Scripted(() => new Promise<void>(() => {})));
    const waiting = connectEngine(otherClient).record(fixture(), null);
    await vi.waitFor(() => expect(waiting.state.status).toBe('recording'));
    stop();
    await ended(waiting);
    expect(waiting.state).toMatchObject({ status: 'failed', error: 'The service was closed.' });
  });
});
