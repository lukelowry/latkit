/// <reference types="@webgpu/types" />

/** A renderer's output, independent of a canvas, DOM, or frame scheduler. */
export interface RenderTarget {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  /** Texture receiving the next frame. A canvas target acquires its current texture here. */
  texture(): GPUTexture;
}

/** A fixed texture target owned by the caller, suitable for composition in a worker. */
export function createRenderTarget(
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat = 'rgba8unorm',
): RenderTarget & { destroy(): void } {
  if (
    ![width, height].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= device.limits.maxTextureDimension2D,
    )
  )
    throw new RangeError('Render target dimensions exceed the device limits');
  const texture = device.createTexture({
    label: 'latkit-render-target',
    size: [width, height],
    format,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  });
  return {
    device,
    format,
    width,
    height,
    texture: () => texture,
    destroy: () => texture.destroy(),
  };
}

/** One prepared scene, borrowed by its host until destroy. */
export interface SceneRenderer {
  /** Prepare samples at the source's simulation time, in seconds. */
  prepare(sourceTimeSeconds: number, signal: AbortSignal): Promise<void>;
  /** Draw at elapsed output time, in milliseconds, for visual animation. */
  draw(outputTimeMs: number): void;
  destroy(): void;
}
