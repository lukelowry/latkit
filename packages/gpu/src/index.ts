/**
 * `@latkit/gpu` — what every latkit renderer shares: Core WebGPU devices and the pool they are
 * leased from, canvas presentation, the frame loop, the attach lifecycle, the channels a renderer
 * binds values and series to, the colormap lookup texture, and controller events.
 *
 * @packageDocumentation
 */

/** Native Core WebGPU device acquisition and availability failure. */
export { GpuUnavailableError, requestDevice } from './device.js';

/** One device shared by many renderers through reference-counted leases. */
export { createDevicePool, devices } from './pool.js';
export type { DeviceLease, DevicePool } from './pool.js';

/** WebGPU canvas configuration, sizing, and observation. */
export { createPresentation } from './presentation.js';

/** One canvas's frame scheduler. */
export { createFrameLoop } from './frame.js';
export type { Frame, FrameLoop } from './frame.js';

/** One controller's attach lifecycle: supersession, joining, and recovery from device loss. */
export { createAttachment } from './attachment.js';
export type { Attachment } from './attachment.js';

/** A renderer's channels: slots bound to arrays or following series, and their domains. */
export { createChannels } from './channels.js';
export type { Channels } from './channels.js';

/** The colormap lookup texture every renderer samples. */
export { bakeColormap, COLORMAP_LUT_SIZE } from './colormap.js';

/** A controller's typed events. */
export { createEmitter } from './emitter.js';

/** Adapter-selection options. */
export type { Options } from './device.js';

/** Configured WebGPU canvas binding. */
export type { Presentation } from './presentation.js';

export { createRenderTarget } from './target.js';
export type { RenderTarget, SceneRenderer } from './target.js';
export type { ChannelBinding, ChannelBindings } from './channels.js';
