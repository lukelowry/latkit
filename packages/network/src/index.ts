/** Creates a WebGPU network renderer in a host container. */
export { createNetwork } from './controller.js';

/** Public network controller types and construction options. */
export type { Network, Options, Events } from './controller.js';

/** Rendering-channel names and normalization options. */
export type { Channel } from './channels.js';

/** Input graph topology format passed to {@link Network.load}. */
export type { Topology } from './topology/types.js';

/** Optional geographic border overlay payload. */
export type { Borders } from './borders.js';
