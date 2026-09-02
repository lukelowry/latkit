/** Native Core WebGPU device acquisition and availability failure. */
export { GpuUnavailableError, requestDevice } from './device.js';

/** One device shared by many renderers through reference-counted leases. */
export { createDevicePool } from './pool.js';
export type { DeviceLease, DevicePool } from './pool.js';

/** WebGPU canvas configuration, sizing, and observation. */
export { createPresentation } from './presentation.js';

/** Adapter-selection options. */
export type { Options } from './device.js';

/** Configured WebGPU canvas binding. */
export type { Presentation } from './presentation.js';
