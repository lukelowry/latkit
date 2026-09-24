/// <reference types="@webgpu/types" />

import type { Presentation } from '@latkit/gpu';
import { vi } from 'vitest';

/** A recorded buffer: its descriptor and whether it was destroyed. */
export interface FakeBuffer {
  readonly descriptor: GPUBufferDescriptor;
  readonly label: string;
  readonly size: number;
  destroyed: boolean;
  destroy(): void;
}

/** A recorded texture: its descriptor, its views, and whether it was destroyed. */
export interface FakeTexture {
  readonly descriptor: GPUTextureDescriptor;
  readonly label: string;
  destroyed: boolean;
  createView: ReturnType<typeof vi.fn>;
  destroy(): void;
}

/** One call a render pass recorded. */
export interface FakeRenderPassCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A render pass that records every call in order. */
export class FakeRenderPass {
  readonly calls: FakeRenderPassCall[] = [];

  setPipeline = vi.fn((pipeline: GPURenderPipeline) => {
    this.calls.push({ method: 'setPipeline', args: [pipeline] });
  });
  setBindGroup = vi.fn((index: number, bindGroup: GPUBindGroup | null) => {
    this.calls.push({ method: 'setBindGroup', args: [index, bindGroup] });
  });
  setVertexBuffer = vi.fn((slot: number, buffer: GPUBuffer, offset?: number, size?: number) => {
    this.calls.push({ method: 'setVertexBuffer', args: [slot, buffer, offset, size] });
  });
  draw = vi.fn((...args: Parameters<GPURenderPassEncoder['draw']>) => {
    this.calls.push({ method: 'draw', args });
  });
  end = vi.fn(() => {
    this.calls.push({ method: 'end', args: [] });
  });
}

/** A command encoder that records its render passes. */
export class FakeCommandEncoder {
  readonly passes: FakeRenderPass[] = [];
  readonly descriptors: GPURenderPassDescriptor[] = [];

  beginRenderPass = vi.fn((descriptor: GPURenderPassDescriptor) => {
    this.descriptors.push(descriptor);
    const pass = new FakeRenderPass();
    this.passes.push(pass);
    return pass as unknown as GPURenderPassEncoder;
  });

  finish = vi.fn(() => ({ label: 'command-buffer' }) as unknown as GPUCommandBuffer);
}

/** A device that records every resource it creates and every queue call. */
export class FakeGpuDevice {
  readonly buffers: FakeBuffer[] = [];
  readonly textures: FakeTexture[] = [];
  readonly bindGroups: GPUBindGroupDescriptor[] = [];
  readonly bindGroupLayouts: GPUBindGroupLayoutDescriptor[] = [];
  readonly pipelineLayouts: GPUPipelineLayoutDescriptor[] = [];
  readonly shaderModules: GPUShaderModuleDescriptor[] = [];
  readonly renderPipelines: GPURenderPipelineDescriptor[] = [];
  readonly encoders: FakeCommandEncoder[] = [];
  readonly samplers: GPUSamplerDescriptor[] = [];

  readonly queue = {
    writeBuffer: vi.fn(),
    writeTexture: vi.fn(),
    submit: vi.fn(),
  };

  limits: Partial<GPUSupportedLimits>;

  constructor(limits: Partial<GPUSupportedLimits> = {}) {
    this.limits = limits;
  }

  createBuffer = vi.fn((descriptor: GPUBufferDescriptor): GPUBuffer => {
    const buffer: FakeBuffer = {
      descriptor,
      label: descriptor.label ?? '',
      size: Number(descriptor.size),
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    this.buffers.push(buffer);
    return buffer as unknown as GPUBuffer;
  });

  createTexture = vi.fn((descriptor: GPUTextureDescriptor): GPUTexture => {
    const texture: FakeTexture = {
      descriptor,
      label: descriptor.label ?? '',
      destroyed: false,
      createView: vi.fn(() => ({ texture }) as unknown as GPUTextureView),
      destroy() {
        this.destroyed = true;
      },
    };
    this.textures.push(texture);
    return texture as unknown as GPUTexture;
  });

  createSampler = vi.fn((descriptor: GPUSamplerDescriptor): GPUSampler => {
    this.samplers.push(descriptor);
    return { descriptor } as unknown as GPUSampler;
  });

  createBindGroupLayout = vi.fn((descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout => {
    this.bindGroupLayouts.push(descriptor);
    return { descriptor } as unknown as GPUBindGroupLayout;
  });

  createPipelineLayout = vi.fn((descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout => {
    this.pipelineLayouts.push(descriptor);
    return { descriptor } as unknown as GPUPipelineLayout;
  });

  createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor): GPUBindGroup => {
    this.bindGroups.push(descriptor);
    return { descriptor } as unknown as GPUBindGroup;
  });

  createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor): GPUShaderModule => {
    this.shaderModules.push(descriptor);
    return { label: descriptor.label, descriptor } as unknown as GPUShaderModule;
  });

  createRenderPipelineAsync = vi.fn(
    async (descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> => {
      this.renderPipelines.push(descriptor);
      return { label: descriptor.label, descriptor } as unknown as GPURenderPipeline;
    },
  );

  createCommandEncoder = vi.fn((): GPUCommandEncoder => {
    const encoder = new FakeCommandEncoder();
    this.encoders.push(encoder);
    return encoder as unknown as GPUCommandEncoder;
  });

  /** The buffers created with `label`, oldest first. */
  buffersLabeled(label: string): FakeBuffer[] {
    return this.buffers.filter((buffer) => buffer.label === label);
  }

  /** The textures created with `label`, oldest first. */
  texturesLabeled(label: string): FakeTexture[] {
    return this.textures.filter((texture) => texture.label === label);
  }
}

/** A fake canvas, context, and device behind one presentation. */
export interface FakeGpuHarness {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly device: FakeGpuDevice;
  readonly presentation: Presentation<HTMLCanvasElement>;
}

/** Install the WebGPU flag namespaces a Node test environment lacks. */
export function installWebGpuConstants(): void {
  Object.assign(globalThis, {
    GPUBufferUsage: { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
    GPUTextureUsage: { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 },
  });
}

/** A presentation over a fake device and a fake canvas. */
export function makeFakeGpu(
  opts: {
    readonly width?: number;
    readonly height?: number;
    readonly limits?: Partial<GPUSupportedLimits>;
  } = {},
): FakeGpuHarness {
  const canvas = {
    width: opts.width ?? 320,
    height: opts.height ?? 180,
  } as HTMLCanvasElement;
  const device = new FakeGpuDevice(opts.limits);
  const swapTexture = {
    createView: vi.fn(() => ({ label: 'swap-view' }) as unknown as GPUTextureView),
  };
  const context = {
    canvas,
    getCurrentTexture: vi.fn(() => swapTexture),
  } as unknown as GPUCanvasContext;
  return {
    canvas,
    context,
    device,
    presentation: {
      canvas,
      context,
      device: device as unknown as GPUDevice,
      format: 'bgra8unorm',
      resize: vi.fn(() => false),
      observe: vi.fn((listener: (width: number, height: number, pixelRatio: number) => void) => {
        listener(canvas.width, canvas.height, 1);
        return () => {};
      }),
      destroy: vi.fn(),
    },
  };
}

/** Let every settled pipeline build's callbacks run. */
export async function flushGpuPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
