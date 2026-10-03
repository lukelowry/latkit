import { WebSocketServer, type WebSocket } from 'ws';
import { acceptModel, connectModel } from '../src/index.js';
import { deferred } from '../src/core.js';
import type { ConnectLimits, ConnectedModel, Connection } from '../src/types.js';
import type { Model, Parameters, RowBatch, Schema } from '@latkit/model';

export const schema: Schema = {
  axis: { name: 'time' },
  types: {
    Node: {
      fields: {
        value: { type: 'float64' },
        output: { type: 'float64', sampled: true },
      },
    },
  },
};
export const fields = [{ from: 'Node', select: ['value'] }] as const;
export function batch(count = 8, value = 1): RowBatch {
  return {
    kind: 'rows',
    index: { source: 'test', type: 'Node', version: 'rows' },
    rows: { kind: 'range', offset: 0, count },
    columns: {
      value: {
        kind: 'numeric',
        offset: 0,
        length: count,
        values: new Float64Array(count).fill(value),
      },
    },
  };
}
/** Where `pair` dials: connect dials exactly this, path and query included. */
export const PATH = '/a%20model?from=test';
/** A server on a free port, each socket it accepts handed to `accepted`. */
export async function listen(
  accepted: (socket: WebSocket, path: string) => void,
  maxPayload = 1 << 20,
) {
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    maxPayload,
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.on('connection', (peer, request) => accepted(peer, request.url!));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Missing address');
  return {
    server,
    url: 'http://127.0.0.1:' + address.port,
    async close() {
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
/** A model of `schema` named "a model", connected over a real socket and accepted at the server. */
export async function pair<const C extends Record<string, Parameters>>(
  model: Omit<Model<C>, 'name' | 'schema'> & { readonly limits?: Partial<ConnectLimits> } = {},
  host: { readonly limits?: Partial<ConnectLimits> } = {},
  modelSchema: Schema = schema,
) {
  const accepted = deferred<ConnectedModel>();
  let socket!: WebSocket;
  let path = '';
  const server = await listen((peer, url) => {
    socket = peer;
    path = url;
    void acceptModel({ socket: peer, limits: host.limits }).then(accepted.resolve, accepted.reject);
  }, host.limits?.maxMessageBytes);
  let connection: Connection | undefined;
  try {
    const { limits, ...rest } = model;
    connection = await connectModel(
      { ...rest, name: 'a model', schema: modelSchema },
      { url: server.url + PATH, limits },
    );
    const accept = await accepted.promise;
    return {
      connection,
      model: accept,
      socket,
      path,
      async close() {
        await connection!.close();
        await accept.close();
        await server.close();
      },
    };
  } catch (error) {
    await connection?.close();
    await server.close();
    throw error;
  }
}
export const pause = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
