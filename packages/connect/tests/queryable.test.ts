import { describe, expect, it } from 'vitest';
import type { MonitorConfig, RetainOptions } from '@latkit/model';
import { connect, serve } from '../src/index.js';
import { Peer } from '../src/internal/peer.js';
import { FixtureService, FixtureModel, collect } from '../../model/tests/fixture.js';
import { ScaleService } from '../../model/tests/scale/service.js';
import { open, transports, deferred } from './fixture.js';
const rows = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const monitor: MonitorConfig = {
  scope: { kind: 'live' },
  fields: [{ from: 'Node', select: ['output'] }],
  retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
};
for (const framed of [false, true])
  describe(framed ? 'framed Queryable capability' : 'message Queryable capability', () => {
    it('exposes only read methods and borrows its supplied root', async () => {
      const model = new FixtureModel(),
        recording = await model.monitor(monitor);
      model.live(1);
      const [client, server] = transports(framed);
      const serving = serve(server, recording, { kind: 'queryable' });
      const remote = await connect(client, { kind: 'queryable' });
      try {
        expect(Object.keys(remote).sort()).toEqual(
          ['version', 'describe', 'query', 'retain', 'close', 'on', 'closed'].sort(),
        );
        expect('stop' in remote).toBe(false);
        expect('export' in remote).toBe(false);
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
      expect(model.document.retention.bytes).toBe(0);
    });
    it('propagates live changes and releases children when the root owner closes', async () => {
      const model = new FixtureModel(),
        [client, server] = transports(framed);
      const serving = serve(server, model.document, { kind: 'queryable' });
      const remote = await connect(client, { kind: 'queryable' });
      const changed = deferred(),
        closed = deferred();
      remote.on('change', (c) => {
        if (c.kind === 'data') changed.resolve();
        if (c.kind === 'closed') closed.resolve();
      });
      const source = await remote.retain();
      await model.document.edit!([{ kind: 'set', id: 'n1', values: { value: 42 } }]);
      await changed.promise;
      expect(remote.version).toBe(model.document.version);
      await model.close();
      await remote.closed;
      await serving;
      await closed.promise;
      await expect(source.describe()).rejects.toMatchObject({ code: 'closed' });
      expect(model.document.retention.bytes).toBe(0);
    });
    it('rejects wire attempts to invoke mutation or recording controls', async () => {
      const model = new FixtureModel(),
        recording = await model.monitor(monitor),
        [client, server] = transports(framed);
      const serving = serve(server, recording, { kind: 'queryable' });
      const peer = new Peer(client, {});
      try {
        await peer.ready;
        await peer.call(0, 'acquire', { kind: 'queryable' });
        for (const method of ['stop', 'monitor', 'edit', 'call', 'model', 'recording', 'export'])
          await expect(peer.call(0, method, {})).rejects.toMatchObject({ code: 'unsupported' });
        expect(recording.status).toBe('monitoring');
      } finally {
        await peer.close();
        await serving;
        await recording.close();
        await model.close();
      }
    });
    it('reacquires recordings across connections and retains data after producer disconnect', async () => {
      const service = new FixtureService(),
        producer = await open(service, framed),
        consumer = await open(service, framed);
      try {
        const document = await producer.remote.open(),
          model = await producer.remote.model(document.id);
        const recording = await model.monitor!(monitor);
        service.models[0].live(4);
        const other = await consumer.remote.recording(recording.id);
        const source = await other.retain();
        await producer.close();
        expect(await other.done).toMatchObject({ reason: 'model-closed' });
        expect(other.modelId).toBe(model.id);
        expect((await collect(other.query(rows))).length).toBe(2);
        await other.close();
        await expect(consumer.remote.recording(recording.id)).rejects.toMatchObject({
          code: 'closed',
        });
        expect((await collect(source.query(rows))).length).toBe(2);
        await source.close();
        expect(service.retention.bytes).toBe(0);
      } finally {
        await producer.close();
        await consumer.close();
      }
    });
    it('preserves retained references after closing their document acquisition', async () => {
      const connection = await open(undefined, framed);
      try {
        const document = await connection.remote.open(),
          source = await document.retain(),
          child = await source.retain();
        await document.close();
        await source.close();
        expect((await collect(child.query(rows))).length).toBe(2);
        await child.close();
        expect(connection.service.retention.bytes).toBe(0);
      } finally {
        await connection.close();
      }
    });
    it('unwinds a retained acquisition if reference publication exceeds the limit', async () => {
      const connection = await open(undefined, framed, { limits: { maxReferences: 2 } });
      try {
        const document = await connection.remote.open();
        for (let i = 0; i < 3; i++) {
          await expect(document.retain()).rejects.toMatchObject({ code: 'resource-limit' });
          expect(connection.service.retention.bytes).toBe(0);
        }
        await document.close();
      } finally {
        await connection.close();
      }
    });
    it('cancels an in-flight retained admission and releases its eventual native result', async () => {
      const model = new FixtureModel(),
        gate = deferred(),
        started = deferred(),
        original = model.document.retain.bind(model.document);
      model.document.retain = async (options?: RetainOptions) => {
        const source = await original(options);
        started.resolve();
        await gate.promise;
        return source;
      };
      const [client, server] = transports(framed),
        serving = serve(server, model.document, { kind: 'queryable' });
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
      expect(model.document.retention.bytes).toBe(0);
    });
    it('disconnects a blocked retained query without closing the supplied acquisition', async () => {
      const service = new ScaleService(1000),
        doc = await service.open(),
        source = await doc.retain();
      const [client, server] = transports(framed),
        serving = serve(server, source, { kind: 'queryable' });
      const remote = await connect(client, { kind: 'queryable' });
      const iterator = remote.query(rows)[Symbol.asyncIterator]();
      await iterator.next();
      service.pause(true);
      const pending = iterator.next();
      const rejected = expect(pending).rejects.toBeDefined();
      await remote.close();
      await rejected;
      await serving;
      service.pause(false);
      expect((await collect(source.query(rows))).length).toBeGreaterThan(0);
      await source.close();
      await doc.close();
      expect(service.stats.activeReads).toBe(0);
      expect(service.stats.acquisitions).toBe(0);
    });
  });
it.each(['service', 'queryable'] as const)(
  'rejects a %s root when the other capability is requested',
  async (kind) => {
    const model = new FixtureModel(),
      service = new FixtureService(),
      [client, server] = transports();
    const serving =
      kind === 'service'
        ? serve(server, service)
        : serve(server, model.document, { kind: 'queryable' });
    void serving.catch(() => undefined);
    if (kind === 'service')
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
    const document = await connection.remote.open();
    const native = connection.service.documents.get(document.id)!;
    const retain = native.retain.bind(native);
    native.retain = async (options) => {
      const source = await retain(options);
      source.on = () => {
        throw Object.assign(new Error('closed during publication'), { code: 'closed' });
      };
      return source;
    };
    for (let i = 0; i < 5; i++) {
      await expect(document.retain()).rejects.toMatchObject({ code: 'closed' });
      expect(connection.service.retention.bytes).toBe(0);
    }
    native.retain = retain;
    const source = await document.retain();
    expect(await source.describe()).toBeDefined();
    await source.close();
    await document.close();
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
