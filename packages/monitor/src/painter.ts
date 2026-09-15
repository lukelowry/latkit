/// <reference types="@webgpu/types" />
import type { Presentation } from '@latkit/gpu';
import { COLORMAP_LUT_SIZE, type RGBA } from '@latkit/model';
import segmentWgsl from './gpu/segment.wgsl?raw';
import compositeWgsl from './gpu/composite.wgsl?raw';

/** Maximum GPU segment work in a submitted batch. */
export const SEGMENT_BUDGET = 4 * 1024 * 1024;
/** The segment shader's uniform layout, shared with its parity test. */
export const UNIFORM_LAYOUT = [
  { name: 'viewport', type: 'vec2f' },
  { name: 'line_width', type: 'f32' },
  { name: 'element_count', type: 'u32' },
  { name: 'focus_color', type: 'vec4f' },
] as const;
export interface UniformValues {
  readonly viewportX: number;
  readonly viewportY: number;
  readonly lineWidth: number;
  readonly elementCount: number;
  readonly focusColor: RGBA;
}

/** Ordered uploads and draws over bounded history and focus slabs. Owns no device or canvas. */
export class LanePainter {
  readonly device: GPUDevice;
  readonly windowValueCapacity: number;
  width: number;
  height: number;
  readonly #context: GPUCanvasContext;
  readonly #format: GPUTextureFormat;
  readonly #historyPipeline: GPURenderPipeline;
  readonly #focusPipeline: GPURenderPipeline;
  readonly #composite: GPURenderPipeline;
  readonly #lut: GPUTexture;
  readonly #sampler: GPUSampler;
  readonly #historyUniform: GPUBuffer;
  readonly #focusUniform: GPUBuffer;
  readonly #opacity: GPUBuffer;
  readonly #uniform = new ArrayBuffer(32);
  readonly #alpha = new Float32Array(4);
  #history: GPUTexture;
  #focus: GPUTexture;
  #historyView: GPUTextureView;
  #focusView: GPUTextureView;
  #compositeGroup: GPUBindGroup | null = null;
  #slabs: GPUBuffer[] = [];
  #historyGroup: GPUBindGroup | null = null;
  #focusGroup: GPUBindGroup | null = null;
  #destroyed = false;

  constructor(presentation: Presentation, width: number, height: number) {
    const { device, context, format } = presentation;
    this.device = device;
    this.#context = context;
    this.#format = format;
    this.width = width;
    this.height = height;
    this.windowValueCapacity = Math.floor(
      Math.min(
        64 * 1024 * 1024,
        device.limits.maxStorageBufferBindingSize,
        device.limits.maxBufferSize,
      ) / 8,
    );
    const module = device.createShaderModule({ label: 'monitor-segment', code: segmentWgsl });
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const pipeline = (label: string, entryPoint: string) =>
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
    const uniform = (label: string, size = 32) =>
      device.createBuffer({
        label,
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.#historyUniform = uniform('monitor-uniform');
    this.#focusUniform = uniform('monitor-focus-uniform');
    this.#opacity = uniform('monitor-opacity', 16);
    this.#history = this.#texture('monitor-history');
    this.#focus = this.#texture('monitor-focus-history');
    this.#historyView = this.#history.createView();
    this.#focusView = this.#focus.createView();
    const composite = device.createShaderModule({
      label: 'monitor-composite',
      code: compositeWgsl,
    });
    this.#composite = device.createRenderPipeline({
      label: 'monitor-composite',
      layout: 'auto',
      vertex: { module: composite, entryPoint: 'vertex' },
      fragment: { module: composite, entryPoint: 'fragment', targets: [{ format }] },
    });
  }

  writeColormap(lut: Uint8Array): void {
    this.device.queue.writeTexture(
      { texture: this.#lut },
      lut as Uint8Array<ArrayBuffer>,
      { bytesPerRow: COLORMAP_LUT_SIZE * 4 },
      [COLORMAP_LUT_SIZE, 1],
    );
  }

  reserve(elements: number, historyFrames: number, focusFrames: number): void {
    this.releaseSlabs();
    const make = (label: string, size: number) => {
      const buffer = this.device.createBuffer({
        label,
        size: Math.max(8, size),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#slabs.push(buffer);
      return buffer;
    };
    const values = make('monitor-values', elements * historyFrames * 8);
    const time = make('monitor-xnorm', historyFrames * 4);
    const focus = make('monitor-focus-values', focusFrames * 8);
    const focusTime = make('monitor-focus-xnorm', focusFrames * 4);
    const group = (
      pipeline: GPURenderPipeline,
      uniform: GPUBuffer,
      data: GPUBuffer,
      axis: GPUBuffer,
    ) =>
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: data } },
          { binding: 2, resource: { buffer: axis } },
          { binding: 3, resource: this.#lut.createView() },
          { binding: 4, resource: this.#sampler },
        ],
      });
    this.#historyGroup = group(this.#historyPipeline, this.#historyUniform, values, time);
    this.#focusGroup = group(this.#focusPipeline, this.#focusUniform, focus, focusTime);
  }

  writeUniform(target: 'history' | 'focus', values: UniformValues): void {
    const f = new Float32Array(this.#uniform),
      u = new Uint32Array(this.#uniform);
    f[0] = values.viewportX;
    f[1] = values.viewportY;
    f[2] = values.lineWidth;
    u[3] = values.elementCount;
    f.set(values.focusColor, 4);
    this.device.queue.writeBuffer(
      target === 'history' ? this.#historyUniform : this.#focusUniform,
      0,
      this.#uniform,
    );
  }

  uploadWindow(values: Float32Array, time: Float32Array): void {
    this.#upload(0, values, time);
  }
  uploadFocus(values: Float32Array, time: Float32Array): void {
    this.#upload(2, values, time);
  }
  #upload(at: number, values: Float32Array, time: Float32Array): void {
    const data = this.#slabs[at],
      axis = this.#slabs[at + 1];
    if (!data || !axis) throw new Error('monitor painter: no slabs reserved');
    this.device.queue.writeBuffer(data, 0, values.buffer, values.byteOffset, values.byteLength);
    this.device.queue.writeBuffer(axis, 0, time.buffer, time.byteOffset, time.byteLength);
  }

  drawHistory(instances: number, firstInstance = 0): void {
    this.#draw(false, instances, firstInstance);
  }
  drawFocus(instances: number): void {
    this.#draw(true, instances, 0);
  }
  #draw(focus: boolean, instances: number, first: number): void {
    const group = focus ? this.#focusGroup : this.#historyGroup;
    if (!instances || !group) return;
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: focus ? this.#focusView : this.#historyView, loadOp: 'load', storeOp: 'store' },
      ],
    });
    pass.setPipeline(focus ? this.#focusPipeline : this.#historyPipeline);
    pass.setBindGroup(0, group);
    pass.draw(4, instances, 0, first);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  clearHistory(): void {
    this.#clear(this.#historyView);
  }
  clearFocus(): void {
    this.#clear(this.#focusView);
  }
  #clear(view: GPUTextureView): void {
    const encoder = this.device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [{ view, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
      })
      .end();
    this.device.queue.submit([encoder.finish()]);
  }

  present(alpha = 1): void {
    this.#alpha[0] = alpha;
    this.device.queue.writeBuffer(this.#opacity, 0, this.#alpha);
    this.#compositeGroup ??= this.device.createBindGroup({
      layout: this.#composite.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.#historyView },
        { binding: 1, resource: this.#focusView },
        { binding: 2, resource: { buffer: this.#opacity } },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.#context.getCurrentTexture().createView(),
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.#composite);
    pass.setBindGroup(0, this.#compositeGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  resize(width: number, height: number): void {
    this.#history.destroy();
    this.#focus.destroy();
    this.width = width;
    this.height = height;
    this.#history = this.#texture('monitor-history');
    this.#focus = this.#texture('monitor-focus-history');
    this.#historyView = this.#history.createView();
    this.#focusView = this.#focus.createView();
    this.#compositeGroup = null;
  }
  releaseSlabs(): void {
    for (const buffer of this.#slabs) buffer.destroy();
    this.#slabs = [];
    this.#historyGroup = this.#focusGroup = null;
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.releaseSlabs();
    this.#history.destroy();
    this.#focus.destroy();
    this.#lut.destroy();
    this.#opacity.destroy();
    this.#historyUniform.destroy();
    this.#focusUniform.destroy();
  }
  #texture(label: string): GPUTexture {
    return this.device.createTexture({
      label,
      size: { width: this.width, height: this.height },
      format: this.#format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }
}
