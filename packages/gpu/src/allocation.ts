import { align, GpuError } from './error.js';
import type { Memory } from './memory.js';

interface Span {
  offset: number;
  size: number;
}
interface Slab {
  buffer: GPUBuffer;
  usage: number;
  size: number;
  free: Span[];
  count: number;
}

export interface Allocation {
  readonly binding: GPUBufferBinding & { readonly offset: number; readonly size: number };
  release(): void;
}

/** Suballocations never move. Retired frames keep their regions out of the free list. */
export class Allocator {
  private slabs = new Set<Slab>();
  constructor(
    readonly device: GPUDevice,
    readonly memory: Memory,
  ) {}

  allocate(size: number, usage: GPUBufferUsageFlags, label: string): Allocation {
    size = align(Math.max(4, size), 4);
    const limits = this.device.limits;
    if (
      size > limits.maxBufferSize ||
      (usage & GPUBufferUsage.STORAGE && size > limits.maxStorageBufferBindingSize) ||
      (usage & GPUBufferUsage.UNIFORM && size > limits.maxUniformBufferBindingSize)
    )
      throw new GpuError('resource-limit', 'Buffer binding exceeds the device limits');
    const alignment = Math.max(
      4,
      usage & GPUBufferUsage.STORAGE ? limits.minStorageBufferOffsetAlignment : 4,
      usage & GPUBufferUsage.UNIFORM ? limits.minUniformBufferOffsetAlignment : 4,
    );
    usage |= GPUBufferUsage.COPY_DST;
    let found: { slab: Slab; index: number; start: number } | undefined;
    for (const slab of this.slabs) {
      if (slab.usage !== usage) continue;
      const index = slab.free.findIndex(
        (span) => align(span.offset, alignment) + size <= span.offset + span.size,
      );
      if (index >= 0) {
        found = { slab, index, start: align(slab.free[index].offset, alignment) };
        break;
      }
    }
    if (!found) {
      const preferred = Math.min(
        1024 ** 2,
        limits.maxBufferSize,
        Math.floor(this.memory.budget.gpuBytes / 8),
      );
      const capacity = align(Math.max(size, preferred), 4);
      this.memory.reserveGpu(capacity);
      let buffer: GPUBuffer;
      try {
        buffer = this.device.createBuffer({ label, size: capacity, usage });
      } catch (error) {
        this.memory.releaseGpu(capacity);
        throw error;
      }
      const slab = {
        buffer,
        usage,
        size: capacity,
        free: [{ offset: 0, size: capacity }],
        count: 0,
      };
      this.slabs.add(slab);
      found = { slab, index: 0, start: 0 };
    }
    const { slab, index, start } = found;
    const span = slab.free[index];
    const remaining: Span[] = [];
    if (start > span.offset) remaining.push({ offset: span.offset, size: start - span.offset });
    if (start + size < span.offset + span.size)
      remaining.push({ offset: start + size, size: span.offset + span.size - start - size });
    slab.free.splice(index, 1, ...remaining);
    slab.count++;
    let live = true;
    return {
      binding: { buffer: slab.buffer, offset: start, size },
      release: () => {
        if (!live) return;
        live = false;
        if (--slab.count === 0) {
          this.slabs.delete(slab);
          slab.buffer.destroy();
          this.memory.releaseGpu(slab.size);
          return;
        }
        slab.free.push({ offset: start, size });
        slab.free.sort((a, b) => a.offset - b.offset);
        for (let i = 1; i < slab.free.length;) {
          const before = slab.free[i - 1],
            next = slab.free[i];
          if (before.offset + before.size === next.offset) {
            before.size += next.size;
            slab.free.splice(i, 1);
          } else i++;
        }
      },
    };
  }

  write(binding: GPUBufferBinding, data: ArrayBufferView, offset = 0): void {
    const size = data.byteLength;
    if (!size) return;
    if (size & 3 || offset & 3 || offset + size > binding.size!)
      throw new GpuError(
        'invalid-input',
        'GPU writes must fit their binding and align to four bytes',
      );
    this.device.queue.writeBuffer(
      binding.buffer,
      (binding.offset ?? 0) + offset,
      data.buffer as ArrayBuffer,
      data.byteOffset,
      size,
    );
    this.memory.uploads++;
    this.memory.uploadedBytes += size;
  }
}
