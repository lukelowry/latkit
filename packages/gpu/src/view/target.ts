import { failure } from '@latkit/model';
import type { Gpu } from '../gpu.js';
import { integer } from '../error.js';
import { targetResources, type RenderTarget } from '../frame/render.js';

export interface TargetSize {
  readonly width: number;
  readonly height: number;
}
export interface TextureTarget extends RenderTarget {
  resize(size: TargetSize): void;
  destroy(): void;
}

/** A texture to render into, such as for images or a view's offscreen panels; resizable. */
export function createTextureTarget(
  gpu: Gpu,
  options: TargetSize & { readonly format?: GPUTextureFormat; readonly label?: string },
): TextureTarget {
  const format = options.format ?? 'rgba8unorm';
  const allocate = (size: TargetSize) => {
    integer(size.width, 'target width', 1, gpu.device.limits.maxTextureDimension2D);
    integer(size.height, 'target height', 1, gpu.device.limits.maxTextureDimension2D);
    return gpu.texture({
      label: options.label ?? 'render target',
      size: [size.width, size.height],
      format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
  };
  let resource = allocate(options);
  let width = options.width,
    height = options.height,
    closed = false;
  const assertLive = (): void => {
    if (closed) throw failure('closed', 'Render target is closed');
  };
  const target: TextureTarget = {
    device: gpu.device,
    format,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    texture() {
      assertLive();
      return resource.texture;
    },
    resize(size) {
      assertLive();
      if (width === size.width && height === size.height) return;
      const next = allocate(size);
      const previous = resource;
      resource = next;
      width = size.width;
      height = size.height;
      previous.destroy();
    },
    destroy() {
      if (!closed) {
        closed = true;
        resource.destroy();
        targetResources.delete(target);
      }
    },
  };
  targetResources.set(target, () => {
    assertLive();
    return resource;
  });
  return target;
}
