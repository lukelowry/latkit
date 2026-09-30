import { vi } from 'vitest';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export interface FakeBuffer extends GPUBuffer {
  readonly bytes: Uint8Array;
  readonly destroyed: boolean;
}
export interface FakeTexture extends GPUTexture {
  readonly destroyed: boolean;
}

export function fakeDevice(
  options: { readonly deferCompletion?: boolean; readonly limits?: Record<string, number> } = {},
) {
  vi.stubGlobal('GPUBufferUsage', {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
  });
  vi.stubGlobal('GPUTextureUsage', {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  });
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  const loss = deferred<GPUDeviceLostInfo>();
  const buffers: FakeBuffer[] = [];
  const textures: FakeTexture[] = [];
  const completions: ReturnType<typeof deferred<void>>[] = [];
  const executions: (() => void)[][] = [];
  let current: (() => void)[] = [];
  const queue = {
    writeBuffer: vi.fn(
      (
        buffer: FakeBuffer,
        offset: number,
        data: ArrayBuffer,
        from: number = 0,
        size: number = data.byteLength - from,
      ) => {
        if (buffer.destroyed || offset & 3 || size & 3 || offset + size > buffer.size)
          throw new Error('Invalid fake GPU write');
        buffer.bytes.set(new Uint8Array(data, from, size), offset);
      },
    ),
    writeTexture: vi.fn(),
    submit: vi.fn((commands: { execute: () => void }[]) => {
      for (const command of commands) command.execute();
      executions.push(current);
      current = [];
    }),
    onSubmittedWorkDone: vi.fn(() => {
      if (!options.deferCompletion) return Promise.resolve();
      const next = deferred<void>();
      completions.push(next);
      return next.promise;
    }),
  };
  const device = {
    limits: {
      maxStorageBuffersPerShaderStage: 8,
      maxBufferSize: 256 * 1024 ** 2,
      maxStorageBufferBindingSize: 128 * 1024 ** 2,
      maxUniformBufferBindingSize: 65536,
      minStorageBufferOffsetAlignment: 256,
      minUniformBufferOffsetAlignment: 256,
      maxTextureDimension1D: 8192,
      maxTextureDimension2D: 8192,
      maxTextureDimension3D: 2048,
      maxTextureArrayLayers: 256,
      ...options.limits,
    },
    features: new Set(),
    queue,
    lost: loss.promise,
    destroy: vi.fn(() =>
      loss.resolve({ reason: 'destroyed', message: 'destroyed' } as GPUDeviceLostInfo),
    ),
    createSampler: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({ descriptor })),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      let destroyed = false;
      const bytes = new Uint8Array(descriptor.size);
      const buffer = {
        size: descriptor.size,
        usage: descriptor.usage,
        bytes,
        get destroyed() {
          return destroyed;
        },
        destroy: vi.fn(() => {
          destroyed = true;
        }),
      } as unknown as FakeBuffer;
      buffers.push(buffer);
      return buffer;
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      let destroyed = false;
      const size = [...(descriptor.size as Iterable<number>)];
      const texture = {
        width: size[0],
        height: size[1] ?? 1,
        depthOrArrayLayers: size[2] ?? 1,
        format: descriptor.format,
        usage: descriptor.usage,
        get destroyed() {
          return destroyed;
        },
        destroy: vi.fn(() => {
          destroyed = true;
        }),
        createView: vi.fn(() => ({ texture })),
      } as unknown as FakeTexture;
      textures.push(texture);
      return texture;
    }),
    createCommandEncoder: vi.fn(() => {
      const work: (() => void)[] = [];
      const encoder = {
        copyBufferToBuffer(
          source: FakeBuffer,
          from: number,
          destination: FakeBuffer,
          to: number,
          size: number,
        ) {
          work.push(() => destination.bytes.set(source.bytes.subarray(from, from + size), to));
        },
        finish: vi.fn(() => ({
          execute: () => {
            for (const task of work) task();
          },
        })),
        record(task: () => void) {
          work.push(task);
        },
      };
      return encoder;
    }),
    createRenderPipelineAsync: vi.fn(async (_descriptor: GPURenderPipelineDescriptor) => ({
      kind: 'render',
    })),
    createComputePipelineAsync: vi.fn(async (_descriptor: GPUComputePipelineDescriptor) => ({
      kind: 'compute',
    })),
  };
  return {
    device: device as unknown as GPUDevice,
    native: device,
    queue,
    buffers,
    textures,
    completions,
    lose: (message = 'test loss') =>
      loss.resolve({ reason: 'unknown', message } as GPUDeviceLostInfo),
    finish: () => {
      for (const completion of completions.splice(0)) completion.resolve();
    },
  };
}

export function bytes(binding: GPUBufferBinding): Uint8Array {
  const buffer = binding.buffer as FakeBuffer;
  return buffer.bytes.subarray(
    binding.offset ?? 0,
    (binding.offset ?? 0) + (binding.size ?? buffer.size),
  );
}

export function record(encoder: GPUCommandEncoder, task: () => void): void {
  (encoder as unknown as { record(task: () => void): void }).record(task);
}
