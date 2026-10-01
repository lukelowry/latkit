import { expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { connect, serve, messagePort, webSocket, byteTransport } from '../src/index.js';
import { FixtureModel, collect } from '../../model/tests/fixture.js';
import { decodeFrame, limits } from '../src/internal/frame.js';
import { Peer } from '../src/internal/peer.js';
import { deferred } from './fixture.js';
class Socket extends EventTarget {
  binaryType = '';
  readyState = 1;
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  peer?: Socket;
  send(frame: Uint8Array) {
    if (this.readyState !== 1) throw new Error('closed');
    this.sent.push(frame);
    const copy = frame.slice();
    queueMicrotask(() => this.peer?.dispatchEvent(new MessageEvent('message', { data: copy })));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
    const peer = this.peer;
    if (peer && peer.readyState !== 3) queueMicrotask(() => peer.close());
  }
}
it('retains an early message handshake until the client subscribes', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = messagePort(port1);
  const serving = serve(messagePort(port2), new FixtureModel());
  void serving.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const remote = await connect(client);
  expect(remote.name).toBe('Fixture');
  await remote.close();
  await serving;
});
it('preserves socket send order when later small frames would fit before earlier large ones', async () => {
  const socket = new Socket();
  const transport = webSocket(socket, { maxInFlightBytes: 4096, maxMetadataBytes: 1024 });
  socket.bufferedAmount = 3500;
  const first = transport.send({ n: 1, bytes: new Uint8Array(1000) });
  const second = transport.send({ n: 2 });
  expect(socket.sent).toHaveLength(0);
  socket.bufferedAmount = 0;
  await Promise.all([first, second]);
  expect(socket.sent.map((frame) => (decodeFrame(frame, limits()) as { n: number }).n)).toEqual([
    1, 2,
  ]);
  await transport.close();
});
it('bounds the socket queue and closing interrupts queued sends before opening', async () => {
  const socket = new Socket();
  socket.readyState = 0;
  const transport = webSocket(socket, { maxInFlightBytes: 4096, maxMetadataBytes: 1024 });
  const send = transport.send({ bytes: new Uint8Array(2500) });
  const stopped = expect(send).rejects.toMatchObject({ code: 'disconnected' });
  await expect(transport.send({ bytes: new Uint8Array(2500) })).rejects.toMatchObject({
    code: 'resource-limit',
  });
  await transport.close();
  await stopped;
});
it('serves the same contract through the socket adapter', async () => {
  const a = new Socket(),
    b = new Socket();
  a.peer = b;
  b.peer = a;
  const serving = serve(webSocket(b), new FixtureModel());
  void serving.catch(() => undefined);
  const remote = await connect(webSocket(a));
  expect(
    await collect(remote.query({ kind: 'rows', from: 'Node', select: ['value'] })),
  ).toHaveLength(2);
  await remote.close();
  await serving;
});
it('closes a connection even when its handshake send is waiting for transport', async () => {
  const socket = new Socket();
  socket.readyState = 0;
  const peer = new Peer(webSocket(socket), {});
  await Promise.resolve();
  await peer.close();
  await peer.closed;
  expect(socket.readyState).toBe(3);
});
it('handles channels that synchronously reject an initial frame', async () => {
  let closed = 0;
  const transport = byteTransport({
    send: async () => undefined,
    subscribe(receive) {
      receive(new Uint8Array([1]));
      return () => undefined;
    },
    close: async () => {
      closed++;
    },
  });
  const ended = deferred<Error | undefined>();
  transport.subscribe(
    () => undefined,
    (error) => ended.resolve(error),
  );
  expect(await ended.promise).toMatchObject({ code: 'invalid-input' });
  expect(closed).toBe(1);
  await transport.close();
});
it('rejects an incompatible wire version instead of guessing a protocol', async () => {
  const { port1, port2 } = new MessageChannel();
  const connecting = connect(messagePort(port1));
  const failed = expect(connecting).rejects.toMatchObject({ code: 'unsupported' });
  port2.postMessage({ kind: 'hello', version: 9, limits: limits() });
  await failed;
  port2.close();
});
