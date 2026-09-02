/**
 * `@latkit/remote` — a `@latkit/model` model served across a `@latkit/port`: its source and runner
 * as one served lineage, its grids as windows of display text, and its results as the batches a
 * run streamed. Every service is a `serve` and `connect` pair.
 *
 * @packageDocumentation
 */

export type { RemoteSource, Served, ServeOptions } from './source.js';
export { connectSource, serveSource } from './source.js';

export type { GridHeader, GridServer, RemoteGrid } from './grid.js';
export { connectGrid, serveGrid } from './grid.js';

export type { RemoteResults, ResultsOptions } from './results.js';
export { connectResults, serveResults } from './results.js';
