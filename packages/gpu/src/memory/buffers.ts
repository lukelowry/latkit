import { failure } from '@latkit/model';
import { integer } from '../error.js';
import type { Entry, Memory } from './memory.js';

/** Explicitly owned GPU working/output storage. No CPU mirror or implicit upload. */
export interface BufferResource {
  readonly buffer: GPUBuffer;
  destroy(): void;
}

export class Buffers {
  private owned = new WeakMap<BufferResource, Entry>();
  constructor(
    private readonly device: GPUDevice,
    private readonly memory: Memory,
  ) {}

  create(descriptor: GPUBufferDescriptor): BufferResource {
    const size = integer(descriptor.size, 'buffer size', 4, this.device.limits.maxBufferSize);
    if (size % 4) throw failure('invalid-input', 'Buffer size must be aligned to four bytes');
    this.memory.reserveGpu(size);
    let buffer: GPUBuffer;
    try {
      buffer = this.device.createBuffer(descriptor);
    } catch (error) {
      this.memory.releaseGpu(size);
      throw error;
    }
    let entry: Entry;
    try {
      entry = this.memory.add([], 128, () => {
        buffer.destroy();
        this.memory.releaseGpu(size);
      });
    } catch (error) {
      buffer.destroy();
      this.memory.releaseGpu(size);
      throw error;
    }
    let closed = false;
    const resource = {
      buffer,
      destroy: () => {
        if (!closed) {
          closed = true;
          entry.close();
          entry.unpin();
        }
      },
    };
    this.owned.set(resource, entry);
    return resource;
  }

  entry(resource: BufferResource): Entry {
    const entry = this.owned.get(resource);
    if (!entry) throw failure('invalid-input', 'Buffer belongs to another Gpu');
    return entry;
  }
}
