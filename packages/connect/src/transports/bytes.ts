import type { Transport } from '../transport.js';
import { decodeFrame, encodeFrame, limits } from '../internal/frame.js';
import type { Limits } from '../internal/frame.js';
import { configureTransport } from '../internal/transport-limits.js';
import { Events } from './events.js';
/** One complete binary message per receive; raw TCP chunks must first be framed by the channel. */
export interface ByteChannel {
  send(frame: Uint8Array): Promise<void>;
  subscribe(
    receive: (frame: Uint8Array | ArrayBuffer) => void,
    ended: (error?: Error) => void,
  ): () => void;
  close(): Promise<void>;
}
export interface FrameLimits {
  readonly maxMetadataBytes?: number;
  readonly maxInFlightBytes?: number;
}
export function byteTransport(channel: ByteChannel, options: FrameLimits = {}): Transport {
  let bounds: Limits = limits(options);
  const events = new Events();
  let unsubscribe = (): void => undefined;
  const fail = (error?: unknown): void => {
    events.end(error);
    unsubscribe?.();
    void channel.close().catch(() => undefined);
  };
  unsubscribe = channel.subscribe(
    (frame) => {
      try {
        events.message(decodeFrame(frame, bounds));
      } catch (error) {
        fail(error);
      }
    },
    (error) => events.end(error),
  );
  const transport: Transport = {
    transfers: false,
    send(message) {
      events.check();
      return channel.send(encodeFrame(message, bounds));
    },
    subscribe: events.subscribe.bind(events),
    async close() {
      unsubscribe?.();
      events.end();
      await channel.close();
    },
  };
  configureTransport(transport, (connection) => {
    bounds = {
      ...bounds,
      maxMetadataBytes: Math.min(bounds.maxMetadataBytes, connection.maxMetadataBytes),
      maxInFlightBytes: Math.min(bounds.maxInFlightBytes, connection.maxInFlightBytes),
    };
  });
  return transport;
}
