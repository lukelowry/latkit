/**
 * The two-method port every host pair shares: page and worker, extension host and webview,
 * browser and server. A message port carries what structured clone carries; a byte port carries
 * each message as one binary frame, so typed arrays view the received buffer in place and cross
 * boundaries where structured clone does not survive.
 */

import { describeError } from './error.js';
import { decodeFrame, encodeFrame, toArrayBuffer } from './frame.js';

/**
 * A message transport.
 *
 * @remarks
 * `transfer` lists buffers the caller relinquishes; a port without transfer semantics copies them.
 * `subscribe` delivers every message the peer posts and, at most once, the reason the transport
 * ended. `drain` resolves once the transport has room for more posts, so a producer of a long
 * stream can await it between posts; it is absent on a transport that never backs up.
 */
export interface Port {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  subscribe(onMessage: (message: unknown) => void, onClose?: (reason: string) => void): () => void;
  drain?(): Promise<void>;
}

/**
 * Anything with the DOM message-target shape: a `Worker` held by the page, a worker's own global
 * scope, or a VS Code webview API.
 */
export interface MessageTarget {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: { readonly message: string }) => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'error', listener: (event: { readonly message: string }) => void): void;
}

/**
 * A port over a message target. The target's `error` event ends the port, so a crashed worker
 * ends every service on it the same way a polite close does.
 *
 * @remarks
 * Structured clone carries more than a frame does (a `Map`, a `Date`), and nothing here refuses
 * it. Hold to JSON values plus typed arrays so a service moves between transports unchanged; the
 * framed `loopback` in `@latkit/port/testing` catches what strays.
 */
export function messagePort(target: MessageTarget): Port {
  return {
    post: (message, transfer = []) => target.postMessage(message, [...transfer]),
    subscribe(onMessage, onClose) {
      let ended = false;
      const message = (event: { readonly data: unknown }): void => onMessage(event.data);
      const error = (event: { readonly message: string }): void => {
        if (ended) return;
        ended = true;
        onClose?.(event.message || 'The port failed.');
      };
      target.addEventListener('message', message);
      target.addEventListener('error', error);
      return () => {
        target.removeEventListener('message', message);
        target.removeEventListener('error', error);
      };
    },
  };
}

/**
 * A channel that carries opaque bytes faithfully: a socket, or a webview link across remote
 * hosts. `subscribe` delivers whatever the channel received (an `ArrayBuffer`, a typed array, or
 * something that is not binary at all, which the port drops) and, at most once, the reason the
 * channel ended.
 */
export interface ByteTarget {
  send(frame: Uint8Array): void;
  subscribe(onFrame: (data: unknown) => void, onClose: (reason: string) => void): () => void;
  drain?(): Promise<void>;
}

/**
 * A port over a byte channel: every message rides one binary frame. A frame that does not decode
 * ends the port, since nothing after it can be trusted.
 */
export function bytePort(target: ByteTarget): Port {
  const drain = target.drain;
  return {
    post: (message) => target.send(encodeFrame(message)),
    subscribe(onMessage, onClose) {
      let ended = false;
      const end = (reason: string): void => {
        if (ended) return;
        ended = true;
        onClose?.(reason);
      };
      return target.subscribe((data) => {
        if (ended) return;
        const frame = toArrayBuffer(data);
        if (!frame) return;
        let message: unknown;
        try {
          message = decodeFrame(frame);
        } catch (error) {
          end(describeError(error));
          return;
        }
        onMessage(message);
      }, end);
    },
    ...(drain ? { drain: () => drain.call(target) } : {}),
  };
}

/** The surface the browser's `WebSocket` and node's `ws` share, as `socketPort` uses it. */
export interface SocketTarget {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  addEventListener(type: 'open' | 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: { readonly message?: string }) => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'open' | 'close', listener: () => void): void;
  removeEventListener(
    type: 'error',
    listener: (event: { readonly message?: string }) => void,
  ): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

const OPEN = 1;
/** Bytes the socket may hold unsent before `drain` waits. */
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const DRAIN_POLL_MS = 10;

/**
 * A port over a WebSocket. Posts before `open` are queued and flushed in order; after the socket
 * closes they are dropped, since every subscriber has already heard the close.
 *
 * @remarks
 * A frame that arrives as a window onto a larger buffer, as node's `ws` delivers pooled buffers, is
 * copied once on receive so its arrays stay aligned; a browser `WebSocket` delivers whole buffers.
 */
export function socketPort(socket: SocketTarget): Port {
  socket.binaryType = 'arraybuffer';
  let queue: Uint8Array[] | null = socket.readyState === OPEN ? null : [];
  const flush = (): void => {
    const pending = queue;
    queue = null;
    socket.removeEventListener('open', flush);
    for (const frame of pending ?? []) socket.send(frame);
  };
  if (queue) socket.addEventListener('open', flush);

  return bytePort({
    send(frame) {
      if (queue) queue.push(frame);
      else if (socket.readyState === OPEN) socket.send(frame);
    },
    subscribe(onFrame, onClose) {
      const message = (event: { readonly data: unknown }): void => onFrame(event.data);
      const closed = (): void => onClose('The socket closed.');
      const failed = (event: { readonly message?: string }): void =>
        onClose(event.message || 'The socket failed.');
      socket.addEventListener('message', message);
      socket.addEventListener('close', closed);
      socket.addEventListener('error', failed);
      return () => {
        socket.removeEventListener('message', message);
        socket.removeEventListener('close', closed);
        socket.removeEventListener('error', failed);
      };
    },
    async drain() {
      while (socket.readyState === OPEN && socket.bufferedAmount > HIGH_WATER_BYTES) {
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
      }
    },
  });
}
