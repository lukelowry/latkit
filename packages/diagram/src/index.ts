/**
 * `@latkit/diagram` -- a WebGPU block-diagram renderer and editor surface behind one durable
 * controller. `createDiagram` returns a {@link Diagram} that attaches to any canvas over a shared
 * device pool; two registries name what it speaks: `CHANNELS` and `OPTIONS`. `Netlist`, `Part`,
 * and `Domain` are `@latkit/model`'s; `@latkit/diagram/layout` arranges a netlist without a device.
 *
 * @packageDocumentation
 */

export { createDiagram } from './controller.js';
export type { Diagram, Events } from './controller.js';

export { CHANNELS } from './channels.js';
export type { Channel } from './channels.js';

export { OPTIONS, validateOptions } from './options.js';
export type { Options } from './options.js';

export type { Pose } from './camera.js';

/** The host fragment hook `Diagram.setShade` installs. */
export type { Shade, ShadeFrame } from './shade.js';
