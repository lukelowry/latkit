import { describe, expect, it, vi } from 'vitest';

import {
  bytePort,
  messagePort,
  type MessageTarget,
  socketPort,
  type SocketTarget,
} from '../src/index.js';
import { settle } from '../src/testing.js';

type Listener = (event: never) => void;

/** A message target that records posts and lets a test dispatch events. */
class FakeTarget implements MessageTarget {
  readonly posted: { readonly message: unknown; readonly transfer: ArrayBuffer[] }[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  postMessage(message: unknown, transfer: ArrayBuffer[]): void {
    this.posted.push({ message, transfer });
  }
  addEventListener(type: string, listener: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      (listener as (event: unknown) => void)(event);
    }
  }
  count(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

/** One end of an in-memory socket pair with the WebSocket surface `socketPort` uses. */
class FakeSocket implements SocketTarget {
  binaryType = 'blob';
  readyState = 0;
  bufferedAmount = 0;
  peer!: FakeSocket;
  readonly sent: Uint8Array[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  send(data: Uint8Array): void {
    this.sent.push(data);
    this.bufferedAmount += data.byteLength;
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    queueMicrotask(() => {
      this.bufferedAmount -= data.byteLength;
      this.peer.dispatch('message', { data: copy });
    });
  }
  open(): void {
    this.readyState = 1;
    this.dispatch('open', undefined);
  }
  close(): void {
    this.readyState = 3;
    this.dispatch('close', undefined);
  }
  fail(message: string): void {
    this.dispatch('error', { message });
  }
  addEventListener(type: string, listener: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      (listener as (event: unknown) => void)(event);
    }
  }
}

function pair(open = true): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  if (open) {
    a.readyState = 1;
    b.readyState = 1;
  }
  return [a, b];
}

describe('messagePort', () => {
  it('posts to the target with a copy of the transfer list, empty by default', () => {
    const target = new FakeTarget();
    const port = messagePort(target);
    const transfer = [new ArrayBuffer(4)];
    port.post({ a: 1 }, transfer);
    port.post({ b: 2 });
    expect(target.posted[0]!.message).toEqual({ a: 1 });
    expect(target.posted[0]!.transfer).toEqual(transfer);
    expect(target.posted[0]!.transfer).not.toBe(transfer);
    expect(target.posted[1]!.transfer).toEqual([]);
  });

  it('delivers message data and reports a target error once as the close', () => {
    const target = new FakeTarget();
    const received = vi.fn();
    const closed = vi.fn();
    const off = messagePort(target).subscribe(received, closed);
    target.dispatch('message', { data: { x: 1 } });
    target.dispatch('error', { message: 'worker crashed' });
    target.dispatch('error', { message: 'again' });
    target.dispatch('message', { data: { x: 2 } });
    expect(received.mock.calls.map(([message]) => message as unknown)).toEqual([
      { x: 1 },
      { x: 2 },
    ]);
    expect(closed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith('worker crashed');
    off();
    expect(target.count('message') + target.count('error')).toBe(0);
  });

  it('names a nameless target error', () => {
    const target = new FakeTarget();
    const closed = vi.fn();
    messagePort(target).subscribe(() => {}, closed);
    target.dispatch('error', { message: '' });
    expect(closed).toHaveBeenCalledWith('The port failed.');
  });
});

describe('bytePort', () => {
  it('round-trips an envelope with nested typed arrays that view the received frame in place', () => {
    const frames: ArrayBuffer[] = [];
    let deliver!: (frame: ArrayBuffer) => void;
    const received = vi.fn();
    const port = bytePort({
      send: (frame) =>
        frames.push(
          frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer,
        ),
      subscribe: (onFrame) => {
        deliver = onFrame;
        return () => {};
      },
    });
    port.subscribe(received);
    const message = {
      svc: 'source',
      kind: 'reply',
      id: 7,
      body: {
        time: Float64Array.of(0.5, 1.5),
        values: Float32Array.of(1, 2, 3, 4),
        nested: [{ signed: Int32Array.of(-1, -2) }, 'text', null, true],
      },
    };
    port.post(message);
    deliver(frames[0]!);
    const decoded = received.mock.calls[0]![0] as typeof message;
    expect(decoded).toEqual(message);
    expect(decoded.body.time.buffer).toBe(frames[0]);
  });

  it('reports a malformed frame once as the close and drops what follows', () => {
    let deliver!: (frame: unknown) => void;
    const received = vi.fn();
    const closed = vi.fn();
    bytePort({
      send: () => {},
      subscribe: (onFrame) => {
        deliver = onFrame;
        return () => {};
      },
    }).subscribe(received, closed);
    deliver('not binary at all');
    deliver(new ArrayBuffer(2));
    deliver(new ArrayBuffer(2));
    expect(received).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith('frame is truncated');
  });

  it('exposes drain only when the target has one', async () => {
    const drain = vi.fn(async () => {});
    const subscribe = () => () => {};
    expect(bytePort({ send: () => {}, subscribe }).drain).toBeUndefined();
    const port = bytePort({ send: () => {}, subscribe, drain });
    await port.drain!();
    expect(drain).toHaveBeenCalledOnce();
  });
});

describe('socketPort', () => {
  it('delivers posts to the peer as decoded messages', async () => {
    const [a, b] = pair();
    const received = vi.fn();
    socketPort(b).subscribe(received);
    socketPort(a).post({ svc: 'x', kind: 'event', body: { values: Float32Array.of(1, 2) } });
    await settle();
    expect(received).toHaveBeenCalledWith({
      svc: 'x',
      kind: 'event',
      body: { values: Float32Array.of(1, 2) },
    });
    expect(a.binaryType).toBe('arraybuffer');
  });

  it('queues posts until the socket opens, in order', async () => {
    const [a, b] = pair(false);
    const received = vi.fn();
    socketPort(b).subscribe(received);
    const port = socketPort(a);
    port.post({ n: 1 });
    port.post({ n: 2 });
    expect(a.sent).toHaveLength(0);
    a.open();
    await settle();
    expect(received.mock.calls.map(([message]) => message as unknown)).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  it('reports a close or an error once, as the close', () => {
    const [a] = pair();
    const received = vi.fn();
    const closed = vi.fn();
    socketPort(a).subscribe(received, closed);
    a.fail('refused');
    a.close();
    expect(received).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith('refused');
  });

  it('drops posts after the socket closed and unsubscribes cleanly', async () => {
    const [a, b] = pair();
    const received = vi.fn();
    const off = socketPort(b).subscribe(received);
    const port = socketPort(a);
    a.close();
    port.post({ late: true });
    off();
    await settle();
    expect(a.sent).toHaveLength(0);
    expect(received).not.toHaveBeenCalled();
  });

  it('drains at once while the socket holds less than the high-water mark', async () => {
    const [a] = pair();
    await expect(socketPort(a).drain!()).resolves.toBeUndefined();
  });
});
