import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type { Connection, Transport, ByteChannel } from '../src/index.js';
import type { CommandResult, Model, DataEvent, Commands } from '@latkit/model';
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
    AsyncIterable<DataEvent>
  >();
  expectTypeOf(connection.commands!.run({ routine: 'solve', values: {} })).toEqualTypeOf<
    Promise<CommandResult>
  >();
  expectTypeOf(api.connect(transport)).toEqualTypeOf<Promise<Connection>>();
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

function controls(
  connection: Connection,
  transport: Transport,
  model: Model,
  commands: Commands,
): void {
  void api.serve(transport, model, { commands });
  // @ts-expect-error Commands are explicitly separate.
  void connection.run;
  // @ts-expect-error Models cannot replay data.
  void connection.query;
  // @ts-expect-error No retention handles.
  void connection.retain;
}
void controls;
