/// <reference types="@webgpu/types" />

import { validateBorders, type Borders } from '../borders.js';

/** GPU vertex/index storage for the optional geographic border overlay. */
export class BorderBuffers {
  /** Constructor is private so all instances pass format validation first. */
  private constructor(
    readonly buffer: GPUBuffer,
    readonly vertexOffset: number,
    readonly vertexBytes: number,
    readonly indexOffset: number,
    readonly indexBytes: number,
    readonly indexCount: number,
  ) {}

  /**
   * Validates border data and uploads vertices and indices into one GPU buffer.
   *
   * The vertex payload is placed first and the index payload follows it.
   */
  static create(device: GPUDevice, borders: Borders): BorderBuffers {
    validateBorders(borders);
    const vertexBytes = borders.vertices.byteLength;
    const indexBytes = borders.indices.byteLength;
    const buffer = device.createBuffer({
      label: 'borders',
      size: align4(vertexBytes + indexBytes),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });

    const dst = new Uint8Array(buffer.getMappedRange());
    dst.set(borders.vertices, 0);
    dst.set(bytesOf(borders.indices), vertexBytes);
    buffer.unmap();

    return new BorderBuffers(
      buffer,
      0,
      vertexBytes,
      vertexBytes,
      indexBytes,
      borders.indices.length,
    );
  }

  /** Binds the packed border vertex and index ranges to a render pass. */
  bind(pass: GPURenderPassEncoder): void {
    pass.setVertexBuffer(0, this.buffer, this.vertexOffset, this.vertexBytes);
    pass.setIndexBuffer(this.buffer, 'uint32', this.indexOffset, this.indexBytes);
  }

  /** Releases the GPU buffer owned by this border payload. */
  destroy(): void {
    this.buffer.destroy();
  }
}

/** Rounds a byte size up to the next 4-byte boundary required by buffers. */
function align4(value: number): number {
  return (value + 3) & ~3;
}

/** Returns a byte view over a typed array without copying. */
function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
