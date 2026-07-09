/// <reference types="@webgpu/types" />

/** Acquired WebGPU objects bound to the network canvas. */
export interface GpuContext {
  /** Logical GPU device used for all buffers, textures, and commands. */
  device: GPUDevice;
  /** WebGPU canvas context configured for the target canvas. */
  context: GPUCanvasContext;
  /** Preferred canvas texture format selected by the browser. */
  format: GPUTextureFormat;
  /** Canvas associated with the configured WebGPU context. */
  canvas: HTMLCanvasElement;
}

/**
 * Requests a high-performance WebGPU adapter and configures a canvas context.
 *
 * Throws a descriptive error when WebGPU, the adapter, the device, or the
 * canvas context is unavailable.
 */
export async function createGpuContext(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
  // Dual-GPU laptops default to the integrated GPU without this hint.
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available');
  const device = await adapter.requestDevice();
  if (!device) throw new Error('Failed to acquire a WebGPU device');
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Canvas does not support a WebGPU context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });
  return { device, context, format, canvas };
}

/** Destroys the logical GPU device owned by a context. */
export function destroyGpuContext(gpu: GpuContext): void {
  gpu.device.destroy();
}
