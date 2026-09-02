import { describe, expect, it, vi } from 'vitest';

import { openModel, type RunUpdate } from '@latkit/model';
import { connect, protocol } from '@latkit/port';
import { loopback, settle } from '@latkit/port/testing';

import { connectSource, type Served, serveSource } from '../src/index.js';
import { collect, fixtureSource, FRAMES } from './fixture.js';

describe('source service', () => {
  it('serves a model across the port: core, classes, and bytes', async () => {
    const [server, client] = loopback();
    const closed = vi.fn();
    serveSource(server, { source: fixtureSource('Fixture', closed) });

    const remote = await connectSource(client);
    expect(remote.runner).toBeUndefined();
    const model = await openModel(remote.source);
    expect(model).toMatchObject({ vendor: 'test', id: 'fixture', name: 'Fixture' });
    expect(model.classes.map((spec) => spec.id)).toEqual(['bus', 'line']);
    expect((await model.load('bus')).labels).toEqual(['Bus 1', 'Bus 2']);
    expect(new TextDecoder().decode(await model.bytes())).toBe('Fixture');
    expect(closed).not.toHaveBeenCalled();
  });

  it('serves a source that is still opening, so no early request is lost', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    serveSource(
      server,
      new Promise<Served>((resolve) => (release = () => resolve({ source: fixtureSource() }))),
    );
    const opening = connectSource(client);
    await settle();
    release();
    const model = await openModel((await opening).source);
    expect(model.name).toBe('Fixture');
  });

  it('a source that fails to open rejects the connect and nothing else', async () => {
    const [server, client] = loopback();
    serveSource(server, Promise.reject(new Error('bad case')));
    await settle();
    await expect(connectSource(client)).rejects.toThrow('bad case');
  });

  it('reports core download progress to the opener', async () => {
    const [server, client] = loopback();
    const source = fixtureSource();
    serveSource(server, {
      source: {
        ...source,
        core: async (_signal, progress) => {
          progress?.(5, 10);
          progress?.(10, 10);
          return source.core();
        },
      },
    });
    const progress = vi.fn();
    await openModel((await connectSource(client)).source, { progress });
    expect(progress.mock.calls).toEqual([
      [5, 10],
      [10, 10],
    ]);
  });

  it('reopen supersedes the old remote and serves the sibling from then on', async () => {
    const [server, client] = loopback();
    const closed = vi.fn();
    serveSource(
      server,
      { source: fixtureSource('First', closed) },
      {
        reopen: async (bytes) => ({
          source: fixtureSource(new TextDecoder().decode(bytes)),
          runner: { run: vi.fn() },
        }),
      },
    );
    const first = await connectSource(client);
    const second = await first.reopen(new TextEncoder().encode('Second'));
    expect((await openModel(second.source)).name).toBe('Second');
    expect(second.runner).toBeDefined(); // the sibling can run even though the first could not
    expect(closed).toHaveBeenCalledOnce();
    await expect(first.source.bytes()).rejects.toThrow(/superseded/);
    await expect(first.reopen(new Uint8Array())).rejects.toThrow(/superseded/);
    first.close(); // a superseded remote owns nothing
    expect(new TextDecoder().decode(await second.source.bytes())).toBe('Second');
  });

  it('closing the current remote closes the service on both sides', async () => {
    const [server, client] = loopback();
    const closed = vi.fn();
    const onClose = vi.fn();
    serveSource(server, { source: fixtureSource('Fixture', closed) }, { onClose });
    const remote = await connectSource(client);
    remote.close();
    await expect(remote.source.bytes()).rejects.toThrow(/closed/);
    await settle();
    expect(closed).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('a server-side close, like a crashed worker, rejects everything pending', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    const source = fixtureSource();
    const stop = serveSource(server, {
      source: {
        ...source,
        bytes: () =>
          new Promise<Uint8Array>((resolve) => (release = () => resolve(new Uint8Array()))),
      },
    });
    const remote = await connectSource(client);
    const pending = remote.source.bytes();
    await settle();
    stop();
    await expect(pending).rejects.toThrow(/service was closed/);
    await expect(remote.source.class('bus')).rejects.toThrow(/service was closed/);
    release();
  });

  it('surfaces a source failure as the request rejection and keeps serving', async () => {
    const [server, client] = loopback();
    const source = fixtureSource();
    serveSource(server, {
      source: {
        ...source,
        bytes: async () => {
          throw new Error('disk on fire');
        },
      },
    });
    const remote = await connectSource(client);
    await expect(remote.source.bytes()).rejects.toThrow('disk on fire');
    expect((await remote.source.class('bus')).byteLength).toBeGreaterThan(0);
  });

  it('rejects a malformed request without ending the service', async () => {
    const [server, client] = loopback();
    serveSource(server, { source: fixtureSource() });
    const raw = connect(client, protocol<unknown, unknown>('source'));
    await expect(raw.call({ op: 'class' })).rejects.toThrow(/malformed source request/);
    await expect(raw.call({ op: 'reopen', bytes: 'text' })).rejects.toThrow(/malformed/);
    await expect(raw.call({ op: 'nope' })).rejects.toThrow(/malformed/);
    expect(await raw.call({ op: 'hello' })).toEqual({ runnable: false });
    const runs = connect(client, protocol<unknown, unknown>('source:run'));
    await expect(runs.call('not bytes')).rejects.toThrow(/malformed source:run request/);
  });

  it('opening against a source that cannot produce a core rejects', async () => {
    const [server, client] = loopback();
    serveSource(server, {
      source: {
        ...fixtureSource(),
        core: async () => {
          throw new Error('no core');
        },
      },
    });
    await expect(openModel((await connectSource(client)).source)).rejects.toThrow('no core');
  });
});

const COMMAND = new TextEncoder().encode('{}');

describe('source service: run', () => {
  it('streams a run through the remote runner and ends with the stream', async () => {
    const [server, client] = loopback();
    const run = vi.fn(async function* (_command: Uint8Array): AsyncIterable<RunUpdate> {
      yield { type: 'started', id: 'r' };
      yield FRAMES;
      yield { type: 'done' };
    });
    serveSource(server, { source: fixtureSource(), runner: { run } });
    const remote = await connectSource(client);
    expect(await collect(remote.runner!.run(COMMAND))).toEqual([
      { type: 'started', id: 'r' },
      FRAMES,
      { type: 'done' },
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(run.mock.calls[0]![0])).toBe('{}');
  });

  it('awaits the port drain between updates so backpressure reaches the wire', async () => {
    const [server, client] = loopback();
    const drain = vi.fn(async () => {});
    serveSource(
      { ...server, drain },
      {
        source: fixtureSource(),
        runner: {
          run: async function* () {
            yield { type: 'started', id: 'r' };
            yield { type: 'done' };
          },
        },
      },
    );
    const remote = await connectSource(client);
    await collect(remote.runner!.run(COMMAND));
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('cancelling aborts the runner and ends the stream without throwing', async () => {
    const [server, client] = loopback();
    let aborted = false;
    serveSource(server, {
      source: fixtureSource(),
      runner: {
        run: async function* (_command, signal) {
          yield { type: 'started', id: 'r' };
          await new Promise<void>((resolve) =>
            signal?.addEventListener('abort', () => resolve(), { once: true }),
          );
          aborted = true;
          yield { type: 'cancelled' };
        },
      },
    });
    const remote = await connectSource(client);
    const controller = new AbortController();
    const updates: RunUpdate[] = [];
    for await (const update of remote.runner!.run(COMMAND, controller.signal)) {
      updates.push(update);
      controller.abort();
    }
    expect(updates).toEqual([{ type: 'started', id: 'r' }]);
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('a runner failure ends the stream with its error', async () => {
    const [server, client] = loopback();
    serveSource(server, {
      source: fixtureSource(),
      runner: {
        run: async function* () {
          yield { type: 'started', id: 'r' };
          throw new Error('engine crashed');
        },
      },
    });
    const remote = await connectSource(client);
    await expect(collect(remote.runner!.run(COMMAND))).rejects.toThrow('engine crashed');
  });

  it('refuses a second run while one is live', async () => {
    const [server, client] = loopback();
    let finish!: () => void;
    serveSource(server, {
      source: fixtureSource(),
      runner: {
        run: async function* () {
          yield { type: 'started', id: 'r' };
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          yield { type: 'done' };
        },
      },
    });
    const remote = await connectSource(client);
    const first = remote.runner!.run(COMMAND)[Symbol.asyncIterator]();
    expect((await first.next()).value).toEqual({ type: 'started', id: 'r' });
    await expect(collect(remote.runner!.run(COMMAND))).rejects.toThrow(/already in progress/);
    finish();
    expect((await first.next()).value).toEqual({ type: 'done' });
    expect((await first.next()).done).toBe(true);
  });

  it('a superseded remote cannot run', async () => {
    const [server, client] = loopback();
    serveSource(
      server,
      { source: fixtureSource(), runner: { run: vi.fn() } },
      { reopen: async () => ({ source: fixtureSource() }) },
    );
    const first = await connectSource(client);
    await first.reopen(new TextEncoder().encode('Second'));
    await expect(collect(first.runner!.run(COMMAND))).rejects.toThrow(/superseded/);
  });
});
