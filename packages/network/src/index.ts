/**
 * `@latkit/network` — a WebGPU network renderer behind one durable controller. `createNetwork`
 * returns a {@link Network} that attaches to any canvas over a shared device pool; three
 * registries name what it speaks: `CHANNELS`, `OPTIONS`, `PROJECTIONS`. `Topology`, `Item`, and
 * `Domain` are `@latkit/model`'s.
 *
 * @packageDocumentation
 */

export { createNetwork } from './controller.js';
export type { Network, Events, RevealOptions } from './controller.js';

export { CHANNELS } from './channels.js';
export type { Channel } from './channels.js';

export { OPTIONS, validateOptions } from './options.js';
export type { Options } from './options.js';

export { PROJECTIONS } from './projections.js';
export type { Projection } from './projections.js';
export type { Pose } from './camera/projection.js';

/** Geographic border overlay payload; `@latkit/network/borders` loads the packaged one. */
export type { Borders } from './borders/index.js';
