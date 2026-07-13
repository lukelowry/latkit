/// <reference types="@webgpu/types" />

/** WebGPU objects bound to one network canvas. */
export interface GpuContext {
  /** Borrowed logical device used by the renderer. */
  readonly device: GPUDevice;
  /** Presentation context configured for the target canvas. */
  readonly context: GPUCanvasContext;
  /** Preferred texture format selected for this canvas binding. */
  readonly format: GPUTextureFormat;
  /** Canvas associated with the presentation context. */
  readonly canvas: HTMLCanvasElement;
}

/**
 * Configures a canvas for presentation with a borrowed WebGPU device.
 *
 * The caller retains ownership of `device`. Errors from preferred-format
 * lookup and context configuration propagate unchanged.
 */
export function createGpuContext(device: GPUDevice, canvas: HTMLCanvasElement): GpuContext {
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Canvas does not support a WebGPU context');

  const format = navigator.gpu.getPreferredCanvasFormat();
  try {
    context.configure({ device, format, alphaMode: 'premultiplied' });
  } catch (error) {
    try {
      context.unconfigure();
    } catch {
      // Preserve the presentation error that made cleanup necessary.
    }
    throw error;
  }

  return { device, context, format, canvas };
}

/** Unconfigures a canvas without destroying its borrowed device. */
export function destroyGpuContext(gpu: GpuContext): void {
  gpu.context.unconfigure();
}
