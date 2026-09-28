/**
 * `@latkit/diagram` -- a WebGPU block-diagram renderer and editor surface behind one durable
 * controller. `createDiagram` returns a {@link Diagram} that attaches to any canvas over a shared
 * device pool; two registries name what it speaks: `CHANNELS` and `OPTIONS`. `Document.Netlist`,
 * `Document.Part`, and `Domain` are `@latkit/model`'s; `arrange` lays a netlist out without a
 * device or a DOM, so a worker imports this same entrypoint.
 *
 * @packageDocumentation
 */

export { createDiagram } from './controller.js';
export type { Diagram, Events } from './controller.js';

export { CHANNELS } from './channels.js';
export type { Channel } from './channels.js';

export { OPTIONS, validateOptions } from './options.js';
export type { Options } from './options.js';

export type { Camera } from './controller.js';

/** The host fragment hook `Diagram.setShade` installs. */
export type { Shade, ShadeFrame } from './shade.js';

/** The diagram's automatic layout, without a device or a DOM. */
export { arrange } from './layout/index.js';
