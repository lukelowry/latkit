/**
 * `@latkit/network` — a WebGPU network renderer behind one durable controller. `createNetwork`
 * returns a {@link Network} that attaches to any canvas over a shared device pool; three
 * registries name what it speaks: `CHANNELS`, `OPTIONS`, `PROJECTIONS`. `Model.Topology`,
 * `Model.Item`, and `Domain` are `@latkit/model`'s.
 *
 * @packageDocumentation
 */

export { createNetwork } from './controller.js';
export type { Network, Events } from './controller.js';

export { CHANNELS } from './channels.js';
export type { Channel } from './channels.js';

export { OPTIONS, validateOptions } from './options.js';
export type { Options } from './options.js';

export { PROJECTIONS } from './projections.js';
export type { Projection } from './projections.js';
export type { Camera } from './controller.js';

/** The host fragment hook `Network.setShade` installs, and the finished shades built on it. */
export type { Shade, ShadeFrame } from './shade.js';
export { spotlight } from './shades/spotlight.js';

/** Geographic border overlay payload, and the packaged one. */
export type { Borders } from './borders/index.js';
export { loadBorders } from './borders/load.js';
