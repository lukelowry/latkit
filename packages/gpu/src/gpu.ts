import type { Query, Queryable, Version } from '@latkit/model';
import { BufferData } from './buffers.js';
import { Buffers, type BufferResource } from './owned-buffer.js';
import { Images } from './images.js';
import { TextureData } from './texture-data.js';
import { Allocator } from './allocation.js';
import { Reads } from './data.js';
import { GpuError, integer, interruptible } from './error.js';
import { Memory, type Budget, type Entry, type GpuStats } from './memory.js';
import { Textures, type TextureResource } from './resources.js';
import {
  targetResources,
  type FrameInfo,
  type Preparation,
  type QueryResult,
  type Renderer,
  type RenderOptions,
} from './render.js';
import { Uploader, type UploadScope } from './uploads.js';

export interface GpuOptions {
  /** Borrowed when supplied. Otherwise this owner requests and owns a device. */
  readonly device?: GPUDevice;
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: Readonly<Record<string, number>>;
  readonly budget?: Partial<Budget>;
  readonly pageBytes?: number;
  readonly maxBlockBytes?: number;
  readonly maxFramesInFlight?: number;
  /** Full model boundary validation. Coherence and upload bounds are always checked. */
  readonly validate?: boolean;
}

export interface Gpu {
  readonly device: GPUDevice;
  readonly lost: Promise<GPUDeviceLostInfo>;
  readonly budget: Budget;
  stats(): GpuStats;
  render(options: RenderOptions): Promise<void>;
  buffer(descriptor: GPUBufferDescriptor): BufferResource;
  texture(descriptor: GPUTextureDescriptor): TextureResource;
  /** Immutable descriptor identity is the cache key. */
  renderPipeline(descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline>;
  computePipeline(descriptor: GPUComputePipelineDescriptor): Promise<GPUComputePipeline>;
  /** Wait for already submitted managed work. Does not await ongoing preparation. */
  idle(): Promise<void>;
  /** Evict resources that no owner or submitted frame is using. */
  trim(): void;
  destroy(): void;
}

export async function createGpu(options: GpuOptions = {}): Promise<Gpu> {
  let device = options.device;
  if (!device) {
    const api = globalThis.navigator?.gpu;
    if (!api) throw new GpuError('unavailable', 'WebGPU is unavailable');
    const adapter = await api.requestAdapter({ powerPreference: options.powerPreference });
    if (!adapter) throw new GpuError('unavailable', 'No WebGPU adapter is available');
    try {
      device = await adapter.requestDevice({
        requiredFeatures: options.requiredFeatures,
        requiredLimits: options.requiredLimits,
      });
    } catch (cause) {
      throw new GpuError('unavailable', 'The requested GPU device could not be created', { cause });
    }
  } else {
    for (const feature of options.requiredFeatures ?? [])
      if (!device.features.has(feature))
        throw new GpuError('unsupported', 'Missing GPU feature: ' + feature);
    for (const [limit, requested] of Object.entries(options.requiredLimits ?? {})) {
      const actual = (device.limits as unknown as Record<string, number>)[limit];
      if (
        actual === undefined ||
        (limit.startsWith('min') ? actual > requested : actual < requested)
      )
        throw new GpuError('unsupported', 'Insufficient GPU limit: ' + limit);
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
  readonly lost: Promise<GPUDeviceLostInfo>;
  readonly budget: Budget;
  private readonly memory: Memory;
  private readonly reads: Reads;
  private readonly uploader: Uploader;
  private readonly textures: Textures;
  private readonly images: Images;
  private readonly buffers: Buffers;
  private readonly stopped = new AbortController();
  private readonly busy = new Set<Renderer>();
  private readonly pending = new Set<Promise<void>>();
  private readonly pipelines = new Map<
    object,
    { entry: Entry; promise: Promise<GPURenderPipeline | GPUComputePipeline> }
  >();
  private readonly maxFrames: number;

  constructor(
    readonly device: GPUDevice,
    private readonly ownsDevice: boolean,
    options: GpuOptions,
  ) {
    this.memory = new Memory(options.budget);
    this.budget = this.memory.budget;
    this.maxFrames = integer(options.maxFramesInFlight ?? 2, 'frames in flight', 1, 64);
    this.uploader = new Uploader(
      new Allocator(device, this.memory),
      this.memory,
      options.pageBytes ?? 1024 ** 2,
    );
    this.reads = new Reads(
      this.memory,
      integer(options.maxBlockBytes ?? 1024 ** 2, 'block bytes', 1),
      options.validate ?? false,
    );
    this.textures = new Textures(device, this.memory);
    this.images = new Images(device, this.memory);
    this.buffers = new Buffers(device, this.memory);
    this.lost = device.lost;
    void this.lost.then((info) =>
      this.stop(new GpuError('device-lost', info.message || 'GPU device lost')),
    );
  }

  stats(): GpuStats {
    return this.memory.stats();
  }
  private assertLive(): void {
    this.stopped.signal.throwIfAborted();
  }

  async render(options: RenderOptions): Promise<void> {
    this.assertLive();
    if (!Number.isFinite(options.timeMs))
      throw new GpuError('invalid-input', 'Frame time must be finite');
    const renderers = new Set(options.views.map((view) => view.renderer));
    if (renderers.size !== options.views.length)
      throw new GpuError('invalid-input', 'A renderer may appear only once in a frame');
    for (const renderer of renderers)
      if (this.busy.has(renderer))
        throw new GpuError('busy', 'Renderer already has a preparation in progress');
    const cancelled = new AbortController();
    const signal = AbortSignal.any([
      this.stopped.signal,
      cancelled.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const infos = options.views.map((view) => {
      if (view.target.device !== this.device)
        throw new GpuError('invalid-input', 'Target belongs to a different device');
      integer(view.target.width, 'target width', 1);
      integer(view.target.height, 'target height', 1);
      if (view.at !== undefined && !Number.isFinite(view.at))
        throw new GpuError('invalid-input', 'Model coordinate must be finite');
      const viewport = view.viewport ?? {
        width: view.target.width,
        height: view.target.height,
        pixelRatio: 1,
      };
      if (
        ![viewport.width, viewport.height, viewport.pixelRatio].every(
          (value) => Number.isFinite(value) && value > 0,
        )
      )
        throw new GpuError('invalid-input', 'Viewport dimensions and pixel ratio must be positive');
      return {
        at: view.at,
        timeMs: options.timeMs,
        viewport: { ...viewport },
        format: view.target.format,
        width: view.target.width,
        height: view.target.height,
      };
    });
    for (const renderer of renderers) this.busy.add(renderer);
    const held = new Set<Entry>();
    const checks: (() => void)[] = [];
    const versions = new Map<Queryable, Version>();
    const subscriptions: (() => void)[] = [];
    const iterators = new Set<AsyncIterator<unknown>>();
    let phase: 'prepare' | 'encode' | 'closed' = 'prepare';
    let submitted = false;
    let preparation: Promise<unknown> = Promise.resolve();
    const assertPreparing = (): void => {
      signal.throwIfAborted();
      if (phase !== 'prepare') throw new GpuError('closed', 'Frame preparation is finished');
    };
    const scope: UploadScope = {
      use: (entry) => {
        assertPreparing();
        if (!held.has(entry)) {
          entry.pin();
          held.add(entry);
        }
      },
      check: (check) => {
        assertPreparing();
        checks.push(check);
      },
    };
    const release = (): void => {
      for (const entry of held) entry.unpin();
      held.clear();
    };
    const read = <Q extends Query>(source: Queryable, query: Q): AsyncIterable<QueryResult<Q>> => {
      const reads = this.reads;
      return {
        async *[Symbol.asyncIterator]() {
          assertPreparing();
          const iterator = reads.query(source, query, signal)[Symbol.asyncIterator]();
          iterators.add(iterator);
          try {
            for (;;) {
              assertPreparing();
              const next = await interruptible(iterator.next(), signal);
              assertPreparing();
              if (next.done) return;
              if (next.value.kind === 'schema') {
                const version = next.value.version;
                const previous = versions.get(source);
                if (previous !== undefined && previous !== version)
                  throw new GpuError(
                    'conflict',
                    'Frame queries observed different source versions',
                  );
                if (previous === undefined) {
                  versions.set(source, version);
                  subscriptions.push(
                    source.on('change', (change) => {
                      if (change.kind === 'closed')
                        cancelled.abort(new GpuError('closed', 'A frame source was closed'));
                    }),
                  );
                }
              }
              yield next.value as QueryResult<Q>;
            }
          } finally {
            iterators.delete(iterator);
            void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
          }
        },
      };
    };
    const makeFrame = (info: FrameInfo): Preparation => ({
      ...info,
      signal,
      query: read,
      upload: (block, uploadOptions) => {
        assertPreparing();
        return this.uploader.upload(block, uploadOptions, scope);
      },
      values: (values, uploadOptions = {}) => {
        assertPreparing();
        return this.uploader.values(values, uploadOptions, scope);
      },
      buffer: (data) => {
        assertPreparing();
        if (data instanceof BufferData) return this.uploader.buffer(data, scope);
        scope.use(this.buffers.entry(data));
        return { buffer: data.buffer, offset: 0, size: data.buffer.size };
      },
      uniforms: (data) => {
        assertPreparing();
        return this.uploader.uniforms(data, scope);
      },
      texture: (resource) => {
        assertPreparing();
        if (resource instanceof TextureData) return this.images.upload(resource, scope);
        scope.use(this.textures.entry(resource));
        return resource.texture;
      },
    });
    try {
      while (this.pending.size >= this.maxFrames)
        await interruptible(Promise.race(this.pending), signal);
      const jobs = options.views.map((view, i) =>
        Promise.resolve().then(() => view.renderer.prepare(makeFrame(infos[i]))),
      );
      preparation = Promise.allSettled(jobs);
      await interruptible(Promise.all(jobs), signal);
      while (this.pending.size >= this.maxFrames)
        await interruptible(Promise.race(this.pending), signal);
      assertPreparing();
      if (iterators.size)
        throw new GpuError('invalid-input', 'Preparation left query iterators open');
      for (const check of checks) check();
      for (const [i, view] of options.views.entries()) {
        if (
          view.target.width !== infos[i].width ||
          view.target.height !== infos[i].height ||
          view.target.format !== infos[i].format
        )
          throw new GpuError('conflict', 'Target changed during preparation');
        const resource = targetResources.get(view.target)?.();
        if (resource) scope.use(this.textures.entry(resource));
      }
      phase = 'encode';
      const encoder = this.device.createCommandEncoder({ label: 'latkit frame' });
      const targets = new Map<object, GPUTextureView>();
      for (const [i, view] of options.views.entries()) {
        signal.throwIfAborted();
        let target = targets.get(view.target);
        if (!target) {
          target = view.target.texture().createView();
          targets.set(view.target, target);
        }
        const result: unknown = view.renderer.encode({ ...infos[i], encoder, target });
        if (result && typeof (result as PromiseLike<unknown>).then === 'function')
          throw new GpuError('invalid-input', 'Renderer encoding must be synchronous');
      }
      const extra: unknown = options.encode?.(encoder);
      if (extra && typeof (extra as PromiseLike<unknown>).then === 'function')
        throw new GpuError('invalid-input', 'Final encoding must be synchronous');
      signal.throwIfAborted();
      this.device.queue.submit([encoder.finish()]);
      submitted = true;
      this.memory.submissions++;
      const done = this.device.queue.onSubmittedWorkDone();
      this.pending.add(done);
      void done.then(
        () => {
          release();
          this.pending.delete(done);
        },
        (error) => {
          release();
          this.pending.delete(done);
          this.stop(error);
        },
      );
    } catch (error) {
      cancelled.abort(error);
      throw error;
    } finally {
      phase = 'closed';
      cancelled.abort(new DOMException('Frame preparation ended', 'AbortError'));
      for (const iterator of iterators)
        void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
      for (const off of subscriptions) off();
      if (!submitted) release();
      // An uncooperative prepare cannot race a later call on the same renderer.
      void preparation.then(() => {
        for (const renderer of renderers) this.busy.delete(renderer);
      });
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
  renderPipeline(descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
    return this.pipeline(descriptor, () =>
      this.device.createRenderPipelineAsync(descriptor),
    ) as Promise<GPURenderPipeline>;
  }
  computePipeline(descriptor: GPUComputePipelineDescriptor): Promise<GPUComputePipeline> {
    return this.pipeline(descriptor, () =>
      this.device.createComputePipelineAsync(descriptor),
    ) as Promise<GPUComputePipeline>;
  }
  private pipeline(
    descriptor: object,
    create: () => Promise<GPURenderPipeline | GPUComputePipeline>,
  ): Promise<GPURenderPipeline | GPUComputePipeline> {
    this.assertLive();
    const cached = this.pipelines.get(descriptor);
    if (cached?.entry.live) {
      cached.entry.touched = ++this.memory.clock;
      return cached.promise;
    }
    const entry = this.memory.add([], 512, () => {
      this.pipelines.delete(descriptor);
    });
    const promise = Promise.resolve()
      .then(create)
      .then(
        (pipeline) => {
          this.assertLive();
          entry.unpin();
          return pipeline;
        },
        (error) => {
          this.memory.remove(entry);
          throw error;
        },
      );
    this.pipelines.set(descriptor, { entry, promise });
    return promise;
  }
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }
  trim(): void {
    this.memory.trim();
  }
  private stop(reason: unknown): void {
    if (this.stopped.signal.aborted) return;
    this.stopped.abort(reason);
    this.reads.destroy();
    this.memory.destroy();
    this.pipelines.clear();
  }
  destroy(): void {
    if (this.stopped.signal.aborted) return;
    this.stop(new GpuError('closed', 'Gpu is closed'));
    if (this.ownsDevice) this.device.destroy();
  }
}
