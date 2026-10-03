import { afterEach, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { LogEntry, Model, Publication } from '@latkit/model';
import { acceptModel, connectModel } from '../src/index.js';
import type { ConnectedModel } from '../src/index.js';
import { deferred } from '../src/core.js';
import { Op } from '../src/frame.js';
import { batch, collect, fields, listen, pair, schema } from './fixture.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const grid: Model = {
  name: 'grid',
  schema,
  monitor: function* () {
    yield batch(4, 2);
  },
  commands: {
    solve: {
      parameters: {},
      async run(_, ctx) {
        ctx.log({ severity: 'info', message: 'solving' });
        await ctx.publish(batch(16, 3));
        return 'solved';
      },
    },
  },
};

/** A server that offers `model` on every socket it accepts, and the URL to dial it at. */
async function offering(model: Model) {
  const sockets: WebSocket[] = [];
  const server = await listen((socket) => {
    sockets.push(socket);
    void connectModel(model, { socket }).catch(() => {});
  });
  cleanup.push(server.close);
  return { url: server.url + '/grid', sockets };
}

/** The publication frames a socket sent, from byte 16 on. */
function sentPayloads(socket: WebSocket): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  const send = socket.send.bind(socket);
  socket.send = ((data: Uint8Array, ...rest: never[]) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(4, true) === Op.publication)
      payloads.push(Uint8Array.from(data.subarray(16)));
    return send(data, ...rest);
  }) as typeof socket.send;
  return payloads;
}

it('accepts a model by dialing it, offered on the socket a server accepted', async () => {
  const { url } = await offering(grid);
  const model = await acceptModel({ url });
  cleanup.push(() => model.close());
  expect(model.name).toBe('grid');
  expect(await collect(model.monitor!(fields))).toEqual([[batch(4, 2)]]);
  const received: Publication[] = [];
  await expect(
    model.commands.solve.run(
      {},
      {
        outputs: fields,
        publish: async (publication) => void received.push(publication as Publication),
      },
    ),
  ).resolves.toBe('solved');
  expect(received).toEqual([[batch(16, 3)]]);
});

it('serves an accepted model onward as it is, sending publications on as the bytes that arrived', async () => {
  const p = await pair(grid);
  cleanup.push(p.close);
  const arrived: Uint8Array[] = [];
  p.socket.on('message', (data: ArrayBuffer) => {
    if (new DataView(data).getUint32(4, true) === Op.publication)
      arrived.push(new Uint8Array(data.slice(16)));
  });
  const { url, sockets } = await offering(p.model);
  const page = await acceptModel({ url });
  cleanup.push(() => page.close());
  const onward = sentPayloads(sockets[0]);
  const logs: LogEntry[] = [];
  const received: Publication[] = [];
  expect(await collect(page.monitor!(fields))).toEqual([[batch(4, 2)]]);
  await expect(
    page.commands.solve.run(
      {},
      {
        outputs: fields,
        publish: async (publication) => void received.push(publication as Publication),
        log: (entry) => logs.push(entry),
      },
    ),
  ).resolves.toBe('solved');
  expect(received).toEqual([[batch(16, 3)]]);
  expect(logs.map(({ message }) => message)).toEqual(['solving']);
  expect(onward).toHaveLength(2);
  expect(onward).toEqual(arrived);
});

it('closes the connections serving a model when it closes, with its reason', async () => {
  const p = await pair(grid);
  cleanup.push(p.close);
  const { url } = await offering(p.model);
  const page = await acceptModel({ url });
  cleanup.push(() => page.close());
  const closed = expect(page.closed).rejects.toMatchObject({ code: 'disconnected' });
  await p.connection.close();
  await closed;
});

it('fails with the reason a server gives when it turns a socket away', async () => {
  const server = await listen((socket) => socket.close(4404, 'No model named grid is connected.'));
  cleanup.push(server.close);
  await expect(acceptModel({ url: server.url + '/grid' })).rejects.toMatchObject({
    code: 'disconnected',
    message: 'No model named grid is connected.',
  });
});

it('reads nothing for an empty selection, and has no monitor when the model offers none', async () => {
  let reads = 0;
  const p = await pair({
    monitor: function* () {
      reads++;
      yield batch();
    },
  });
  cleanup.push(p.close);
  expect(await collect(p.model.monitor!([]))).toEqual([]);
  expect(reads).toBe(0);
  const silent = await pair({ commands: { ping: { parameters: {}, run: () => 'pong' } } });
  cleanup.push(silent.close);
  expect(silent.model.monitor).toBeUndefined();
  await expect(silent.model.commands.ping.run({})).resolves.toBe('pong');
});

it('refuses a socket that negotiated the other role', async () => {
  const accepted = deferred<ConnectedModel>();
  // A server accepting what it should connect: both sides wait to be offered a model.
  const server = await listen((socket) => {
    void acceptModel({ socket, limits: { timeoutMs: 200 } }).then(
      accepted.resolve,
      accepted.reject,
    );
  });
  cleanup.push(server.close);
  await expect(acceptModel({ url: server.url, limits: { timeoutMs: 200 } })).rejects.toThrow();
  await expect(accepted.promise).rejects.toThrow(/latkit.connect/);
});
