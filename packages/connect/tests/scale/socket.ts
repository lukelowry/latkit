/** Real loopback TCP used to test the public ByteChannel extension point. Not shipped. */
import { createServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import type { ByteChannel } from '../../src/index.js';
export interface SocketMetrics {
  sentBytes: number;
  receivedBytes: number;
  decodedBytes: number;
  maxFrameBytes: number;
}
function channel(socket: Socket, stats: SocketMetrics): ByteChannel {
  let receive: ((frame: Uint8Array) => void) | undefined,
    ended: ((error?: Error) => void) | undefined;
  const header = new Uint8Array(4);
  let current: Uint8Array | undefined,
    position = 0,
    headerPosition = 0;
  socket.pause();
  socket.setNoDelay(true);
  const failed = (error?: Error | boolean) =>
    ended?.(
      error instanceof Error
        ? Object.assign(new Error(error.message), { code: 'disconnected' })
        : undefined,
    );
  const data = (chunk: Buffer) => {
    stats.receivedBytes += chunk.byteLength;
    for (let offset = 0; offset < chunk.length;) {
      if (!current) {
        const count = Math.min(4 - headerPosition, chunk.length - offset);
        header.set(chunk.subarray(offset, offset + count), headerPosition);
        headerPosition += count;
        offset += count;
        if (headerPosition !== 4) continue;
        const length = new DataView(header.buffer).getUint32(0, true);
        if (!length || length > 16 * 1024 * 1024) {
          socket.destroy(new Error('Invalid frame length'));
          return;
        }
        current = new Uint8Array(length);
        stats.decodedBytes += length;
        stats.maxFrameBytes = Math.max(stats.maxFrameBytes, length);
        position = 0;
        headerPosition = 0;
      }
      const count = Math.min(current.length - position, chunk.length - offset);
      current.set(chunk.subarray(offset, offset + count), position);
      position += count;
      offset += count;
      if (position === current.length) {
        const frame = current;
        current = undefined;
        receive?.(frame);
      }
    }
  };
  socket.on('data', data);
  socket.on('error', failed);
  socket.on('close', failed);
  return {
    send(frame) {
      return new Promise<void>((resolve, reject) => {
        if (socket.destroyed) {
          reject(new Error('Socket closed'));
          return;
        }
        const header = new Uint8Array(4);
        new DataView(header.buffer).setUint32(0, frame.byteLength, true);
        stats.sentBytes += frame.byteLength + 4;
        socket.cork();
        socket.write(header);
        socket.write(frame, (error) => (error ? reject(error) : resolve()));
        socket.uncork();
      });
    },
    subscribe(onFrame, onEnd) {
      receive = onFrame;
      ended = onEnd;
      socket.resume();
      return () => {
        receive = undefined;
        ended = undefined;
        socket.pause();
      };
    },
    async close() {
      socket.destroy();
      socket.off('data', data);
      socket.off('error', failed);
      socket.off('close', failed);
    },
  };
}
export async function socketPair(stats: SocketMetrics): Promise<[ByteChannel, ByteChannel]> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  const incoming = once(server, 'connection');
  const client = createConnection({ port: address.port, host: '127.0.0.1' });
  const connected = once(client, 'connect');
  const [remote] = (await incoming) as [Socket];
  await connected;
  server.close();
  return [channel(client, stats), channel(remote, stats)];
}
