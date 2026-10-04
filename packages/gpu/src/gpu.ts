import {
  interruptible,
  failure,
  createMemory,
  createReader,
  type Memory,
  type MemoryBudget,
  type MemoryEntry,
  type MemoryStats,
  type Reader,
} from '@latkit/model';
import { renderers as rendererTree } from './frame/tree.js';
import { renderFrame, type FrameOwner } from './frame/frame.js';
import type { Renderer, RenderOptions } from './frame/render.js';
import { Buffers, type BufferResource } from './memory/buffers.js';
import { Colormaps } from './colors/preparation.js';
import { Images } from './memory/images.js';
import { TextAtlas } from './text/atlas.js';
import type { TextLayout, TextLayoutInput, TextOptions } from './text/text.js';
import { Allocator } from './memory/allocation.js';
import { integer } from './error.js';
import { Uniforms } from './frame/uniforms.js';
import { Textures, type TextureResource } from './memory/textures.js';
import { Uploader } from './fields/upload.js';

export interface GpuOptions {
  /** Borrowed when supplied. Otherwise this owner requests and owns a device. */
  readonly device?: GPUDevice;
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: Readonly<Record<string, number>>;
  /** One pool bounds the reader's cache, uploads, and GPU resources together. */
  readonly budget?: Partial<MemoryBudget>;
  readonly pageBytes?: number;
  readonly maxBlockBytes?: number;
  readonly maxFramesInFlight?: number;
  /** Full model boundary validation of every read. Upload bounds are always checked. */
  readonly validate?: boolean;
  readonly text?: TextOptions;
}

export interface Gpu {
  readonly device: GPUDevice;
  /**
   * Aborts when this Gpu stops: with a `device-lost` failure when the device is lost, or `closed`
   * after `destroy`. Views stop drawing then; after device loss, recreate the Gpu and its views.
   */
  readonly signal: AbortSignal;
  readonly budget: MemoryBudget;
  /** One bounded, memoized reader for every view, job, and layout on this Gpu. */
  readonly reader: Reader;
  readonly fieldLayout: GPUBindGroupLayout;
  readonly textLayout: GPUBindGroupLayout;
  readonly colormapLayout: GPUBindGroupLayout;
  /** Lines of text, measured and broken as the input says, ready to draw as runs. */
  layoutText(
    input: TextLayoutInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<TextLayout>;
  stats(): MemoryStats;
  render(options: RenderOptions): Promise<void>;
  buffer(descriptor: GPUBufferDescriptor): BufferResource;
  texture(descriptor: GPUTextureDescriptor): TextureResource;
  /** A validated shader module; identical code shares one. Invalid WGSL rejects with `invalid-input`. */
  shaderModule(code: string, label?: string): Promise<GPUShaderModule>;
  /** A pipeline, created while the Gpu is live; views keep and share their own variants. */
  renderPipeline(descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline>;
  computePipeline(descriptor: GPUComputePipelineDescriptor): Promise<GPUComputePipeline>;
  /** Wait for already submitted managed work. Does not await ongoing preparation. */
  idle(): Promise<void>;
  /** Evict resources and reads that no owner or submitted frame is using. */
  trim(): void;
  destroy(): void;
}

export async function createGpu(options: GpuOptions = {}): Promise<Gpu> {
  let device = options.device;
  if (!device) {
    const api = globalThis.navigator?.gpu;
    if (!api) throw failure('unavailable', 'WebGPU is unavailable');
    const adapter = await api.requestAdapter({ powerPreference: options.powerPreference });
    if (!adapter) throw failure('unavailable', 'No WebGPU adapter is available');
    try {
      device = await adapter.requestDevice({
        requiredFeatures: options.requiredFeatures,
        requiredLimits: options.requiredLimits,
      });
    } catch (cause) {
      throw failure('unavailable', 'The requested GPU device could not be created', { cause });
    }
  } else {
    for (const feature of options.requiredFeatures ?? [])
      if (!device.features.has(feature))
        throw failure('unsupported', 'Missing GPU feature: ' + feature);
    for (const [limit, requested] of Object.entries(options.requiredLimits ?? {})) {
      const actual = (device.limits as unknown as Record<string, number>)[limit];
      if (
        actual === undefined ||
        (limit.startsWith('min') ? actual > requested : actual < requested)
      )
        throw failure('unsupported', 'Insufficient GPU limit: ' + limit);
    }
  }
  try {
    return new Owner(device, !options.device, options);
  } catch (error) {
    if (!options.device) device.destroy();
    throw error;
  }
}

class Owner implements Gpu {
  readonly budget: MemoryBudget;
  readonly reader: Reader;
  readonly fieldLayout: GPUBindGroupLayout;
  readonly textLayout: GPUBindGroupLayout;
  readonly colormapLayout: GPUBindGroupLayout;
  private readonly memory: Memory;
  private readonly frames: FrameOwner;
  private readonly rendering = new Set<Renderer>();
  private readonly text: TextAtlas;
  private readonly textures: Textures;
  private readonly buffers: Buffers;
  private readonly uniforms: Uniforms;
  private readonly stopped = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly modules = new Map<
    string,
    { entry: MemoryEntry; promise: Promise<GPUShaderModule> }
  >();

  constructor(
    readonly device: GPUDevice,
    private readonly ownsDevice: boolean,
    options: GpuOptions,
  ) {
    this.memory = createMemory(options.budget);
    this.budget = this.memory.budget;
    this.reader = createReader({
      memory: this.memory,
      maxBlockBytes: integer(options.maxBlockBytes ?? 1024 ** 2, 'block bytes', 1),
      validate: options.validate ?? false,
    });
    const uploader = new Uploader(
      new Allocator(device, this.memory),
      this.memory,
      options.pageBytes ?? 1024 ** 2,
    );
    this.fieldLayout = uploader.fieldPages.layout;
    this.textures = new Textures(device, this.memory);
    const images = new Images(device, this.memory);
    const colormaps = new Colormaps(device, this.memory, images, uploader);
    this.colormapLayout = colormaps.layout;
    this.buffers = new Buffers(device, this.memory);
    this.text = new TextAtlas(
      device,
      this.memory,
      this.textures,
      images,
      uploader,
      this.stopped.signal,
      options.text,
    );
    this.textLayout = this.text.layout;
    this.uniforms = new Uniforms(device, this.memory);
    this.frames = {
      device,
      reader: this.reader,
      memory: this.memory,
      uploader,
      uniforms: this.uniforms,
      colormaps,
      text: this.text,
      images,
      textures: this.textures,
      buffers: this.buffers,
      stopped: this.stopped.signal,
      busy: new Set(),
      pending: this.pending,
      maxFrames: integer(options.maxFramesInFlight ?? 2, 'frames in flight', 1, 64),
      stop: (reason) => this.stop(reason),
    };
    void device.lost.then((info) =>
      this.stop(
        failure('device-lost', 'GPU device lost: ' + (info.message || info.reason), {
          cause: info,
        }),
      ),
    );
  }

  get signal(): AbortSignal {
    return this.stopped.signal;
  }

  layoutText(
    input: TextLayoutInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TextLayout> {
    this.assertLive();
    return this.text.layoutText(
      input,
      options.signal ? AbortSignal.any([this.stopped.signal, options.signal]) : this.stopped.signal,
    );
  }

  stats(): MemoryStats {
    return this.memory.stats();
  }
  private assertLive(): void {
    this.stopped.signal.throwIfAborted();
  }

  async render(options: RenderOptions): Promise<void> {
    this.assertLive();
    const renderers = rendererTree(options.views.map((view) => view.renderer));
    for (const renderer of renderers)
      if (this.rendering.has(renderer))
        throw failure('busy', 'Renderer already has a render in progress');
    const signal = options.signal
      ? AbortSignal.any([this.stopped.signal, options.signal])
      : this.stopped.signal;
    for (const renderer of renderers) this.rendering.add(renderer);
    try {
      const complete = options.completion === 'complete';
      do {
        await renderFrame(this.frames, complete ? { ...options, encode: undefined } : options);
        if (!complete) return;
        const pending = renderers.flatMap((renderer) =>
          renderer.pending ? [renderer.pending] : [],
        );
        if (!pending.length) break;
        await interruptible(Promise.all(pending), signal);
      } while (complete);
      // A final callback sees the complete output and runs only once.
      if (options.encode) await renderFrame(this.frames, options);
    } finally {
      for (const renderer of renderers) this.rendering.delete(renderer);
    }
  }

  buffer(descriptor: GPUBufferDescriptor): BufferResource {
    this.assertLive();
    return this.buffers.create(descriptor);
  }
  texture(descriptor: GPUTextureDescriptor): TextureResource {
    this.assertLive();
    return this.textures.create(descriptor);
  }
  shaderModule(code: string, label?: string): Promise<GPUShaderModule> {
    this.assertLive();
    const cached = this.modules.get(code);
    if (cached?.entry.live) {
      cached.entry.touch();
      return cached.promise;
    }
    const entry = this.memory.add([], code.length * 2, () => {
      this.modules.delete(code);
    });
    const device = this.device;
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ label, code }),
      validation = device.popErrorScope();
    const promise = Promise.all([module.getCompilationInfo(), validation]).then(([info, error]) => {
      this.assertLive();
      const errors = info.messages.filter((message) => message.type === 'error');
      if (errors.length || error)
        throw failure(
          'invalid-input',
          (label ? label + ': ' : '') +
            (errors
              .map((message) => message.lineNum + ':' + message.linePos + ' ' + message.message)
              .join('; ') || error!.message),
        );
      entry.unpin();
      return module;
    });
    promise.catch(() => this.memory.remove(entry));
    this.modules.set(code, { entry, promise });
    return promise;
  }
  renderPipeline(descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
    return this.pipeline(() => this.device.createRenderPipelineAsync(descriptor));
  }
  computePipeline(descriptor: GPUComputePipelineDescriptor): Promise<GPUComputePipeline> {
    return this.pipeline(() => this.device.createComputePipelineAsync(descriptor));
  }
  /** Views cache their variants; a pipeline is created once per request and checked live. */
  private async pipeline<P>(create: () => Promise<P>): Promise<P> {
    this.assertLive();
    const pipeline = await create();
    this.assertLive();
    return pipeline;
  }
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }
  trim(): void {
    this.uniforms.trim();
    this.memory.trim();
  }
  private stop(reason: unknown): void {
    if (this.stopped.signal.aborted) return;
    this.stopped.abort(reason);
    this.reader.destroy();
    this.uniforms.destroy();
    this.memory.destroy();
    this.modules.clear();
  }
  destroy(): void {
    if (this.stopped.signal.aborted) return;
    this.stop(failure('closed', 'Gpu is closed'));
    if (this.ownsDevice) this.device.destroy();
  }
}
