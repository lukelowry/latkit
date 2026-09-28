import { describe, expect, it, vi } from 'vitest';

import type { Engine } from '@latkit/model';

import { connect, connectModel, loopback, protocol, serveModel } from '../src/index.js';
import { ended, Fixture, fixture, FRAMES, Scripted, settle } from './fixture.js';

describe('model service', () => {
  it('serves a model across the port, its classes loading as they are asked for', async () => {
    const [server, client] = loopback();
    serveModel(server, fixture('Fixture'));

    const model = await connectModel(client);
    expect(model).toMatchObject({ format: 'test', id: 'fixture', name: 'Fixture' });
    expect(model.classes.map((spec) => spec.id)).toEqual(['bus', 'line']);
    expect((await model.load('bus')).labels).toEqual(['Bus 1', 'Bus 2']);
    expect(new TextDecoder().decode(await model.bytes())).toBe('Fixture');
    expect(model.engine).toBeNull();
    model.close();
  });

  it('serves a model that is still opening, so no early request is lost', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    serveModel(server, new Promise<Fixture>((resolve) => (release = () => resolve(fixture()))));
    const opening = connectModel(client);
    await settle();
    release();
    expect((await opening).name).toBe('Fixture');
  });

  it('rejects the connect to a model that fails to open, and nothing else', async () => {
    const [server, client] = loopback();
    serveModel(server, Promise.reject(new Error('bad case')));
    await settle();
    await expect(connectModel(client)).rejects.toThrow('bad case');
  });

  it('reports core download progress to the opener', async () => {
    const [server, client] = loopback();
    serveModel(
      server,
      new Fixture('Fixture', {
        source: (own) => ({
          ...own,
          core: async (_signal, progress) => {
            progress?.(5, 10);
            progress?.(10, 10);
            return own.core();
          },
        }),
      }),
    );
    const progress = vi.fn();
    await connectModel(client, { progress });
    expect(progress.mock.calls).toEqual([
      [5, 10],
      [10, 10],
    ]);
  });

  it('closing the model closes the service on both sides', async () => {
    const [server, client] = loopback();
    const onClose = vi.fn();
    serveModel(server, fixture(), { onClose });
    const model = await connectModel(client);
    model.close();
    await expect(model.bytes()).rejects.toThrow(/closed/);
    await settle();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rejects everything pending when the server closes, like a crashed worker', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    const stop = serveModel(
      server,
      new Fixture('Fixture', {
        bytes: () =>
          new Promise<Uint8Array>((resolve) => (release = () => resolve(new Uint8Array()))),
      }),
    );
    const model = await connectModel(client);
    const pending = model.bytes();
    await settle();
    stop();
    await expect(pending).rejects.toThrow(/service was closed/);
    await expect(model.load('bus')).rejects.toThrow(/service was closed/);
    release();
  });

  it('surfaces a failure as that request rejecting, and keeps serving', async () => {
    const [server, client] = loopback();
    serveModel(
      server,
      new Fixture('Fixture', {
        bytes: async () => {
          throw new Error('disk on fire');
        },
      }),
    );
    const model = await connectModel(client);
    await expect(model.bytes()).rejects.toThrow('disk on fire');
    expect((await model.load('bus')).labels).toHaveLength(2);
  });

  it('refuses a request its check refuses, saying why, and keeps serving', async () => {
    const [server, client] = loopback();
    serveModel(server, fixture());
    const raw = connect(client, protocol<unknown, unknown>('model'));
    await expect(raw.call({ op: 'class' })).rejects.toThrow(
      'model request.id must be a string of at most 65536 characters',
    );
    await expect(raw.call({ op: 'nope' })).rejects.toThrow(
      'model request.op must be one of open, class, bytes',
    );
    await expect(raw.call('open')).rejects.toThrow('model request must be an object');
    expect(await raw.call({ op: 'open' })).toMatchObject({ recordable: false });
  });

  it('rejects the connect when the model cannot produce its core', async () => {
    const [server, client] = loopback();
    serveModel(
      server,
      new Fixture('Fixture', {
        source: (own) => ({
          ...own,
          core: async () => {
            throw new Error('no core');
          },
        }),
      }),
    );
    await expect(connectModel(client)).rejects.toThrow('no core');
  });
});

describe('model service: recordings', () => {
  it('records with the served engine, filling a recording on the far side', async () => {
    const [server, client] = loopback();
    const engine = new Scripted(async (recorder) => {
      recorder.wait(2);
      recorder.start();
      recorder.declare({ span: [0, 1], expectedFrames: 2 });
      await recorder.ready;
      recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
      recorder.log('warn', 'step halved');
    });
    serveModel(server, fixture('Fixture', engine));
    const model = await connectModel(client);
    expect(model.engine).not.toBeNull();

    const heard: string[] = [];
    const recording = model.record({ app: 'dynamic' }, { id: 'study', label: 'Study' });
    recording.on('change', () => heard.push(`${recording.state.status}:${recording.state.ahead}`));
    await ended(recording);
    expect(engine.inputs).toEqual([{ app: 'dynamic' }]);
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
    serveModel(
      spied,
      fixture('Fixture', new Scripted(async (recorder) => recorder.append(time, { bus: values }))),
    );
    const clientTransfers: ArrayBuffer[][] = [];
    const model = await connectModel({
      ...client,
      post: (message: unknown, transfer: readonly ArrayBuffer[] = []) => {
        clientTransfers.push([...transfer]);
        client.post(message, transfer);
      },
    });
    const input = { edits: Uint8Array.of(1, 2, 3) };
    const recording = model.record(input);
    await ended(recording);
    expect(transfers.flat()).toEqual(expect.arrayContaining([time.buffer, values.buffer]));
    expect(input.edits.byteLength).toBe(3);
    expect(clientTransfers.flat()).toHaveLength(0);
    expect([...(await recording.series('bus')!.read(0, all(1, 2))).values]).toEqual([3, 4]);
  });

  it('fails a recording with why the served engine refused its input or failed', async () => {
    const [server, client] = loopback();
    serveModel(
      server,
      fixture(
        'Fixture',
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
      ),
    );
    const model = await connectModel(client);
    const refused = model.record('bad');
    await ended(refused);
    expect(refused.state).toMatchObject({
      status: 'failed',
      error: 'the engine takes only good input',
    });
    const crashed = model.record('good');
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
    serveModel(
      server,
      fixture(
        'Fixture',
        new Scripted(async (recorder) => {
          recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
          await new Promise<void>((resolve) =>
            recorder.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          aborted = true;
          recorder.signal.throwIfAborted();
        }),
      ),
    );
    const model = await connectModel(client);
    const recording = model.record(null);
    await vi.waitFor(() => expect(recording.state.frameCount).toBe(1));
    recording.stop();
    expect(recording.state.status).toBe('stopped');
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(recording.state).toMatchObject({ status: 'stopped', frameCount: 1 });
  });

  it('queues what the served engine cannot take at once, and each learns its place', async () => {
    const [server, client] = loopback();
    const finish: (() => void)[] = [];
    serveModel(
      server,
      fixture('Fixture', new Scripted(() => new Promise<void>((resolve) => finish.push(resolve)))),
    );
    const model = await connectModel(client);
    const first = model.record(1);
    const second = model.record(2);
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
    serveModel(
      { ...server, drain },
      fixture(
        'Fixture',
        new Scripted(async (recorder) => {
          recorder.log('info', 'a');
          recorder.log('info', 'b');
        }),
      ),
    );
    const model = await connectModel(client);
    await ended(model.record(null));
    // Start, two lines: three calls, each awaited before the next crosses.
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('tells an engine it is not ready while its calls wait on the port', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    let blocked = true;
    const readiness: boolean[] = [];
    serveModel(
      {
        ...server,
        drain: () =>
          blocked ? new Promise<void>((resolve) => (release = () => resolve())) : Promise.resolve(),
      },
      fixture(
        'Fixture',
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
      ),
    );
    const model = await connectModel(client);
    const recording = model.record(null);
    await ended(recording);
    expect(readiness).toEqual([false, true]);
    expect(recording.log).toHaveLength(40);
  });
});

function all(frameCount: number, elementCount: number) {
  return { frameOffset: 0, frameCount, elementOffset: 0, elementCount };
}
