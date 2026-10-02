import { expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { defaults } from '../src/core.js';
import { Op, decode, prepare } from '../src/frame.js';
import type { WebSocketLike } from '../src/types.js';
import { batch, schema, pause } from './fixture.js';
import { preparePublication } from '../src/columns.js';

class Socket implements WebSocketLike {
  readyState = 1;
  protocol = 'latkit';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  listeners = new Map<string, Set<(event: { data: unknown }) => void>>();
  peer?: Socket;
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: Uint8Array<ArrayBuffer>) {
    this.sent.push(data);
    const copy = Uint8Array.from(data);
    queueMicrotask(() => this.peer?.emit('message', copy.buffer));
  }
  emit(type: string, data: unknown = undefined) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close'));
  }
}
function sessions() {
  const a = new Socket(),
    b = new Socket();
  a.peer = b;
  b.peer = a;
  const bounds = {
    maxMessageBytes: 8192,
    maxMetadataBytes: 1024,
    maxBufferedBytes: 16384,
    streamWindowBytes: 8192,
    streamWindowMessages: 2,
    maxBufferedMessages: 4,
    timeoutMs: 100,
  };
  return {
    a,
    b,
    producer: new Session(a, { limits: bounds }),
    host: new Session(b, { limits: bounds }),
  };
}
it('pipelines up to credit, holds one pending publish, and acknowledges consumption once', async () => {
  const p = sessions(),
    receiver = p.host.receiver(1),
    sender = p.producer.sender(1, receiver.windowBytes, receiver.windowMessages);
  try {
    const plan = preparePublication(batch(), 1, schema, p.producer.bounds);
    await sender.write(plan);
    await sender.write(plan);
    let completed = false;
    const third = sender.write(plan).then(() => {
      completed = true;
    });
    await pause(5);
    expect(completed).toBe(false);
    expect(p.b.sent).toHaveLength(0);
    await receiver.next();
    await pause(2);
    expect(completed).toBe(false);
    await receiver.next();
    await third;
    expect(completed).toBe(true);
    await sender.finish(Op.end);
    expect((await receiver.next()).done).toBe(false);
    expect((await receiver.next()).done).toBe(true);
    await pause(5);
    expect(p.producer.senders.size).toBe(0);
    expect(p.host.receivers.size).toBe(0);
    const acks = p.b.sent.map((v) => decode(v, defaults)).filter((f) => f.op === Op.ack);
    expect(acks.filter((f) => f.metadata.terminal)).toHaveLength(1);
  } finally {
    await p.producer.close();
    await p.host.close();
  }
});
it('reserves a global byte and message budget across streams', async () => {
  const p = sessions();
  try {
    p.host.receiver(1);
    p.host.receiver(2);
    expect(() => p.host.receiver(3)).toThrow(/budget/);
    p.producer.sender(1, 8192, 2);
    p.producer.sender(2, 8192, 2);
    expect(() => p.producer.sender(3, 8192, 2)).toThrow(/budget/);
  } finally {
    await p.producer.close();
    await p.host.close();
  }
});
it('rejects over-credit data and out-of-order sequences at the receiving boundary', async () => {
  for (const sequence of [3, 1]) {
    const p = sessions();
    p.host.receiver(1);
    const rejected = expect(p.host.closed).rejects.toThrow();
    const frame = preparePublication(batch(), 1, schema, p.host.bounds);
    p.b.emit('message', frame.encode(sequence).buffer);
    if (sequence === 1) p.b.emit('message', frame.encode(1).buffer);
    await rejected;
    await p.producer.close();
    await p.host.close();
  }
});
it('orders bounded controls when the socket is stalled and wakes on disconnect', async () => {
  const p = sessions();
  p.a.bufferedAmount = 16384;
  p.host.onControl = () => {};
  const first = p.producer.control(Op.monitor, 1, { order: 1 });
  const second = p.producer.control(Op.cancel, 1);
  await pause(5);
  expect(p.a.sent).toHaveLength(0);
  p.a.bufferedAmount = 0;
  await Promise.all([first, second]);
  expect(p.a.sent.map((b) => decode(b, defaults).op)).toEqual([Op.monitor, Op.cancel]);
  await p.producer.close();
  await p.host.close();
});
it('rejects malformed messages and missing negotiation', async () => {
  const socket = new Socket();
  socket.protocol = '';
  const session = new Session(socket);
  await expect(session.closed).rejects.toThrow(/subprotocol/);
  const p = sessions();
  const rejected = expect(p.host.closed).rejects.toThrow();
  p.b.emit('message', prepare(Op.end, 1, {}, [], defaults).encode().buffer);
  await rejected;
  await p.producer.close();
  await p.host.close();
});

it('fails a peer that sends more sequential publications than granted message credit', async () => {
  const p = sessions();
  p.host.receiver(1);
  const rejected = expect(p.host.closed).rejects.toThrow(/receive credit/);
  const plan = preparePublication(batch(), 1, schema, p.host.bounds);
  for (let sequence = 1; sequence <= 3; sequence++)
    p.b.emit('message', plan.encode(sequence).buffer);
  await rejected;
  await p.producer.close();
  await p.host.close();
});
