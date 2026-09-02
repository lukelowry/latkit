/**
 * `@latkit/remote` — a `@latkit/model` model served across a `@latkit/port`: its source and runner
 * as one served lineage, and its grids as windows of display text. Every service is a `serve` and
 * `connect` pair.
 *
 * @packageDocumentation
 */

export type { RemoteSource, Served, ServeOptions } from './source.js';
export { connectSource, serveSource } from './source.js';

export type { GridHeader, GridServer, RemoteGrid } from './grid.js';
export { connectGrid, serveGrid } from './grid.js';
