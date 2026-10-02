import { GpuError, integer } from '../error.js';
import type { Entry, Memory } from './memory.js';

export interface TextureResource {
  readonly texture: GPUTexture;
  destroy(): void;
}

/** Texture storage formats supported by the managed allocator. */
const FORMAT_BYTES: Readonly<Record<string, number>> = {
  r8unorm: 1,
  r8snorm: 1,
  r8uint: 1,
  r8sint: 1,
  r16uint: 2,
  r16sint: 2,
  r16float: 2,
  rg8unorm: 2,
  rg8snorm: 2,
  rg8uint: 2,
  rg8sint: 2,
  r32uint: 4,
  r32sint: 4,
  r32float: 4,
  rg16uint: 4,
  rg16sint: 4,
  rg16float: 4,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  rgba8snorm: 4,
  rgba8uint: 4,
  rgba8sint: 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rgb10a2uint: 4,
  rgb10a2unorm: 4,
  rg11b10ufloat: 4,
  rgb9e5ufloat: 4,
  rg32uint: 8,
  rg32sint: 8,
  rg32float: 8,
  rgba16uint: 8,
  rgba16sint: 8,
  rgba16float: 8,
  rgba32uint: 16,
  rgba32sint: 16,
  rgba32float: 16,
  stencil8: 1,
  depth16unorm: 2,
  depth24plus: 4,
  'depth24plus-stencil8': 8,
  depth32float: 4,
  'depth32float-stencil8': 8,
};

function textureBytes(descriptor: GPUTextureDescriptor): number {
  const texel = FORMAT_BYTES[descriptor.format];
  if (!texel)
    throw new GpuError(
      'unsupported',
      `Managed texture format is unsupported: ${descriptor.format}`,
    );
  const dimensions = descriptor.size as readonly number[];
  let width = dimensions[0];
  let height = dimensions[1];
  let depth = dimensions[2];
  const dimension = descriptor.dimension ?? '2d';
  const largest = dimension === '3d' ? Math.max(width, height, depth) : Math.max(width, height);
  const mips = integer(
    descriptor.mipLevelCount ?? 1,
    'mip count',
    1,
    1 + Math.floor(Math.log2(largest)),
  );
  const samples = descriptor.sampleCount ?? 1;
  if (samples !== 1 && samples !== 4)
    throw new GpuError('invalid-input', 'Texture sample count must be 1 or 4');
  if (dimension === '1d' && (height !== 1 || depth !== 1 || mips !== 1))
    throw new GpuError(
      'invalid-input',
      'One-dimensional textures require height, depth, and mip count of one',
    );
  if (samples > 1 && (dimension !== '2d' || depth !== 1 || mips !== 1))
    throw new GpuError(
      'invalid-input',
      'Multisampled textures require a single two-dimensional level and layer',
    );
  let bytes = 0;
  for (let level = 0; level < mips; level++) {
    bytes += width * height * depth * texel * samples;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    if (descriptor.dimension === '3d') depth = Math.max(1, Math.floor(depth / 2));
  }
  return integer(bytes, 'texture bytes', 1);
}

export class Textures {
  private owned = new WeakMap<TextureResource, Entry>();
  constructor(
    private readonly device: GPUDevice,
    private readonly memory: Memory,
  ) {}

  create(descriptor: GPUTextureDescriptor): TextureResource {
    const size = descriptor.size;
    const dimensions =
      Symbol.iterator in Object(size)
        ? [...(size as Iterable<number>)]
        : [
            (size as GPUExtent3DDict).width,
            (size as GPUExtent3DDict).height ?? 1,
            (size as GPUExtent3DDict).depthOrArrayLayers ?? 1,
          ];
    if (dimensions.length < 1 || dimensions.length > 3)
      throw new GpuError('invalid-input', 'Texture size must have one to three dimensions');
    const dimension = descriptor.dimension ?? '2d';
    const limits = this.device.limits;
    const maximum =
      dimension === '1d'
        ? limits.maxTextureDimension1D
        : dimension === '3d'
          ? limits.maxTextureDimension3D
          : limits.maxTextureDimension2D;
    descriptor = {
      ...descriptor,
      size: [
        integer(dimensions[0], 'texture width', 1, maximum),
        integer(dimensions[1] ?? 1, 'texture height', 1, maximum),
        integer(
          dimensions[2] ?? 1,
          'texture depth',
          1,
          dimension === '3d' ? maximum : limits.maxTextureArrayLayers,
        ),
      ],
    };
    const bytes = textureBytes(descriptor);
    this.memory.reserveGpu(bytes);
    let texture: GPUTexture;
    try {
      texture = this.device.createTexture(descriptor);
    } catch (error) {
      this.memory.releaseGpu(bytes);
      throw error;
    }
    let entry: Entry;
    try {
      entry = this.memory.add([], 128, () => {
        texture.destroy();
        this.memory.releaseGpu(bytes);
      });
    } catch (error) {
      texture.destroy();
      this.memory.releaseGpu(bytes);
      throw error;
    }
    let destroyed = false;
    const resource: TextureResource = {
      texture,
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        entry.close();
        entry.unpin();
      },
    };
    this.owned.set(resource, entry);
    return resource;
  }

  entry(resource: TextureResource): Entry {
    const entry = this.owned.get(resource);
    if (!entry) throw new GpuError('invalid-input', 'Texture belongs to another Gpu');
    return entry;
  }
}
