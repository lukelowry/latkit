import type { Preparation } from '../frame/render.js';
import type { Gpu } from '../gpu.js';
import type { TextureResource } from '../memory/textures.js';

/** Multisample color and depth targets for a view's passes, reused while their shape holds. */
export class Attachments {
  #color?: TextureResource;
  #depth?: TextureResource;
  #key = '';
  constructor(private readonly gpu: Gpu) {}
  /** Views of this frame's attachments; a missing one is not needed. */
  prepare(
    frame: Preparation,
    options: { readonly msaa: 1 | 4; readonly depth?: GPUTextureFormat },
  ): { readonly color?: GPUTextureView; readonly depth?: GPUTextureView } {
    const key = [frame.width, frame.height, frame.format, options.msaa, options.depth].join(':');
    if (key !== this.#key) {
      const size = [frame.width, frame.height],
        usage = GPUTextureUsage.RENDER_ATTACHMENT;
      const color =
        options.msaa > 1
          ? this.gpu.texture({ size, format: frame.format, sampleCount: options.msaa, usage })
          : undefined;
      let depth: TextureResource | undefined;
      try {
        depth = options.depth
          ? this.gpu.texture({ size, format: options.depth, sampleCount: options.msaa, usage })
          : undefined;
      } catch (error) {
        color?.destroy();
        throw error;
      }
      this.destroy();
      this.#color = color;
      this.#depth = depth;
      this.#key = key;
    }
    return {
      color: this.#color && frame.texture(this.#color).createView(),
      depth: this.#depth && frame.texture(this.#depth).createView(),
    };
  }
  destroy(): void {
    this.#color?.destroy();
    this.#depth?.destroy();
    this.#color = this.#depth = undefined;
    this.#key = '';
  }
}
