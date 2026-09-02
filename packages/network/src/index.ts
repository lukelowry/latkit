/**
 * `@latkit/network` — a WebGPU network renderer behind one controller. `createNetwork` returns a
 * {@link Network}; three registries name what it speaks: `CHANNELS`, `OPTIONS`, `PROJECTIONS`.
 *
 * @packageDocumentation
 */

export { createNetwork } from './controller.js';
export type { Network, Events, Item, RevealOptions } from './controller.js';

export type { Topology } from '@latkit/model';
export { validateTopology } from './topology/validate.js';

export { CHANNELS } from './channels.js';
export type { Channel } from './channels.js';
export type { Domain } from './range.js';

export { OPTIONS, validateOptions } from './options.js';
export type { Options } from './options.js';

export { PROJECTIONS } from './projections.js';
export type { Projection } from './projections.js';
export type { Pose } from './camera/projection.js';

/** Geographic border overlay payload; `@latkit/network/borders` loads the packaged one. */
export type { Borders } from './borders/index.js';
