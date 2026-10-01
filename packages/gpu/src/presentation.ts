import type { Gpu } from './gpu.js';
import { GpuError, integer } from './error.js';
import type { RenderTarget } from './render.js';
import type { TargetSize } from './target.js';

export type Canvas = HTMLCanvasElement | OffscreenCanvas;
export interface Presentation extends RenderTarget {
  readonly canvas: Canvas;
  resize(size: TargetSize): void;
  destroy(): void;
}

/** Owns canvas configuration and backing dimensions; borrows the Gpu. */
export function createPresentation(options: {
  readonly gpu: Gpu;
  readonly canvas: Canvas;
  readonly format?: GPUTextureFormat;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly colorSpace?: PredefinedColorSpace;
  readonly usage?: GPUTextureUsageFlags;
}): Presentation {
  const { canvas, gpu } = options;
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!context) throw new GpuError('unavailable', 'Canvas has no WebGPU context');
  const format = options.format ?? globalThis.navigator?.gpu?.getPreferredCanvasFormat();
  if (!format)
    throw new GpuError('unavailable', 'A canvas format is required without navigator.gpu');
  const html = 'getAttribute' in canvas;
  const saved = html
    ? [canvas.getAttribute('width'), canvas.getAttribute('height')]
    : [canvas.width, canvas.height];
  const restore = (): void => {
    if (html) {
      for (const [i, name] of ['width', 'height'].entries()) {
        if (saved[i] === null) canvas.removeAttribute(name);
        else canvas.setAttribute(name, String(saved[i]));
      }
    } else {
      canvas.width = saved[0] as number;
      canvas.height = saved[1] as number;
    }
  };
  let closed = false;
  const assertLive = (): void => {
    if (closed) throw new GpuError('closed', 'Presentation is closed');
  };
  try {
    context.configure({
      device: gpu.device,
      format,
      alphaMode: options.alphaMode ?? 'premultiplied',
      colorSpace: options.colorSpace ?? 'srgb',
      usage: options.usage ?? GPUTextureUsage.RENDER_ATTACHMENT,
    });
  } catch (error) {
    try {
      context.unconfigure();
    } catch {
      /* Preserve the configuration failure. */
    }
    try {
      restore();
    } catch {
      /* Preserve the configuration failure. */
    }
    throw error;
  }
  return {
    canvas,
    device: gpu.device,
    format,
    get width() {
      return canvas.width;
    },
    get height() {
      return canvas.height;
    },
    texture() {
      assertLive();
      return context.getCurrentTexture();
    },
    resize(size) {
      assertLive();
      integer(size.width, 'canvas width', 1, gpu.device.limits.maxTextureDimension2D);
      integer(size.height, 'canvas height', 1, gpu.device.limits.maxTextureDimension2D);
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
    },
    destroy() {
      if (closed) return;
      closed = true;
      try {
        context.unconfigure();
      } finally {
        restore();
      }
    },
  };
}
