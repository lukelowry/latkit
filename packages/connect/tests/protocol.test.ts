import { expect, it } from 'vitest';
import { connect, serve } from '../src/index.js';
import { Peer } from '../src/internal/peer.js';
import { LiveModel } from '../../model/tests/live.js';
import { transports } from './fixture.js';
it.each([false, true])(
  'has no historical read or retention wire operations (framed=%s)',
  async (framed) => {
    const [client, server] = transports(framed),
      serving = serve(server, new LiveModel()),
      peer = new Peer(client, {});
    try {
      await peer.ready;
      await peer.call(0, 'acquire', null);
      for (const method of ['query', 'retain', 'export', 'describe', 'run'])
        await expect(peer.call(0, method, {})).rejects.toMatchObject({ code: 'unsupported' });
    } finally {
      await peer.close();
      await serving;
    }
  },
);
it.each([2, 3])('rejects previous protocol %s before dispatch', async (version) => {
  const [client, server] = transports();
  server.subscribe(
    (value) => {
      const m = value as { kind: string; limits: unknown };
      if (m.kind === 'hello') void server.send({ kind: 'hello', version, limits: m.limits });
    },
    () => {},
  );
  try {
    await expect(connect(client)).rejects.toMatchObject({ code: 'unsupported' });
  } finally {
    await server.close();
  }
});
it.each(
  [
    [{ kind: 'data', version: 'x', block: {} }],
    [
      { kind: 'begin', version: 'x', initial: false },
      { kind: 'end', version: 'y' },
    ],
    [{ kind: 'begin', version: 'x', initial: false }],
  ].map((events) => ({ events })),
)('rejects malformed or incomplete publications', async ({ events }) => {
  const model = new LiveModel();
  model.monitor = async function* () {
    yield* events as never[];
  };
  const [client, server] = transports(),
    serving = serve(server, model),
    remote = await connect(client);
  try {
    await expect(
      (async () => {
        for await (const e of remote.monitor([{ from: 'Node', select: ['value'] }])) void e;
      })(),
    ).rejects.toBeDefined();
  } finally {
    await remote.close();
    await serving;
  }
});

it('validates subscriptions before invoking a provider', async () => {
  const model = new LiveModel();
  let called = false;
  model.monitor = () => {
    called = true;
    return (async function* () {
      yield* [];
    })();
  };
  const [client, server] = transports(),
    serving = serve(server, model),
    peer = new Peer(client, {});
  try {
    await peer.ready;
    await expect(
      peer.call(0, 'monitor', { fields: [{ from: 'Node', select: ['missing'] }] }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(called).toBe(false);
  } finally {
    await peer.close();
    await serving;
  }
});
it('rejects unsolicited publication columns', async () => {
  const model = new LiveModel();
  model.monitor = async function* () {
    yield { kind: 'begin', version: 'v1', initial: true };
    yield {
      kind: 'data',
      version: 'v1',
      block: {
        kind: 'rows',
        index: { source: 'test', type: 'Node', version: 'v1' },
        rows: { kind: 'range', offset: 0, count: 1 },
        columns: { value: { kind: 'numeric', offset: 0, length: 1, values: Float64Array.of(1) } },
      },
    };
    yield { kind: 'end', version: 'v1' };
  };
  const [client, server] = transports(),
    serving = serve(server, model),
    remote = await connect(client);
  try {
    await expect(
      (async () => {
        for await (const event of remote.monitor([])) void event;
      })(),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  } finally {
    await remote.close();
    await serving;
  }
});

it.each([false, true])(
  'rejects replacement operations at the publication boundary (framed=%s)',
  async (framed) => {
    const model = new LiveModel();
    model.monitor = async function* () {
      yield { kind: 'begin', version: 'v1', initial: true };
      yield {
        kind: 'data',
        version: 'v1',
        block: {
          kind: 'rows',
          index: { source: 'test', type: 'Node', version: 'v1' },
          rows: { kind: 'range', offset: 0, count: 1 },
          columns: { value: { kind: 'numeric', offset: 0, length: 1, values: Float64Array.of(1) } },
          replace: true,
        },
      };
      yield { kind: 'end', version: 'v1' };
    };
    const [client, server] = transports(framed);
    const serving = serve(server, model);
    const remote = await connect(client);
    try {
      await expect(
        (async () => {
          for await (const event of remote.monitor([{ from: 'Node', select: ['value'] }]))
            void event;
        })(),
      ).rejects.toMatchObject({ code: 'invalid-input' });
    } finally {
      await remote.close();
      await serving;
    }
  },
);
