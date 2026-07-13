/** Creates an owned Core WebGPU device for sharing between Latkit renderers. */
export { createGpu, GpuUnavailableError } from './gpu.js';

/** Shared WebGPU device and acquisition options. */
export type { Gpu, Options } from './gpu.js';
