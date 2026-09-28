import { describe, expect, it, vi } from 'vitest';

import { connect, connectModel, loopback, protocol, serveModel } from '../src/index.js';
import { Fixture, fixture, settle } from './fixture.js';

describe('model service', () => {
  it('serves a model across the port, its classes loading as they are asked for', async () => {
    const [server, client] = loopback();
    serveModel(server, fixture('Fixture'));

    const model = await connectModel(client);
    expect(model).toMatchObject({ format: 'test', id: 'fixture', name: 'Fixture' });
    expect(model.classes.map((spec) => spec.id)).toEqual(['bus', 'line']);
    expect((await model.load('bus')).labels).toEqual(['Bus 1', 'Bus 2']);
    expect(new TextDecoder().decode(await model.bytes())).toBe('Fixture');
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
    const opened = (await raw.call({ op: 'open' })) as { readonly home: unknown };
    expect(typeof opened.home).toBe('string');
  });

  it('relays a model it opened from packs as they came, decoding none', async () => {
    const [server, client] = loopback();
    const [relay, page] = loopback();
    const origin = new Fixture();
    const shards = vi.spyOn(origin, 'source');
    serveModel(server, origin);
    const opened = await connectModel(client);
    const load = vi.spyOn(opened, 'load');
    serveModel(relay, opened);
    const model = await connectModel(page);
    expect((await model.load('bus')).labels).toEqual(['Bus 1', 'Bus 2']);
    expect(load).not.toHaveBeenCalled();
    expect(shards).toHaveBeenCalled();
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
  it('serves scoped snapshots alongside the default model and closes them independently', async () => {
    const [server, client] = loopback();
    serveModel(server, fixture('Default'));
    serveModel(server, fixture('First'), { id: 'first' });
    serveModel(server, fixture('Second'), { id: 'second' });
    const [base, first, second] = await Promise.all([
      connectModel(client),
      connectModel(client, { id: 'first' }),
      connectModel(client, { id: 'second' }),
    ]);
    expect([base.name, first.name, second.name]).toEqual(['Default', 'First', 'Second']);
    first.close();
    await expect(first.bytes()).rejects.toThrow('closed');
    expect(new TextDecoder().decode(await second.bytes())).toBe('Second');
    expect(new TextDecoder().decode(await base.bytes())).toBe('Default');
    base.close();
    second.close();
  });
});
