import { failure, type Memory } from '@latkit/model';
import { align } from '../error.js';

/** Bytes of one shared uniform buffer, within an eighth of the GPU budget. */
const CHUNK_BYTES = 64 * 1024;
/** Free buffers kept for later frames; a frame that needs more makes them, and they go after it. */
const POOLED = 16;

interface Chunk {
  readonly buffer: GPUBuffer;
  /** What the frame writes, uploaded once before it submits. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  used: number;
}

/** One frame's uniforms, packed into shared buffers. */
export interface FrameUniforms {
  /** Copy uniforms into this frame's buffers; the binding is valid once the frame submits. */
  add(data: ArrayBufferView): GPUBufferBinding;
  /** Upload what the frame wrote, in one write per buffer, before it submits. */
  flush(): void;
  /** Return the buffers once the GPU is done with the frame, or it never submitted. */
  release(): void;
}

/**
 * Uniforms for every frame: each frame packs its uniforms into a few buffers at the device's offset
 * alignment and uploads them once, so a uniform costs a copy rather than an allocation and a write.
 * Buffers return to the pool when their frame is done.
 */
export class Uniforms {
  readonly #free: Chunk[] = [];
  #closed = false;
  readonly #alignment: number;
  readonly #limit: number;
  /** The size of a shared buffer; a larger uniform gets a buffer of its own. */
  readonly #chunkBytes: number;
  constructor(
    private readonly device: GPUDevice,
    private readonly memory: Memory,
  ) {
    this.#alignment = device.limits.minUniformBufferOffsetAlignment;
    this.#limit = device.limits.maxUniformBufferBindingSize;
    this.#chunkBytes = Math.max(
      4,
      Math.min(CHUNK_BYTES, Math.floor(memory.budget.gpuBytes / 32) * 4),
    );
  }

  begin(): FrameUniforms {
    const chunks: Chunk[] = [];
    let current: Chunk | undefined,
      released = false,
      // What views asked to upload; the alignment gaps between uniforms are not theirs.
      written = 0;
    return {
      add: (data) => {
        const size = data.byteLength;
        if (!size || size & 3 || size > this.#limit)
          throw failure('invalid-input', 'Uniforms must be whole words within the binding limit');
        let offset = current ? align(current.used, this.#alignment) : 0;
        if (!current || offset + size > current.bytes.byteLength) {
          current = this.#take(size);
          chunks.push(current);
          offset = 0;
        }
        current.bytes.set(new Uint8Array(data.buffer, data.byteOffset, size), offset);
        current.used = offset + size;
        written += size;
        return { buffer: current.buffer, offset, size };
      },
      flush: () => {
        for (const chunk of chunks) {
          this.device.queue.writeBuffer(chunk.buffer, 0, chunk.bytes, 0, align(chunk.used, 4));
          this.memory.uploads++;
        }
        this.memory.uploadedBytes += written;
      },
      release: () => {
        if (released) return;
        released = true;
        for (const chunk of chunks) {
          chunk.used = 0;
          if (
            chunk.bytes.byteLength === this.#chunkBytes &&
            !this.#closed &&
            this.#free.length < POOLED
          )
            this.#free.push(chunk);
          else this.#destroy(chunk);
        }
        chunks.length = 0;
      },
    };
  }

  /** Destroy the buffers no frame holds. */
  trim(): void {
    for (const chunk of this.#free.splice(0)) this.#destroy(chunk);
  }
  /** Stop pooling: free buffers go now, and frames still in flight destroy theirs when done. */
  destroy(): void {
    this.#closed = true;
    this.trim();
  }

  #take(size: number): Chunk {
    if (size <= this.#chunkBytes) {
      const free = this.#free.pop();
      if (free) return free;
    }
    const bytes = Math.max(this.#chunkBytes, align(size, 4));
    this.memory.reserveGpu(bytes);
    try {
      return {
        buffer: this.device.createBuffer({
          label: 'frame uniforms',
          size: bytes,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        bytes: new Uint8Array(bytes),
        used: 0,
      };
    } catch (error) {
      this.memory.releaseGpu(bytes);
      throw error;
    }
  }
  #destroy(chunk: Chunk): void {
    chunk.buffer.destroy();
    this.memory.releaseGpu(chunk.bytes.byteLength);
  }
}
