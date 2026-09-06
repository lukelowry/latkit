/**
 * `@latkit/monitor` — a WebGPU signal monitor behind one durable controller. `createMonitor`
 * returns a {@link Monitor} that attaches to any canvas over a shared device pool; `OPTIONS`
 * names every display option with its default and validation kind. `Series` and `Domain` are
 * `@latkit/model`'s.
 *
 * @packageDocumentation
 */

export { createMonitor } from './monitor.js';
export type { Events, Monitor, Reading } from './monitor.js';

export { OPTIONS, validateOptions } from './options.js';
export type { Options } from './options.js';
