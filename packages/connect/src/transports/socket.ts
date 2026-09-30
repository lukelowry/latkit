import type { Transport } from '../transport.js';
import { deferred, failure } from '../internal/errors.js';
import type { Deferred } from '../internal/errors.js';
import { limits } from '../internal/frame.js';
import { Events } from './events.js';
import { byteTransport } from './bytes.js';
import type { FrameLimits } from './bytes.js';
export interface SocketTarget {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(frame: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
/** Ordered frames with a bounded send queue. Closing rejects sends still waiting for the socket. */
export function webSocket(socket: SocketTarget, options: FrameLimits = {}): Transport {
  const bound = limits(options).maxInFlightBytes;
  socket.binaryType = 'arraybuffer';
  const events = new Events();
  const queue: { frame: Uint8Array; done: Deferred<void> }[] = [];
  let queuedBytes = 0;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (error?: Error): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    for (const item of queue.splice(0)) item.done.reject(error ?? failure('disconnected'));
    queuedBytes = 0;
    detach();
    events.end(error);
  };
  const pump = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (ended || socket.readyState !== 1) return;
    while (queue.length) {
      const item = queue[0];
      if (socket.bufferedAmount + item.frame.byteLength > bound) {
        timer = setTimeout(pump, 4);
        return;
      }
      try {
        socket.send(item.frame);
      } catch {
        finish(failure('disconnected', 'Socket send failed.'));
        socket.close();
        return;
      }
      queue.shift();
      queuedBytes -= item.frame.byteLength;
      item.done.resolve();
    }
  };
  const opened: EventListener = () => pump();
  const closed: EventListener = () => finish();
  const failed: EventListener = () => {
    finish(failure('disconnected', 'Socket failed.'));
    socket.close();
  };
  const received: EventListener = (event) => {
    const value = (event as MessageEvent<unknown>).data;
    if (value instanceof ArrayBuffer || value instanceof Uint8Array) events.message(value);
    else failed(event);
  };
  const detach = (): void => {
    socket.removeEventListener('open', opened);
    socket.removeEventListener('close', closed);
    socket.removeEventListener('error', failed);
    socket.removeEventListener('message', received);
  };
  socket.addEventListener('open', opened);
  socket.addEventListener('close', closed);
  socket.addEventListener('error', failed);
  socket.addEventListener('message', received);
  if (socket.readyState > 1) finish();
  return byteTransport(
    {
      send(frame) {
        if (ended) return Promise.reject(failure('disconnected'));
        if (queuedBytes + frame.byteLength > bound)
          return Promise.reject(failure('resource-limit', 'Socket queue is full.'));
        const done = deferred<void>();
        queue.push({ frame, done });
        queuedBytes += frame.byteLength;
        pump();
        return done.promise;
      },
      subscribe(receive, end) {
        return events.subscribe((value) => receive(value as ArrayBuffer | Uint8Array), end);
      },
      close() {
        finish();
        socket.close();
        return Promise.resolve();
      },
    },
    options,
  );
}
