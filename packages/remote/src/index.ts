/**
 * `@latkit/remote` — a `@latkit/model` model served across a `@latkit/port`: its source and runner,
 * and its results as the batches a run streamed. Every service is a `serve` and `connect` pair,
 * and every connected side is a `Remote`: what the peer serves, plus `close`.
 *
 * @packageDocumentation
 */

export type { Remote } from './remote.js';

export type { Served } from './source.js';
export { connectSource, serveSource } from './source.js';

export { connectResults, serveResults } from './results.js';
