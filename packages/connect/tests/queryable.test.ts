import { describe, expect, it } from 'vitest';
import type { FieldSelection, RetainOptions } from '@latkit/model';
import { connect, serve } from '../src/index.js';
import { Peer } from '../src/internal/peer.js';
import { FixtureModel, collect } from '../../model/tests/fixture.js';
import { ScaleModel } from '../../model/tests/scale/model.js';
import { open, transports, deferred } from './fixture.js';
const rows = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const output: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
/** A model with a monitor holding one computed frame. */
async function monitored() {
  const model = new FixtureModel(),
    recording = await model.monitor(output);
  const command = model.run({ routine: 'solve', values: {} });
  model.frame(1);
  model.finish();
  await command;
  return { model, recording };
}
for (const framed of [false, true])
  describe(framed ? 'framed Queryable capability' : 'message Queryable capability', () => {
    it('exposes only read methods and borrows its supplied root', async () => {
      const { model, recording } = await monitored();
      const [client, server] = transports(framed);
      const serving = serve(server, recording, { kind: 'queryable' });
      const remote = await connect(client, { kind: 'queryable' });
      try {
        expect(Object.keys(remote).sort()).toEqual(
          ['version', 'describe', 'query', 'retain', 'close', 'on', 'closed'].sort(),
        );
        expect('export' in remote).toBe(false);
        expect('run' in remote).toBe(false);
        const source = await remote.retain(),
          child = await source.retain();
        await source.close();
        await model.close();
        expect((await collect(child.query(rows))).length).toBe(2);
        await child.close();
      } finally {
        await remote.close();
        await serving;
      }
      expect((await collect(recording.query(rows))).length).toBe(2);
      await recording.close();
      expect(model.retention.bytes).toBe(0);
    });
    it('propagates changes and releases children when the root owner closes', async () => {
      const model = new FixtureModel(),
        [client, server] = transports(framed);
      const serving = serve(server, model, { kind: 'queryable' });
      const remote = await connect(client, { kind: 'queryable' });
      const changed = deferred(),
        closed = deferred();
      remote.on('change', (c) => {
        if (c.kind === 'replace') changed.resolve();
        if (c.kind === 'closed') closed.resolve();
      });
      const source = await remote.retain();
      model.replace(new Float64Array([42, 2, 3, 4]));
      await changed.promise;
      expect(remote.version).toBe(model.version);
      await model.close();
      await remote.closed;
      await serving;
      await closed.promise;
      await expect(source.describe()).rejects.toMatchObject({ code: 'closed' });
      expect(model.retention.bytes).toBe(0);
    });
    it('rejects wire attempts to invoke computation or monitor controls', async () => {
      const { model, recording } = await monitored(),
        [client, server] = transports(framed);
      const serving = serve(server, recording, { kind: 'queryable' });
      const peer = new Peer(client, {});
      try {
        await peer.ready;
        await peer.call(0, 'acquire', { kind: 'queryable' });
        for (const method of ['monitor', 'run', 'export', 'edit', 'call', 'stop'])
          await expect(peer.call(0, method, {})).rejects.toMatchObject({ code: 'unsupported' });
        expect(recording.status).toBe('complete');
      } finally {
        await peer.close();
        await serving;
        await recording.close();
        await model.close();
      }
    });
    it('preserves retained references after closing their parent acquisition', async () => {
      const connection = await open(undefined, framed);
      try {
        const source = await connection.remote.retain(),
          child = await source.retain();
        await source.close();
        expect((await collect(child.query(rows))).length).toBe(2);
        await child.close();
        expect(connection.model.retention.bytes).toBe(0);
      } finally {
        await connection.close();
      }
    });
    it('unwinds a retained acquisition if reference publication exceeds the limit', async () => {
      const connection = await open(undefined, framed, { limits: { maxReferences: 1 } });
      try {
        for (let i = 0; i < 3; i++) {
          await expect(connection.remote.retain()).rejects.toMatchObject({
            code: 'resource-limit',
          });
          expect(connection.model.retention.bytes).toBe(0);
        }
      } finally {
        await connection.close();
      }
    });
    it('cancels an in-flight retained admission and releases its eventual native result', async () => {
      const model = new FixtureModel(),
        gate = deferred(),
        started = deferred(),
        original = model.retain.bind(model);
      model.retain = async (options?: RetainOptions) => {
        const source = await original(options);
        started.resolve();
        await gate.promise;
        return source;
      };
      const [client, server] = transports(framed),
        serving = serve(server, model, { kind: 'queryable' });
      const remote = await connect(client, { kind: 'queryable' });
      try {
        const controller = new AbortController(),
          pending = remote.retain({ signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
        await started.promise;
        controller.abort();
        await rejected;
        gate.resolve();
        // The next request is a transport fence; the cancelled result must be discarded.
        await remote.describe();
      } finally {
        gate.resolve();
        await remote.close();
        await serving;
        await model.close();
      }
      expect(model.retention.bytes).toBe(0);
    });
    it('disconnects a blocked retained query without closing the supplied acquisition', async () => {
      const model = new ScaleModel(1000),
        source = await model.retain();
      const [client, server] = transports(framed),
        serving = serve(server, source, { kind: 'queryable' });
      const remote = await connect(client, { kind: 'queryable' });
      const iterator = remote.query(rows)[Symbol.asyncIterator]();
      await iterator.next();
      model.pause(true);
      const pending = iterator.next();
      const rejected = expect(pending).rejects.toBeDefined();
      await remote.close();
      await rejected;
      await serving;
      model.pause(false);
      expect((await collect(source.query(rows))).length).toBeGreaterThan(0);
      await source.close();
      await model.close();
      expect(model.stats.activeReads).toBe(0);
      expect(model.stats.acquisitions).toBe(0);
    });
  });
it.each(['model', 'queryable'] as const)(
  'rejects a %s root when the other capability is requested',
  async (kind) => {
    const model = new FixtureModel(),
      [client, server] = transports();
    const serving =
      kind === 'model' ? serve(server, model) : serve(server, model, { kind: 'queryable' });
    void serving.catch(() => undefined);
    if (kind === 'model')
      await expect(connect(client, { kind: 'queryable' })).rejects.toMatchObject({
        code: 'unsupported',
      });
    else await expect(connect(client)).rejects.toMatchObject({ code: 'unsupported' });
    await serving;
    await model.close();
  },
);

it('reclaims native data and reference slots when acquisition subscription fails', async () => {
  const connection = await open(undefined, false, { limits: { maxReferences: 3 } });
  try {
    const native = connection.model;
    const retain = native.retain.bind(native);
    native.retain = async (options) => {
      const source = await retain(options);
      source.on = () => {
        throw Object.assign(new Error('closed during publication'), { code: 'closed' });
      };
      return source;
    };
    for (let i = 0; i < 5; i++) {
      await expect(connection.remote.retain()).rejects.toMatchObject({ code: 'closed' });
      expect(native.retention.bytes).toBe(0);
    }
    native.retain = retain;
    const source = await connection.remote.retain();
    expect(await source.describe()).toBeDefined();
    await source.close();
  } finally {
    await connection.close();
  }
});
it('rejects the previous wire version before contract dispatch', async () => {
  const [client, server] = transports();
  const off = server.subscribe(
    (value) => {
      const message = value as { kind: string; limits?: unknown };
      if (message.kind === 'hello')
        void server.send({ kind: 'hello', version: 1, limits: message.limits });
    },
    () => undefined,
  );
  const peer = new Peer(client, {});
  try {
    await expect(peer.ready).rejects.toMatchObject({ code: 'unsupported' });
  } finally {
    await peer.close();
    off();
    await server.close();
  }
});
