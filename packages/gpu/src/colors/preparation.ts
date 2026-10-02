import { BufferData } from '../buffers.js';
import type { Images } from '../images.js';
import type { Entry, Memory } from '../memory.js';
import type { UploadScope, Uploader } from '../uploads.js';
import type { RGBA } from './color.js';
import type { Colormap } from './colormap.js';
import { colormapPixels } from './sampling.js';
import { namedColormap, type ColormapName } from './catalog.js';

const grayscale: Colormap = Object.freeze({
  kind: 'sequential',
  colors: Object.freeze([Object.freeze([0, 0, 0, 1]) as RGBA, Object.freeze([1, 1, 1, 1]) as RGBA]),
});
interface Prepared {
  readonly entry: Entry;
  readonly parameters: BufferData;
  binding?: { texture: GPUTexture; buffer: GPUBuffer; offset: number; group: GPUBindGroup };
}
/** Uses the same image cache, buffer allocator, budgets and submission pins as all other GPU data. */
export class Colormaps {
  readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly cached = new WeakMap<Colormap, Prepared>();
  constructor(
    private readonly device: GPUDevice,
    private readonly memory: Memory,
    private readonly images: Images,
    private readonly uploader: Uploader,
  ) {
    const visibility = GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'colormap',
      entries: [
        { binding: 0, visibility, texture: { sampleType: 'float' } },
        { binding: 1, visibility, sampler: { type: 'filtering' } },
        { binding: 2, visibility, buffer: { type: 'uniform' } },
      ],
    });
    this.sampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
    });
  }
  prepare(value: Colormap | ColormapName = grayscale, scope: UploadScope): GPUBindGroup {
    const map = namedColormap(value);
    const pixels = colormapPixels(map);
    let cached = this.cached.get(map);
    if (!cached?.entry.live) {
      const parameters = new BufferData({
        size: 16,
        usage: GPUBufferUsage.UNIFORM,
        label: 'colormap mode',
      });
      parameters.write({
        data: Uint32Array.of(
          map.kind === 'cyclic' ? 1 : map.kind === 'categorical' ? 2 : 0,
          map.colors.length,
          0,
          0,
        ),
      });
      const entry = this.memory.add([pixels.bytes.buffer, parameters.bytes.buffer], 256, () =>
        this.cached.delete(map),
      );
      cached = { entry, parameters };
      this.cached.set(map, cached);
      scope.use(entry);
      entry.unpin();
    } else scope.use(cached.entry);
    const texture = this.images.upload(pixels, scope),
      buffer = this.uploader.buffer(cached.parameters, scope);
    const offset = buffer.offset ?? 0,
      binding = cached.binding;
    if (
      binding?.texture === texture &&
      binding.buffer === buffer.buffer &&
      binding.offset === offset
    )
      return binding.group;
    const group = this.device.createBindGroup({
      label: 'colormap',
      layout: this.layout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: buffer },
      ],
    });
    cached.binding = { texture, buffer: buffer.buffer, offset, group };
    return group;
  }
}
