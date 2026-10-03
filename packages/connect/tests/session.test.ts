import { expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { defaults } from '../src/core.js';
import { Op, decode, prepare } from '../src/frame.js';
import type { ConnectLimits, WebSocketLike } from '../src/types.js';
import { batch, schema, pause } from './fixture.js';
import { preparePublication } from '../src/columns.js';

class Socket implements WebSocketLike {
  readyState = 1;
  protocol = 'latkit.connect';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  listeners = new Map<string, Set<(event: { data: unknown; reason?: string }) => void>>();
  peer?: Socket;
  addEventListener(type: string, listener: (event: { data: unknown; reason?: string }) => void) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: (event: { data: unknown; reason?: string }) => void) {
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
function sessions(overrides: Partial<ConnectLimits> = {}) {
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
    ...overrides,
  };
  return {
    a,
    b,
    producer: new Session(a, { subprotocol: 'latkit.connect', limits: bounds }),
    host: new Session(b, { subprotocol: 'latkit.connect', limits: bounds }),
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
  const session = new Session(socket, { subprotocol: 'latkit.connect' });
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

it('coalesces a stalled ACK to the latest sequence and preserves its terminal upgrade', async () => {
  const p = sessions({
    maxBufferedBytes: 1024 * 1024,
    streamWindowBytes: 1024 * 1024,
    streamWindowMessages: 1024,
    maxBufferedMessages: 1024,
    maxStreams: 1,
  });
  const receiver = p.host.receiver(1);
  const sender = p.producer.sender(1, receiver.windowBytes, receiver.windowMessages);
  const queued = vi.spyOn(p.host.outbound, 'write');
  try {
    const plan = preparePublication(batch(1), 1, schema, p.producer.bounds);
    for (let i = 0; i < 1024; i++) await sender.write(plan);
    p.b.bufferedAmount = p.host.bounds.maxBufferedBytes;
    for (let i = 0; i < 1024; i++) expect((await receiver.next()).done).toBe(false);
    expect(queued).toHaveBeenCalledTimes(1);
    await sender.finish(Op.end);
    let finished = false;
    const last = receiver.next().then((value) => {
      finished = true;
      return value;
    });
    await pause(5);
    expect(finished).toBe(false);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(p.b.sent).toHaveLength(0);
    expect(() => p.host.receiver(2)).toThrow(/streams/);
    p.b.bufferedAmount = 0;
    expect((await last).done).toBe(true);
    const acks = p.b.sent.map((v) => decode(v, defaults));
    expect(acks.map((f) => f.metadata)).toEqual([{ sequence: 1024, terminal: true }]);
    expect(p.host.receivers.size).toBe(0);
    expect(p.producer.senders.size).toBe(0);
    // Reusing the only slot cannot overtake its predecessor's terminal ACK.
    const second = p.host.receiver(2);
    const nextSender = p.producer.sender(2, second.windowBytes, second.windowMessages);
    await nextSender.finish(Op.end);
    expect((await second.next()).done).toBe(true);
  } finally {
    await p.producer.close();
    await p.host.close();
  }
});

it('keeps credit and socket waits alive beyond 30 seconds, then drains in order', async () => {
  vi.useFakeTimers();
  const p = sessions();
  try {
    const receiver = p.host.receiver(1);
    const sender = p.producer.sender(1, receiver.windowBytes, receiver.windowMessages);
    const plan = preparePublication(batch(), 1, schema, p.producer.bounds);
    await sender.write(plan);
    await sender.write(plan);
    let sent = false;
    const third = sender.write(plan).then(() => {
      sent = true;
    });
    await vi.advanceTimersByTimeAsync(31000);
    expect(sent).toBe(false);
    expect(sender.signal.aborted).toBe(false);
    p.b.bufferedAmount = p.host.bounds.maxBufferedBytes;
    await receiver.next();
    await receiver.next();
    await vi.advanceTimersByTimeAsync(31000);
    expect(p.host.lifetime.signal.aborted).toBe(false);
    expect(sent).toBe(false);
    p.b.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(4);
    await third;
    await sender.finish(Op.end);
    expect((await receiver.next()).done).toBe(false);
    expect((await receiver.next()).done).toBe(true);
  } finally {
    await p.producer.close();
    await p.host.close();
    vi.useRealTimers();
  }
});

it('starts cancellation deadlines after sending and retires an empty terminal ACK', async () => {
  vi.useFakeTimers();
  const p = sessions();
  try {
    const receiver = p.host.receiver(1);
    const sender = p.producer.sender(1, receiver.windowBytes, receiver.windowMessages);
    p.b.bufferedAmount = p.host.bounds.maxBufferedBytes;
    receiver.cancel();
    await vi.advanceTimersByTimeAsync(31000);
    expect(p.host.lifetime.signal.aborted).toBe(false);
    expect(sender.signal.aborted).toBe(false);
    p.b.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(4);
    expect(sender.signal.aborted).toBe(true);
    await sender.finish(Op.end);
    await vi.advanceTimersByTimeAsync(200);
    expect(p.host.receivers.size).toBe(0);
    expect(p.producer.senders.size).toBe(0);
    expect(p.host.lifetime.signal.aborted).toBe(false);
    expect(decode(p.b.sent.at(-1)!, defaults).metadata).toEqual({ sequence: 0, terminal: true });
  } finally {
    await p.producer.close();
    await p.host.close();
    vi.useRealTimers();
  }
});

it('bounds and deduplicates close even when its reason cannot drain', async () => {
  vi.useFakeTimers();
  const p = sessions();
  try {
    p.a.bufferedAmount = p.producer.bounds.maxBufferedBytes;
    const pending = p.producer.control(Op.monitor, 1);
    const rejected = expect(pending).rejects.toThrow(/closed/);
    const close = p.producer.close({ code: 'shutdown', message: 'Closing' });
    expect(p.producer.close({ code: 'again', message: 'Again' })).toBe(close);
    await vi.advanceTimersByTimeAsync(101);
    await close;
    await rejected;
    expect(p.a.sent).toHaveLength(0);
    expect(p.producer.lifetime.signal.aborted).toBe(true);
  } finally {
    await p.producer.close();
    await p.host.close();
    vi.useRealTimers();
  }
});

it('aborts both credit and outbound waits on teardown', async () => {
  const p = sessions();
  try {
    const receiver = p.host.receiver(1);
    const sender = p.producer.sender(1, receiver.windowBytes, receiver.windowMessages);
    const plan = preparePublication(batch(), 1, schema, p.producer.bounds);
    await sender.write(plan);
    await sender.write(plan);
    const blocked = expect(sender.write(plan)).rejects.toThrow(/closed/);
    p.a.bufferedAmount = p.producer.bounds.maxBufferedBytes;
    const control = expect(p.producer.control(Op.progress, 1, { completed: 1 })).rejects.toThrow(
      /closed/,
    );
    await p.producer.close();
    await Promise.all([blocked, control]);
  } finally {
    await p.producer.close();
    await p.host.close();
  }
});

it('preserves an already queued publication before cancellation terminal and serves other streams fairly', async () => {
  const p = sessions();
  try {
    const r1 = p.host.receiver(1),
      r2 = p.host.receiver(2);
    const s1 = p.producer.sender(1, r1.windowBytes, r1.windowMessages);
    const s2 = p.producer.sender(2, r2.windowBytes, r2.windowMessages);
    p.a.bufferedAmount = p.producer.bounds.maxBufferedBytes;
    const first = s1.write(preparePublication(batch(), 1, schema, p.producer.bounds));
    const second = s2.write(preparePublication(batch(), 2, schema, p.producer.bounds));
    s1.cancel();
    const terminal = s1.finish(Op.end);
    p.a.bufferedAmount = 0;
    await Promise.all([first, second, terminal]);
    expect(
      p.a.sent.map((v) => {
        const f = decode(v, defaults);
        return [f.id, f.op];
      }),
    ).toEqual([
      [1, Op.publication],
      [2, Op.publication],
      [1, Op.end],
    ]);
    expect((await r1.next()).done).toBe(false);
    expect((await r1.next()).done).toBe(true);
    await s2.finish(Op.end);
    expect((await r2.next()).done).toBe(false);
    expect((await r2.next()).done).toBe(true);
  } finally {
    await p.producer.close();
    await p.host.close();
  }
});
