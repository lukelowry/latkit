/**
 * Recording WebGPU stub used by monitor renderer tests.
 *
 * Every buffer write, render pass, draw, and copy lands in a log the tests
 * assert against. The stub does not rasterize; tests verify the CPU/GPU
 * boundary that the shader consumes.
 */

export interface DrawRecord {
  readonly pipeline: string;
  readonly target: string;
  readonly vertexCount: number;
  readonly instanceCount: number;
  readonly firstInstance: number;
}

export interface WriteRecord {
  readonly label: string;
  /** The source ArrayBuffer identity, for zero-copy assertions. */
  readonly source: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
  /** Small writes (uniforms, LUTs) are copied for content assertions. */
  readonly copy: Uint8Array | null;
}

export interface BufferRecord {
  readonly label: string;
  readonly size: number;
  destroyed: boolean;
}

export interface GpuLog {
  readonly draws: DrawRecord[];
  readonly writes: WriteRecord[];
  readonly buffers: BufferRecord[];
  readonly clears: string[];
  readonly lutWrites: Uint8Array[];
  copies: number;
  submits: number;
  deviceDestroys: number;
  contextConfigures: number;
  contextUnconfigures: number;
  formatQueries: number;
  resizeDisconnects: number;
}

export interface GpuStub {
  /** One native device shared by every monitor created in a test. */
  readonly device: GPUDevice;
  readonly log: GpuLog;
  setConfigureError(error: Error): void;
  setContextAvailable(available: boolean): void;
  setFormatError(error: Error): void;
  loseDevice(reason?: string, message?: string): void;
  /** Run pending rAF callbacks once, then settle microtasks. */
  frame(): Promise<void>;
  teardown(): void;
}

export function installGpuStub(): GpuStub {
  const log: GpuLog = {
    draws: [],
    writes: [],
    buffers: [],
    clears: [],
    lutWrites: [],
    copies: 0,
    submits: 0,
    deviceDestroys: 0,
    contextConfigures: 0,
    contextUnconfigures: 0,
    formatQueries: 0,
    resizeDisconnects: 0,
  };

  let resolveLost: (info: { reason: string; message: string }) => void = () => {};
  const lost = new Promise<{ reason: string; message: string }>((resolve) => {
    resolveLost = resolve;
  });

  const makeBuffer = (descriptor: { label?: string; size: number }) => {
    const record: BufferRecord = {
      label: descriptor.label ?? '',
      size: descriptor.size,
      destroyed: false,
    };
    log.buffers.push(record);
    return {
      label: record.label,
      size: record.size,
      destroy: () => {
        record.destroyed = true;
      },
    };
  };

  const makeTexture = (descriptor: { label?: string }) => ({
    label: descriptor.label ?? '',
    createView: () => ({ __target: descriptor.label ?? '' }),
    destroy: () => {},
  });

  const device = {
    limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024 },
    lost,
    destroy: () => {
      log.deviceDestroys++;
    },
    createShaderModule: (descriptor: { code: string }) => ({ code: descriptor.code }),
    createRenderPipeline: (descriptor: { label?: string }) => ({
      label: descriptor.label ?? '',
      getBindGroupLayout: () => ({}),
    }),
    createTexture: makeTexture,
    createSampler: () => ({}),
    createBuffer: makeBuffer,
    createBindGroup: (descriptor: { label?: string }) => ({ label: descriptor.label ?? '' }),
    createCommandEncoder: () => {
      const encoder = {
        beginRenderPass: (descriptor: {
          colorAttachments: readonly { view: { __target: string }; loadOp: string }[];
        }) => {
          const attachment = descriptor.colorAttachments[0]!;
          if (attachment.loadOp === 'clear') log.clears.push(attachment.view.__target);
          let pipeline = '';
          return {
            setPipeline: (p: { label: string }) => {
              pipeline = p.label;
            },
            setBindGroup: () => {},
            draw: (vertexCount: number, instanceCount = 1, _firstVertex = 0, firstInstance = 0) => {
              log.draws.push({
                pipeline,
                target: attachment.view.__target,
                vertexCount,
                instanceCount,
                firstInstance,
              });
            },
            end: () => {},
          };
        },
        copyTextureToTexture: () => {
          log.copies++;
        },
        finish: () => ({}),
      };
      return encoder;
    },
    queue: {
      writeBuffer: (
        buffer: { label: string },
        _offset: number,
        data: ArrayBufferLike | ArrayBufferView,
        dataOffset = 0,
        size?: number,
      ) => {
        const isView = ArrayBuffer.isView(data);
        const source = isView ? (data as ArrayBufferView).buffer : (data as ArrayBufferLike);
        const byteOffset = isView ? (data as ArrayBufferView).byteOffset : dataOffset;
        const byteLength =
          size ??
          (isView
            ? (data as ArrayBufferView).byteLength
            : (data as ArrayBufferLike).byteLength - dataOffset);
        const copy =
          byteLength <= 1024
            ? new Uint8Array(source.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer)
            : null;
        log.writes.push({ label: buffer.label, source, byteOffset, byteLength, copy });
      },
      writeTexture: (_dest: unknown, data: Uint8Array) => {
        log.lutWrites.push(new Uint8Array(data));
      },
      submit: () => {
        log.submits++;
      },
    },
  };

  let configureError: Error | undefined;

  const context = () => ({
    configure: () => {
      log.contextConfigures++;
      if (configureError !== undefined) throw configureError;
    },
    unconfigure: () => {
      log.contextUnconfigures++;
    },
    getCurrentTexture: () => ({
      label: 'canvas',
      createView: () => ({ __target: 'canvas' }),
    }),
  });

  let contextAvailable = true;
  let formatError: Error | undefined;

  const originals = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    getContext: HTMLCanvasElement.prototype.getContext,
    GPUTextureUsage: Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage'),
    GPUBufferUsage: Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage'),
    ResizeObserver: Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'),
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'),
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      gpu: {
        getPreferredCanvasFormat: () => {
          log.formatQueries++;
          if (formatError !== undefined) throw formatError;
          return 'bgra8unorm';
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'GPUTextureUsage', {
    configurable: true,
    value: {
      RENDER_ATTACHMENT: 0x10,
      COPY_DST: 0x02,
      COPY_SRC: 0x01,
      TEXTURE_BINDING: 0x04,
    },
  });
  Object.defineProperty(globalThis, 'GPUBufferUsage', {
    configurable: true,
    value: { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 },
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe(): void {}
      disconnect(): void {
        log.resizeDisconnects++;
      }
      unobserve(): void {}
    },
  });

  // Manual rAF pump: frame() runs what is queued, once.
  const pending = new Map<number, FrameRequestCallback>();
  let nextRaf = 1;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: FrameRequestCallback) => {
      const id = nextRaf++;
      pending.set(id, cb);
      return id;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: (id: number) => {
      pending.delete(id);
    },
  });

  HTMLCanvasElement.prototype.getContext = function getContext(
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind === 'webgpu' && contextAvailable) {
      return context() as unknown as RenderingContext;
    }
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;

  return {
    device: device as unknown as GPUDevice,
    log,
    setConfigureError: (error) => {
      configureError = error;
    },
    setContextAvailable: (available) => {
      contextAvailable = available;
    },
    setFormatError: (error) => {
      formatError = error;
    },
    loseDevice: (reason = 'unknown', message = 'lost') => {
      resolveLost({ reason, message });
    },
    frame: async () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb(performance.now());
      await Promise.resolve();
      await Promise.resolve();
    },
    teardown: () => {
      HTMLCanvasElement.prototype.getContext = originals.getContext;
      for (const [key, descriptor] of Object.entries(originals)) {
        if (key === 'getContext') continue;
        if (descriptor) Object.defineProperty(globalThis, key, descriptor as PropertyDescriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}
