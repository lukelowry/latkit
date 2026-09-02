/**
 * `@latkit/port` — where messages cross: a two-method port over workers, webviews, and sockets;
 * one binary frame that carries typed arrays intact; and typed request, reply, and stream
 * protocols served and connected over a port.
 *
 * @packageDocumentation
 */

export type { ByteTarget, MessageTarget, Port, SocketTarget } from './port.js';
export { bytePort, messagePort, socketPort } from './port.js';

export type { Guard, Progress, Protocol } from './protocol.js';
export { protocol } from './protocol.js';

export type { CallOptions, Connection, Handler, Service } from './channel.js';
export { connect, serve, Transferred, transferred } from './channel.js';

export { describeError } from './error.js';
