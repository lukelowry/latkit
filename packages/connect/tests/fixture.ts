import { WebSocketServer, type WebSocket } from 'ws';
import { acceptModel, connectModel } from '../src/index.js';
import { deferred } from '../src/core.js';
import type { AcceptOptions, ConnectOptions, ConnectedModel, Connection } from '../src/types.js';
import type { Parameters, RowBatch, Schema } from '@latkit/model';

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
export async function pair<const C extends Record<string, Parameters>>(
  options: Omit<ConnectOptions<C>, 'url' | 'name' | 'schema'> = {},
  host: AcceptOptions = {},
  modelSchema: Schema = schema,
) {
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    maxPayload: host.limits?.maxMessageBytes ?? 1024 * 1024,
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const accepted = deferred<ConnectedModel>();
  let socket!: WebSocket;
  let path = '';
  server.on('connection', (peer, request) => {
    socket = peer;
    path = request.url!;
    void acceptModel(peer, host).then(accepted.resolve, accepted.reject);
  });
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Missing address');
  let connection: Connection | undefined;
  try {
    connection = await connectModel({
      ...options,
      url: 'http://127.0.0.1:' + address.port,
      name: 'a model',
      schema: modelSchema,
    });
    const model = await accepted.promise;
    return {
      connection,
      model,
      socket,
      path,
      async close() {
        await connection!.close();
        await model.close();
        for (const peer of server.clients) peer.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  } catch (error) {
    await connection?.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
export const pause = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
