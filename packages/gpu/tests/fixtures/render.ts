import type { Gpu, Preparation, Renderer, RenderTarget, Encoding } from '../../src/index.js';

export function target(device: GPUDevice): RenderTarget {
  const texture = device.createTexture({
    size: [16, 16],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return { device, format: 'rgba8unorm', width: 16, height: 16, texture: () => texture };
}
export function renderer(
  prepare: (frame: Preparation) => void | Promise<void>,
  encode: (frame: Encoding) => void = () => {},
): Renderer {
  return {
    prepare: async (frame) => {
      await prepare(frame);
    },
    encode,
    destroy() {},
  };
}
export async function draw(
  gpu: Gpu,
  prepare: (frame: Preparation) => void | Promise<void>,
): Promise<void> {
  await gpu.render({
    views: [{ renderer: renderer(prepare), target: target(gpu.device) }],
    timeMs: 0,
  });
  await gpu.idle();
}
