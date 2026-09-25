/// <reference types="@webgpu/types" />
import type { Presentation } from '@latkit/gpu';
import { COLORMAP_LUT_SIZE, position, type Domain, type RGBA } from '@latkit/model';
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

/** History and focus targets at one size, and the time and value ranges drawn into them. */
interface Image {
  readonly history: GPUTexture;
  readonly focus: GPUTexture;
  readonly historyView: GPUTextureView;
  readonly focusView: GPUTextureView;
  readonly width: number;
  readonly height: number;
  range: Domain | null;
  domain: Domain | null;
}

/**
 * Ordered uploads and draws over bounded history and focus slabs. Owns no device or canvas. The
 * shown image stays on screen, mapped into the current view, while a rebuild draws its successor.
 */
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
  readonly #compositeUniform: GPUBuffer;
  readonly #uniform = new ArrayBuffer(32);
  readonly #compositeValues = new Float32Array(8);
  #shown: Image;
  #drawing: Image | null = null;
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
    const uniform = (label: string) =>
      device.createBuffer({
        label,
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.#historyUniform = uniform('monitor-uniform');
    this.#focusUniform = uniform('monitor-focus-uniform');
    this.#compositeUniform = uniform('monitor-composite');
    this.#shown = this.#image();
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

  /** Whether draws land in an image not yet shown. */
  get offscreen(): boolean {
    return this.#drawing !== null;
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
    const target = this.#drawing ?? this.#shown;
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: focus ? target.focusView : target.historyView,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(focus ? this.#focusPipeline : this.#historyPipeline);
    pass.setBindGroup(0, group);
    pass.draw(4, instances, 0, first);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Draw from nothing over `range` and `domain` at the current size: in place while nothing is
   * shown, else into a new image that `commit` shows.
   */
  beginRebuild(range: Domain, domain: Domain): void {
    let target: Image;
    if (this.#shown.range === null) {
      if (!this.#fits(this.#shown)) this.#show(this.#image());
      target = this.#shown;
    } else {
      if (!this.#drawing || !this.#fits(this.#drawing)) {
        this.#drop(this.#drawing);
        this.#drawing = this.#image();
      }
      target = this.#drawing;
    }
    target.range = range;
    target.domain = domain;
    this.#clear(target.historyView);
    this.#clear(target.focusView);
  }
  /** Show the image a rebuild drew. */
  commit(): void {
    if (!this.#drawing) return;
    const drawn = this.#drawing;
    this.#drawing = null;
    this.#show(drawn);
  }
  /** Forget both images: nothing is shown until the next rebuild. */
  reset(): void {
    this.#drop(this.#drawing);
    this.#drawing = null;
    this.#shown.range = this.#shown.domain = null;
    this.#clear(this.#shown.historyView);
    this.#clear(this.#shown.focusView);
  }
  clearFocus(): void {
    this.#clear((this.#drawing ?? this.#shown).focusView);
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

  /**
   * Composite the shown image, mapped from the ranges it was drawn over into `range` and
   * `domain`.
   */
  present(alpha = 1, range: Domain | null = null, domain: Domain | null = null): void {
    const map = this.#compositeValues,
      shown = this.#shown;
    if (shown.range && shown.domain && range && domain) {
      const x0 = position(range[0], shown.range),
        x1 = position(range[1], shown.range);
      const y0 = position(domain[0], shown.domain),
        y1 = position(domain[1], shown.domain);
      map[0] = x1 - x0;
      map[1] = y1 - y0;
      map[2] = x0;
      map[3] = 1 - y1;
    } else {
      map[0] = map[1] = 1;
      map[2] = map[3] = 0;
    }
    map[4] = alpha;
    this.device.queue.writeBuffer(this.#compositeUniform, 0, map);
    this.#compositeGroup ??= this.device.createBindGroup({
      layout: this.#composite.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: shown.historyView },
        { binding: 1, resource: shown.focusView },
        { binding: 2, resource: { buffer: this.#compositeUniform } },
        { binding: 3, resource: this.#sampler },
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

  /** The size the next rebuild draws at; the shown image stretches to the canvas meanwhile. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
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
    this.#drop(this.#drawing);
    this.#drop(this.#shown);
    this.#lut.destroy();
    this.#compositeUniform.destroy();
    this.#historyUniform.destroy();
    this.#focusUniform.destroy();
  }
  #show(image: Image): void {
    this.#drop(this.#shown);
    this.#shown = image;
    this.#compositeGroup = null;
  }
  #fits(image: Image): boolean {
    return image.width === this.width && image.height === this.height;
  }
  #drop(image: Image | null): void {
    image?.history.destroy();
    image?.focus.destroy();
  }
  #image(): Image {
    const texture = (label: string) =>
      this.device.createTexture({
        label,
        size: { width: this.width, height: this.height },
        format: this.#format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    const history = texture('monitor-history');
    const focus = texture('monitor-focus-history');
    return {
      history,
      focus,
      historyView: history.createView(),
      focusView: focus.createView(),
      width: this.width,
      height: this.height,
      range: null,
      domain: null,
    };
  }
}
