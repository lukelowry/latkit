import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type { Connection, Transport, ByteChannel } from '../src/index.js';
import type { Document, Model, ModelService } from '@latkit/model-new';
it('exposes only connection and transport entry points at runtime', () => {
  expect(Object.keys(api).sort()).toEqual([
    'byteTransport',
    'connect',
    'messagePort',
    'serve',
    'webSocket',
  ]);
});
function usage(
  connection: Connection,
  transport: Transport,
  channel: ByteChannel,
  service: ModelService,
  worker: Worker,
  scope: MessagePort,
  socket: WebSocket,
): void {
  expectTypeOf(connection).toExtend<ModelService>();
  expectTypeOf(connection.open()).toEqualTypeOf<Promise<Document>>();
  expectTypeOf(connection.model('document')).toEqualTypeOf<Promise<Model>>();
  void api.serve(transport, service);
  void api.connect(api.messagePort(worker));
  void api.connect(api.messagePort(scope));
  void api.connect(api.webSocket(socket));
  void api.connect(api.byteTransport(channel));
  // @ts-expect-error No engine hierarchy crosses this boundary.
  void connection.engines;
  // @ts-expect-error No implementation enumeration or catalog is supplied.
  void connection.models;
}
void usage;
