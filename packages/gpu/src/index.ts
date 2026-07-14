/** Native Core WebGPU device acquisition and availability failure. */
export { GpuUnavailableError, requestDevice } from './device.js';

/** WebGPU canvas configuration, sizing, and observation. */
export { createPresentation, observeCanvas } from './presentation.js';

/** Adapter-selection options. */
export type { Options } from './device.js';

/** Configured WebGPU canvas binding. */
export type { Presentation, PresentationCanvas } from './presentation.js';
