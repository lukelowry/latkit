/// <reference types="@webgpu/types" />

/** Resize-dependent render targets reused across network frames. */
export class FrameResources {
  private msaa: GPUTexture | null = null;
  private msaaView: GPUTextureView | null = null;
  private depth: GPUTexture | null = null;
  private depthViewValue: GPUTextureView | null = null;
  private width = 0;
  private height = 0;

  /** Depth texture view for the current frame size. */
  get depthView(): GPUTextureView {
    if (!this.depthViewValue) throw new Error('network depth target requested before allocation');
    return this.depthViewValue;
  }

  /**
   * Ensures MSAA and depth targets match the canvas dimensions.
   *
   * Allocation is transactional: old textures are kept until replacements are
   * created successfully.
   */
  ensureSize(
    device: GPUDevice,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    width: number,
    height: number,
  ): void {
    if (this.depth && this.width === width && this.height === height) return;

    const oldMsaa = this.msaa;
    const oldDepth = this.depth;
    let nextMsaa: GPUTexture | null = null;
    let nextDepth: GPUTexture | null = null;
    try {
      if (sampleCount === 4) {
        nextMsaa = device.createTexture({
          label: 'network-msaa',
          size: [width, height],
          format,
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      nextDepth = device.createTexture({
        label: 'network-depth',
        size: [width, height],
        format: 'depth24plus',
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    } catch (error) {
      nextMsaa?.destroy();
      nextDepth?.destroy();
      throw error;
    }

    this.msaa = nextMsaa;
    this.msaaView = nextMsaa?.createView() ?? null;
    this.depth = nextDepth;
    this.depthViewValue = nextDepth.createView();
    this.width = width;
    this.height = height;

    oldMsaa?.destroy();
    oldDepth?.destroy();
  }

  /** Builds the color attachment descriptor for the current sample count. */
  colorAttachment(
    sampleCount: 1 | 4,
    swapView: GPUTextureView,
    clearColor: GPUColor,
  ): GPURenderPassColorAttachment {
    if (sampleCount === 4) {
      if (!this.msaaView) throw new Error('network MSAA target requested before allocation');
      return {
        view: this.msaaView,
        resolveTarget: swapView,
        loadOp: 'clear',
        clearValue: clearColor,
        storeOp: 'discard',
      };
    }

    return {
      view: swapView,
      loadOp: 'clear',
      clearValue: clearColor,
      storeOp: 'store',
    };
  }

  /** Releases all resize-dependent GPU textures. */
  destroy(): void {
    this.msaa?.destroy();
    this.depth?.destroy();
    this.msaa = null;
    this.msaaView = null;
    this.depth = null;
    this.depthViewValue = null;
    this.width = 0;
    this.height = 0;
  }
}
