import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type { Connection, QueryableConnection, Transport, ByteChannel } from '../src/index.js';
import type { Document, Model, ModelService, Recording, Queryable } from '@latkit/model';
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
  expectTypeOf(connection.recording('recording')).toEqualTypeOf<Promise<Recording>>();
  expectTypeOf(api.connect(transport, { kind: 'queryable' })).toEqualTypeOf<
    Promise<QueryableConnection>
  >();
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

function queryableUsage(
  connection: QueryableConnection,
  transport: Transport,
  source: Queryable,
): void {
  expectTypeOf(connection).toExtend<Queryable>();
  expectTypeOf(source.retain()).toEqualTypeOf<Promise<Queryable>>();
  void api.serve(transport, source, { kind: 'queryable' });
  // @ts-expect-error A read capability cannot acquire compute contexts.
  void connection.model;
  // @ts-expect-error A read capability cannot edit or stop its source.
  void connection.stop;
  // @ts-expect-error A Queryable requires explicit capability selection.
  void api.serve(transport, source);
}
void queryableUsage;
