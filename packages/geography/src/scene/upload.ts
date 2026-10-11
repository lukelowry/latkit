import type { Gpu, kit } from '@latkit/gpu';
import type { Shapes } from '../prepare/shapes.js';

/** A typed array in a storage or index buffer of its own: a buffer can never be empty, nor odd. */
function upload(
  gpu: Gpu,
  data: ArrayBufferView,
  usage: GPUBufferUsageFlags,
  label: string,
): kit.BufferResource {
  const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4),
    resource = gpu.buffer({ size, usage: usage | GPUBufferUsage.COPY_DST, label });
  if (data.byteLength)
    gpu.device.queue.writeBuffer(
      resource.buffer,
      0,
      data.buffer as ArrayBuffer,
      data.byteOffset,
      Math.floor(data.byteLength / 4) * 4,
    );
  return resource;
}
/** One level's buffers: the triangles areas draw, as an index buffer, and the strips lines draw. */
export interface LevelBuffers {
  readonly triangles: kit.BufferResource;
  readonly strips: kit.BufferResource;
  readonly along: kit.BufferResource;
}
/**
 * Shapes on the GPU: their vertices and origins at once, and each level as a view first draws it,
 * so a world never seen up close never uploads its finest detail.
 */
export class ShapesBuffers {
  readonly vertices: kit.BufferResource;
  readonly origins: kit.BufferResource;
  private readonly levels: (LevelBuffers | undefined)[] = [];
  private held: number;
  constructor(
    private readonly gpu: Gpu,
    readonly shapes: Shapes,
  ) {
    this.vertices = upload(gpu, shapes.vertices, GPUBufferUsage.STORAGE, 'geography vertices');
    try {
      this.origins = upload(gpu, shapes.origins, GPUBufferUsage.STORAGE, 'geography origins');
    } catch (error) {
      this.vertices.destroy();
      throw error;
    }
    this.held = this.vertices.buffer.size + this.origins.buffer.size;
  }
  /** GPU bytes held. */
  get bytes(): number {
    return this.held;
  }
  level(k: number): LevelBuffers {
    let found = this.levels[k];
    if (found) return found;
    const level = this.shapes.levels[k],
      made: kit.BufferResource[] = [];
    try {
      for (const [data, usage, label] of [
        [level.triangles, GPUBufferUsage.INDEX, 'geography triangles'],
        [level.strips, GPUBufferUsage.STORAGE, 'geography strips'],
        [level.along, GPUBufferUsage.STORAGE, 'geography along'],
      ] as const)
        made.push(upload(this.gpu, data, usage, label));
    } catch (error) {
      for (const buffer of made) buffer.destroy();
      throw error;
    }
    found = { triangles: made[0], strips: made[1], along: made[2] };
    this.levels[k] = found;
    this.held += made.reduce((n, buffer) => n + buffer.buffer.size, 0);
    return found;
  }
  destroy(): void {
    this.vertices.destroy();
    this.origins.destroy();
    for (const level of this.levels) {
      level?.triangles.destroy();
      level?.strips.destroy();
      level?.along.destroy();
    }
    this.levels.length = 0;
  }
}
