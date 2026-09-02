/// <reference types="@webgpu/types" />

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BORDER_VERTEX_STRIDE_BYTES, validateBorders } from '../src/borders/index.js';
import { BorderBuffers } from '../src/webgpu/border-buffers.js';

interface FakeBuffer {
  label?: string;
  size: number;
  usage: number;
  destroyed: boolean;
  mapped: Uint8Array;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

function installWebGpuConstants(): void {
  Object.assign(globalThis, {
    GPUBufferUsage: { INDEX: 16, VERTEX: 32 },
  });
}

function fakeDevice() {
  const buffers: FakeBuffer[] = [];
  const device = {
    createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
      const mapped = new Uint8Array(Number(descriptor.size));
      const buffer: FakeBuffer = {
        label: descriptor.label,
        size: Number(descriptor.size),
        usage: descriptor.usage,
        destroyed: false,
        mapped,
        getMappedRange() {
          return mapped.buffer;
        },
        unmap() {},
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer as unknown as GPUBuffer;
    },
  } as unknown as GPUDevice;

  return { device, buffers };
}

describe('Borders GPU resource', () => {
  beforeEach(() => {
    installWebGpuConstants();
  });

  it('uploads packed vertices and indices into one GPU buffer', () => {
    const { device, buffers } = fakeDevice();
    const vertices = new Uint8Array(2 * BORDER_VERTEX_STRIDE_BYTES);
    const indices = new Uint32Array([0, 1, 0xffffffff]);
    vertices.set([1, 2, 3, 4]);

    const borders = BorderBuffers.create(device, { vertices, indices });

    expect(borders.indexCount).toBe(3);
    expect(buffers.map((buffer) => [buffer.label, buffer.size, buffer.usage])).toEqual([
      [
        'borders',
        vertices.byteLength + indices.byteLength,
        GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX,
      ],
    ]);
    expect(Array.from(buffers[0]!.mapped.slice(0, 4))).toEqual([1, 2, 3, 4]);
    expect(new Uint32Array(buffers[0]!.mapped.buffer, vertices.byteLength, indices.length)).toEqual(
      indices,
    );
  });

  it('rejects invalid vertex byte lengths', () => {
    const { device } = fakeDevice();
    expect(() =>
      BorderBuffers.create(device, {
        vertices: new Uint8Array(BORDER_VERTEX_STRIDE_BYTES - 1),
        indices: new Uint32Array([0]),
      }),
    ).toThrow('vertex data must be a multiple');
  });

  it('rejects shape-compatible objects before GPU upload', () => {
    expect(() =>
      validateBorders({
        vertices: new Uint8Array(BORDER_VERTEX_STRIDE_BYTES),
        indices: { byteOffset: 2 } as Uint32Array<ArrayBuffer>,
      }),
    ).toThrow('indices must be a Uint32Array');
    expect(() =>
      validateBorders({
        vertices: { byteLength: BORDER_VERTEX_STRIDE_BYTES } as Uint8Array<ArrayBuffer>,
        indices: new Uint32Array([0]),
      }),
    ).toThrow('vertices must be a Uint8Array');
  });

  it('destroys the owned GPU buffer', () => {
    const { device, buffers } = fakeDevice();
    const borders = BorderBuffers.create(device, {
      vertices: new Uint8Array(BORDER_VERTEX_STRIDE_BYTES),
      indices: new Uint32Array([0]),
    });

    borders.destroy();

    expect(buffers[0]!.destroyed).toBe(true);
  });

  it('binds the packed vertex and index ranges', () => {
    const { device } = fakeDevice();
    const borders = BorderBuffers.create(device, {
      vertices: new Uint8Array(BORDER_VERTEX_STRIDE_BYTES),
      indices: new Uint32Array([0, 1]),
    });
    const pass = {
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
    };

    borders.bind(pass as unknown as GPURenderPassEncoder);

    expect(pass.setVertexBuffer).toHaveBeenCalledWith(
      0,
      expect.anything(),
      0,
      BORDER_VERTEX_STRIDE_BYTES,
    );
    expect(pass.setIndexBuffer).toHaveBeenCalledWith(
      expect.anything(),
      'uint32',
      BORDER_VERTEX_STRIDE_BYTES,
      Uint32Array.BYTES_PER_ELEMENT * 2,
    );
  });
});
