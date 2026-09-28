import { describe, expect, it, vi } from 'vitest';

import type { RunUpdate } from '@latkit/model';

import { check, connect, connectModel, loopback, protocol, serveModel } from '../src/index.js';
import { collect, fixture, FRAMES, settle, withSource } from './fixture.js';

describe('model service', () => {
  it('serves a model across the port, its classes loading as they are asked for', async () => {
    const [server, client] = loopback();
    serveModel(server, fixture('Fixture'));

    const model = await connectModel(client);
    expect(model).toMatchObject({ vendor: 'test', id: 'fixture', name: 'Fixture' });
    expect(model.classes.map((spec) => spec.id)).toEqual(['bus', 'line']);
    expect((await model.load('bus')).labels).toEqual(['Bus 1', 'Bus 2']);
    expect(new TextDecoder().decode(await model.bytes())).toBe('Fixture');
    expect(model.run).toBeUndefined();
    model.close();
  });

  it('serves a model that is still opening, so no early request is lost', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    serveModel(
      server,
      new Promise<ReturnType<typeof fixture>>((resolve) => (release = () => resolve(fixture()))),
    );
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
      withSource(fixture(), (own) => ({
        ...own,
        core: async (_signal, progress) => {
          progress?.(5, 10);
          progress?.(10, 10);
          return own.core();
        },
      })),
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
    const closed = vi.fn();
    const onClose = vi.fn();
    serveModel(
      server,
      withSource(fixture(), (own) => ({ ...own, close: closed })),
      { onClose },
    );
    const model = await connectModel(client);
    model.close();
    await expect(model.bytes()).rejects.toThrow(/closed/);
    await settle();
    expect(closed).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rejects everything pending when the server closes, like a crashed worker', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    const stop = serveModel(
      server,
      withSource(fixture(), (own) => ({
        ...own,
        bytes: () =>
          new Promise<Uint8Array>((resolve) => (release = () => resolve(new Uint8Array()))),
      })),
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
      withSource(fixture(), (own) => ({
        ...own,
        bytes: async () => {
          throw new Error('disk on fire');
        },
      })),
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
    expect(await raw.call({ op: 'open' })).toMatchObject({ runnable: false });
    const runs = connect(client, protocol<unknown, unknown>('model:run'));
    await expect(runs.call('not bytes')).rejects.toThrow('model:run request must be a Uint8Array');
  });

  it('rejects the connect when the model cannot produce its core', async () => {
    const [server, client] = loopback();
    serveModel(
      server,
      withSource(fixture(), (own) => ({
        ...own,
        core: async () => {
          throw new Error('no core');
        },
      })),
    );
    await expect(connectModel(client)).rejects.toThrow('no core');
  });
});

const COMMAND = new TextEncoder().encode('{}');

describe('model service: runs', () => {
  it('runs on the served engine, filling a recording on the far side', async () => {
    const [server, client] = loopback();
    const engine = vi.fn(async function* (_command: Uint8Array): AsyncIterable<RunUpdate> {
      yield { type: 'queued', ahead: 2 };
      yield { type: 'running' };
      yield FRAMES;
      yield { type: 'log', level: 'warn', message: 'step halved' };
      yield { type: 'done' };
    });
    serveModel(server, fixture('Fixture', engine));
    const model = await connectModel(client);

    const run = model.run!(COMMAND, { id: 'study' });
    expect(await collect(run)).toEqual([
      { type: 'queued', ahead: 2 },
      { type: 'running' },
      FRAMES,
      { type: 'log', level: 'warn', message: 'step halved' },
      { type: 'done' },
    ]);
    expect(new TextDecoder().decode(engine.mock.calls[0]![0])).toBe('{}');
    expect(run.recording.state).toEqual({ frameCount: 1, timeRange: [0.5, 0.5], live: false });
    const bus = (await run.recording.series('bus'))!;
    expect([...bus.state.ranges!]).toEqual([1, 2]);
  });

  it('leaves the caller its command, so the same plan can run again', async () => {
    const transfers: ArrayBuffer[][] = [];
    const [server, client] = loopback();
    const spied = {
      ...client,
      post: (message: unknown, transfer: readonly ArrayBuffer[] = []) => {
        transfers.push([...transfer]);
        client.post(message, transfer);
      },
    };
    serveModel(
      server,
      fixture('Fixture', async function* () {
        yield { type: 'done' } as const;
      }),
    );
    const model = await connectModel(spied);
    const command = new TextEncoder().encode('{"again":true}');
    await collect(model.run!(command, { id: 'first' }));
    await collect(model.run!(command, { id: 'second' }));
    expect(command.byteLength).toBe(14);
    expect(transfers.flat()).toHaveLength(0);
  });

  it('runs a structured command the served side checks', async () => {
    type Command = { readonly app: string; readonly params?: Uint8Array };
    const isCommand = check.object<Command>({
      app: check.string,
      params: check.optional(check.bytes),
    });
    const [server, client] = loopback();
    const engine = vi.fn(async function* (_command: Command): AsyncIterable<RunUpdate> {
      yield { type: 'done' };
    });
    const model = fixture<Command>('Fixture', engine);
    const _unchecked = () =>
      // @ts-expect-error A structured command is served only with its check.
      serveModel<Command>(server, model);
    serveModel<Command>(server, model, { command: isCommand });
    const remote = await connectModel<Command>(client);
    const params = Uint8Array.of(1, 2, 3);
    expect(await collect(remote.run!({ app: 'powerflow', params }, { id: 'run' }))).toEqual([
      { type: 'done' },
    ]);
    expect(engine.mock.calls[0]![0]).toEqual({ app: 'powerflow', params });
    const raw = connect(client, protocol<unknown, RunUpdate>('model:run'));
    await expect(collect(raw.stream({ app: 7 }))).rejects.toThrow(
      'model:run request.app must be a string',
    );
  });

  it('awaits the port drain between updates, so backpressure reaches the wire', async () => {
    const [server, client] = loopback();
    const drain = vi.fn(async () => {});
    serveModel(
      { ...server, drain },
      fixture('Fixture', async function* () {
        yield { type: 'running' } as const;
        yield { type: 'done' } as const;
      }),
    );
    const model = await connectModel(client);
    await collect(model.run!(COMMAND, { id: 'run' }));
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('aborts the engine when the run is cancelled, and ends it cancelled', async () => {
    const [server, client] = loopback();
    let aborted = false;
    serveModel(
      server,
      fixture('Fixture', async function* (_command, signal) {
        yield { type: 'running' } as const;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        aborted = true;
      }),
    );
    const model = await connectModel(client);
    const controller = new AbortController();
    const updates: RunUpdate[] = [];
    for await (const update of model.run!(COMMAND, { id: 'run', signal: controller.signal })) {
      updates.push(update);
      controller.abort();
    }
    expect(updates).toEqual([{ type: 'running' }, { type: 'cancelled' }]);
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('ends a run with the error its engine throws', async () => {
    const [server, client] = loopback();
    serveModel(
      server,
      fixture('Fixture', async function* () {
        yield { type: 'running' } as const;
        throw new Error('engine crashed');
      }),
    );
    const model = await connectModel(client);
    await expect(collect(model.run!(COMMAND, { id: 'run' }))).rejects.toThrow('engine crashed');
  });

  it('refuses a second run while one is live', async () => {
    const [server, client] = loopback();
    let finish!: () => void;
    serveModel(
      server,
      fixture('Fixture', async function* () {
        yield { type: 'running' } as const;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        yield { type: 'done' } as const;
      }),
    );
    const model = await connectModel(client);
    const first = model.run!(COMMAND, { id: 'first' })[Symbol.asyncIterator]();
    expect((await first.next()).value).toEqual({ type: 'running' });
    await expect(collect(model.run!(COMMAND, { id: 'second' }))).rejects.toThrow(
      /already in progress/,
    );
    finish();
    expect((await first.next()).value).toEqual({ type: 'done' });
    expect((await first.next()).done).toBe(true);
  });
});
