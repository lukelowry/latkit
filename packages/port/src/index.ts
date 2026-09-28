/**
 * `@latkit/port` — where latkit crosses a boundary: a two-method port over workers, webviews,
 * sockets, and one thread; one binary frame that carries typed arrays intact; typed request,
 * reply, and stream protocols with the checks a served side runs; and models, engines, and
 * recordings served and connected across a port.
 *
 * @packageDocumentation
 */

export type { Port } from './port.js';
export { bytePort, loopback, messagePort, socketPort } from './port.js';

export type { Protocol } from './protocol.js';
export { protocol } from './protocol.js';

export type { Check } from './check.js';
export { check } from './check.js';

export type { Connection, Remote, Service } from './channel.js';
export { connect, serve, transferred } from './channel.js';

export { describeError } from './error.js';

export { connectModel, serveModel } from './model.js';
export { connectEngine, serveEngine } from './engine.js';
export { connectRecording, serveRecording } from './recording.js';

export { connectDocument, serveDocument } from './document.js';
