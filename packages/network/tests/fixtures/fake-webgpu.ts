/// <reference types="@webgpu/types" />

import { vi } from 'vitest';
import type { Presentation } from '@latkit/gpu';

export interface FakeBuffer {
  readonly descriptor: GPUBufferDescriptor;
  readonly mapped: Uint8Array;
  destroyed: boolean;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

export interface FakeTexture {
  readonly descriptor: GPUTextureDescriptor;
  destroyed: boolean;
  createView: ReturnType<typeof vi.fn>;
  destroy(): void;
}

export interface FakeRenderPassCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export class FakeRenderPass {
  readonly calls: FakeRenderPassCall[] = [];

  setPipeline = vi.fn((pipeline: GPURenderPipeline) => {
    this.calls.push({ method: 'setPipeline', args: [pipeline] });
  });
  setBindGroup = vi.fn((index: number, bindGroup: GPUBindGroup) => {
    this.calls.push({ method: 'setBindGroup', args: [index, bindGroup] });
  });
  setVertexBuffer = vi.fn((slot: number, buffer: GPUBuffer, offset?: number, size?: number) => {
    this.calls.push({ method: 'setVertexBuffer', args: [slot, buffer, offset, size] });
  });
  setIndexBuffer = vi.fn(
    (buffer: GPUBuffer, format: GPUIndexFormat, offset?: number, size?: number) => {
      this.calls.push({ method: 'setIndexBuffer', args: [buffer, format, offset, size] });
    },
  );
  draw = vi.fn((...args: Parameters<GPURenderPassEncoder['draw']>) => {
    this.calls.push({ method: 'draw', args });
  });
  drawIndexed = vi.fn((...args: Parameters<GPURenderPassEncoder['drawIndexed']>) => {
    this.calls.push({ method: 'drawIndexed', args });
  });
  drawIndirect = vi.fn((...args: Parameters<GPURenderPassEncoder['drawIndirect']>) => {
    this.calls.push({ method: 'drawIndirect', args });
  });
  end = vi.fn(() => {
    this.calls.push({ method: 'end', args: [] });
  });
}

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
  readonly failBufferLabels = new Set<string>();
  readonly failTextureLabels = new Set<string>();

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
    if (descriptor.label && this.failBufferLabels.has(descriptor.label)) {
      throw new Error(`failed buffer ${descriptor.label}`);
    }
    const mapped = new Uint8Array(Number(descriptor.size));
    const buffer: FakeBuffer = {
      descriptor,
      mapped,
      destroyed: false,
      getMappedRange() {
        return mapped.buffer;
      },
      unmap() {},
      destroy() {
        this.destroyed = true;
      },
    };
    this.buffers.push(buffer);
    return buffer as unknown as GPUBuffer;
  });

  createTexture = vi.fn((descriptor: GPUTextureDescriptor): GPUTexture => {
    if (descriptor.label && this.failTextureLabels.has(descriptor.label)) {
      throw new Error(`failed texture ${descriptor.label}`);
    }
    const texture: FakeTexture = {
      descriptor,
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
    return { descriptor } as unknown as GPUShaderModule;
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
}

export interface FakeGpuHarness {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly device: FakeGpuDevice;
  readonly presentation: Presentation;
}

export function installWebGpuConstants(): void {
  Object.assign(globalThis, {
    GPUBufferUsage: { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
    GPUTextureUsage: { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 },
  });
}

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
      resize: vi.fn(),
      observe: vi.fn((listener: (width: number, height: number, pixelRatio: number) => void) => {
        listener(canvas.width, canvas.height, 1);
        return () => {};
      }),
      destroy: vi.fn(),
    },
  };
}

export async function flushGpuPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
