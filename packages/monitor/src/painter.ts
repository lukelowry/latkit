/// <reference types="@webgpu/types" />
import type { Presentation } from '@latkit/gpu';
import { COLORMAP_LUT_SIZE, type RGBA } from '@latkit/model';

import segmentWgsl from './gpu/segment.wgsl?raw';

/**
 * GPU painter for monitor history and focus passes.
 *
 * LanePainter borrows a WebGPU presentation and owns only its renderer
 * resources. The controller chooses which sample windows to upload and which
 * segment ranges to draw; this class turns those decisions into ordered buffer
 * writes and render passes.
 */

/** Upload granularity for one slab window, capped by maxStorageBufferBindingSize. */
export const TARGET_VALUE_BYTES = 64 * 1024 * 1024;
/** Segment instances submitted per rAF; bounds GPU work, not upload bytes. */
export const SEGMENT_BUDGET = 4 * 1024 * 1024;

/** Frames per slab window: 64 MiB of f32 values, never fewer than one segment. */
export function framesPerWindow(elementCount: number, capBytes = TARGET_VALUE_BYTES): number {
  return Math.max(2, Math.floor(capBytes / 4 / elementCount));
}

/** The values `struct Uniforms` in segment.wgsl carries; pixel values are device pixels. */
export interface UniformValues {
  readonly viewportX: number;
  readonly viewportY: number;
  readonly lineWidth: number;
  readonly elementCount: number;
  /** Value domain: `t = (value - valueMin) * valueScale` drives y and color together. */
  readonly valueMin: number;
  readonly valueScale: number;
  /** Time window over the normalized axis: `x = (xnorm - timeMin) * timeScale`. */
  readonly timeMin: number;
  readonly timeScale: number;
  /** Focus trace tint, or an alpha below zero to brighten the trace's own color. */
  readonly focusColor: RGBA;
  /** History trace alpha: `unselectedAlpha` while an element is selected, else 1. */
  readonly alpha: number;
}

/** WGSL uniform-address-space size and alignment per member type used by the layout. */
const WGSL_TYPES = {
  f32: { size: 4, align: 4 },
  u32: { size: 4, align: 4 },
  vec2f: { size: 8, align: 8 },
  vec4f: { size: 16, align: 16 },
} as const;

/**
 * `struct Uniforms` in segment.wgsl, member for member. Byte offsets follow from WGSL's natural
 * layout; the parity unit test pins the .wgsl struct text to this table.
 */
export const UNIFORM_LAYOUT = [
  { name: 'viewport', type: 'vec2f' },
  { name: 'line_width', type: 'f32' },
  { name: 'element_count', type: 'u32' },
  { name: 'value_min', type: 'f32' },
  { name: 'value_scale', type: 'f32' },
  { name: 'time_min', type: 'f32' },
  { name: 'time_scale', type: 'f32' },
  { name: 'focus_color', type: 'vec4f' },
  { name: 'alpha', type: 'f32' },
] as const satisfies readonly { name: string; type: keyof typeof WGSL_TYPES }[];

/** Word offset of every layout member, and the struct's rounded byte length. */
function packLayout(): { words: Record<string, number>; bytes: number } {
  const words: Record<string, number> = {};
  let cursor = 0;
  for (const { name, type } of UNIFORM_LAYOUT) {
    const { size, align } = WGSL_TYPES[type];
    cursor = Math.ceil(cursor / align) * align;
    words[name] = cursor / 4;
    cursor += size;
  }
  return { words, bytes: Math.ceil(cursor / 16) * 16 };
}

const { words: W, bytes: UNIFORM_BYTES } = packLayout();

export class LanePainter {
  readonly device: GPUDevice;
  /** History texture width in device pixels. */
  width: number;
  /** History texture height in device pixels. */
  height: number;
  /** Value capacity of one slab window, in floats, after device-limit clamping. */
  readonly windowValueCapacity: number;

  readonly #context: GPUCanvasContext;
  readonly #format: GPUTextureFormat;
  #history: GPUTexture;
  #historyView: GPUTextureView;
  readonly #historyPipeline: GPURenderPipeline;
  readonly #focusPipeline: GPURenderPipeline;
  readonly #lut: GPUTexture;
  readonly #sampler: GPUSampler;
  readonly #historyUniform: GPUBuffer;
  readonly #focusUniform: GPUBuffer;
  readonly #uniformScratch = new ArrayBuffer(UNIFORM_BYTES);

  #values: GPUBuffer | null = null;
  #xnorm: GPUBuffer | null = null;
  #focusValues: GPUBuffer | null = null;
  #focusXnorm: GPUBuffer | null = null;
  #historyGroup: GPUBindGroup | null = null;
  #focusGroup: GPUBindGroup | null = null;
  #destroyed = false;

  /** Creates renderer resources against a borrowed presentation. */
  constructor(presentation: Presentation, width: number, height: number) {
    const { device, context, format } = presentation;
    this.device = device;
    this.#context = context;
    this.#format = format;
    this.width = width;
    this.height = height;
    this.windowValueCapacity = Math.floor(
      Math.min(
        TARGET_VALUE_BYTES,
        device.limits.maxStorageBufferBindingSize,
        device.limits.maxBufferSize,
      ) / 4,
    );

    const module = device.createShaderModule({ label: 'monitor-segment', code: segmentWgsl });
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const pipeline = (label: string, entryPoint: string): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-strip' },
      });
    this.#historyPipeline = pipeline('monitor-history', 'fs_history');
    this.#focusPipeline = pipeline('monitor-focus', 'fs_focus');

    this.#lut = device.createTexture({
      label: 'monitor-lut',
      size: [COLORMAP_LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.#historyUniform = device.createBuffer({
      label: 'monitor-uniform',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#focusUniform = device.createBuffer({
      label: 'monitor-focus-uniform',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#history = this.#makeHistory(width, height);
    this.#historyView = this.#history.createView();
  }

  /** Upload a baked colormap (COLORMAP_LUT_SIZE * 4 bytes, rgba8unorm). */
  writeColormap(lut: Uint8Array): void {
    this.device.queue.writeTexture(
      { texture: this.#lut },
      lut as Uint8Array<ArrayBuffer>,
      { bytesPerRow: COLORMAP_LUT_SIZE * 4 },
      [COLORMAP_LUT_SIZE, 1],
    );
  }

  /**
   * Recreate sample-window and focus buffers for a series shape.
   *
   * Old slab buffers are destroyed. `windowFrames` sizes the reusable history
   * window; `frameCount` sizes the full-length focus overlay buffer.
   */
  reserve(elementCount: number, windowFrames: number, frameCount: number): void {
    this.releaseSlabs();
    const make = (label: string, bytes: number): GPUBuffer =>
      this.device.createBuffer({
        label,
        size: Math.max(4, bytes),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    this.#values = make('monitor-values', windowFrames * elementCount * 4);
    this.#xnorm = make('monitor-xnorm', windowFrames * 4);
    this.#focusValues = make('monitor-focus-values', frameCount * 4);
    this.#focusXnorm = make('monitor-focus-xnorm', frameCount * 4);
    const group = (
      label: string,
      pipeline: GPURenderPipeline,
      uniform: GPUBuffer,
      values: GPUBuffer,
      xnorm: GPUBuffer,
    ) =>
      this.device.createBindGroup({
        label,
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: values } },
          { binding: 2, resource: { buffer: xnorm } },
          { binding: 3, resource: this.#lut.createView() },
          { binding: 4, resource: this.#sampler },
        ],
      });
    this.#historyGroup = group(
      'monitor-history-group',
      this.#historyPipeline,
      this.#historyUniform,
      this.#values,
      this.#xnorm,
    );
    this.#focusGroup = group(
      'monitor-focus-group',
      this.#focusPipeline,
      this.#focusUniform,
      this.#focusValues,
      this.#focusXnorm,
    );
  }

  releaseSlabs(): void {
    for (const buffer of [this.#values, this.#xnorm, this.#focusValues, this.#focusXnorm])
      buffer?.destroy();
    this.#values = this.#xnorm = this.#focusValues = this.#focusXnorm = null;
    this.#historyGroup = this.#focusGroup = null;
  }

  writeUniform(target: 'history' | 'focus', u: UniformValues): void {
    const f32 = new Float32Array(this.#uniformScratch);
    const u32 = new Uint32Array(this.#uniformScratch);
    f32[W.viewport!] = u.viewportX;
    f32[W.viewport! + 1] = u.viewportY;
    f32[W.line_width!] = u.lineWidth;
    u32[W.element_count!] = u.elementCount;
    f32[W.value_min!] = u.valueMin;
    f32[W.value_scale!] = u.valueScale;
    f32[W.time_min!] = u.timeMin;
    f32[W.time_scale!] = u.timeScale;
    f32.set(u.focusColor, W.focus_color!);
    f32[W.alpha!] = u.alpha;
    this.device.queue.writeBuffer(
      target === 'history' ? this.#historyUniform : this.#focusUniform,
      0,
      this.#uniformScratch,
    );
  }

  /** Queue-ordered slab upload: zero-copy subarray views straight into the window buffers. */
  uploadWindow(values: Float32Array, xnorm: Float32Array): void {
    if (!this.#values || !this.#xnorm) throw new Error('monitor painter: no slabs reserved');
    this.device.queue.writeBuffer(
      this.#values,
      0,
      values.buffer,
      values.byteOffset,
      values.byteLength,
    );
    this.device.queue.writeBuffer(this.#xnorm, 0, xnorm.buffer, xnorm.byteOffset, xnorm.byteLength);
  }

  /** Write focus-trace frames starting at `firstFrame`; the slices are views, never copies. */
  uploadFocus(values: Float32Array, xnorm: Float32Array, firstFrame = 0): void {
    if (!this.#focusValues || !this.#focusXnorm)
      throw new Error('monitor painter: no slabs reserved');
    if (values.length === 0) return;
    const byteOffset = firstFrame * 4;
    this.device.queue.writeBuffer(
      this.#focusValues,
      byteOffset,
      values.buffer,
      values.byteOffset,
      values.byteLength,
    );
    this.device.queue.writeBuffer(
      this.#focusXnorm,
      byteOffset,
      xnorm.buffer,
      xnorm.byteOffset,
      xnorm.byteLength,
    );
  }

  /** Accumulate one instance range onto the history texture (loadOp: 'load'). */
  drawHistory(instanceCount: number, firstInstance: number): void {
    if (instanceCount <= 0 || !this.#historyGroup) return;
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.#historyView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.#historyPipeline);
    pass.setBindGroup(0, this.#historyGroup);
    pass.draw(4, instanceCount, 0, firstInstance);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Wipe the history texture to fully transparent. */
  clearHistory(): void {
    const encoder = this.device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: this.#historyView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      .end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Copy accumulated history to the swapchain and draw the optional focus overlay.
   *
   * The focus pass renders directly onto the swapchain, leaving history intact.
   */
  present(focusInstances: number): void {
    const target = this.#context.getCurrentTexture();
    const view = target.createView();
    const encoder = this.device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      .end();
    encoder.copyTextureToTexture(
      { texture: this.#history },
      { texture: target },
      { width: this.width, height: this.height },
    );
    if (focusInstances > 0 && this.#focusGroup) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(this.#focusPipeline);
      pass.setBindGroup(0, this.#focusGroup);
      pass.draw(4, focusInstances, 0, 0);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Reallocate the history texture after a resize.
   *
   * Prior content is discarded; the controller schedules a full repaint.
   */
  resize(width: number, height: number): void {
    this.#history.destroy();
    this.width = width;
    this.height = height;
    this.#history = this.#makeHistory(width, height);
    this.#historyView = this.#history.createView();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.releaseSlabs();
    this.#history.destroy();
    this.#lut.destroy();
    this.#historyUniform.destroy();
    this.#focusUniform.destroy();
  }

  #makeHistory(width: number, height: number): GPUTexture {
    return this.device.createTexture({
      label: 'monitor-history',
      size: { width, height },
      format: this.#format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }
}
