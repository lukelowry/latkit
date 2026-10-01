import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type { Connection, QueryableConnection, Transport, ByteChannel } from '../src/index.js';
import type { CommandResult, Model, Recording, Queryable } from '@latkit/model';
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
  model: Model,
  worker: Worker,
  scope: MessagePort,
  socket: WebSocket,
): void {
  expectTypeOf(connection).toExtend<Model>();
  expectTypeOf(connection.monitor([{ from: 'Node', select: ['output'] }])).toEqualTypeOf<
    Promise<Recording>
  >();
  expectTypeOf(connection.run({ routine: 'solve', values: {} })).toEqualTypeOf<
    Promise<CommandResult>
  >();
  expectTypeOf(api.connect(transport, { kind: 'queryable' })).toEqualTypeOf<
    Promise<QueryableConnection>
  >();
  void api.serve(transport, model);
  void api.connect(api.messagePort(worker));
  void api.connect(api.messagePort(scope));
  void api.connect(api.webSocket(socket));
  void api.connect(api.byteTransport(channel));
  // @ts-expect-error No service or catalog stands between a connection and its model.
  void connection.open;
  // @ts-expect-error Nothing is reached by id.
  void connection.recording;
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
  // @ts-expect-error A read capability cannot run commands.
  void connection.run;
  // @ts-expect-error A read capability cannot open monitors.
  void connection.monitor;
  // @ts-expect-error A Queryable requires explicit capability selection.
  void api.serve(transport, source);
}
void queryableUsage;
