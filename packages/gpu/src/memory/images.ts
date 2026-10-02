import { GpuError } from '../error.js';
import type { Entry, Memory } from './memory.js';
import { TextureData } from './texture-data.js';
import type { UploadScope } from '../fields/upload.js';

interface Resident {
  entry: Entry;
  texture: GPUTexture;
  revision: number;
  width: number;
  height: number;
}

export class Images {
  private cached = new WeakMap<TextureData, Resident[]>();
  constructor(
    private readonly device: GPUDevice,
    private readonly memory: Memory,
  ) {}

  write(
    texture: GPUTexture,
    data: Uint8Array<ArrayBuffer>,
    region: {
      x: number;
      y: number;
      width: number;
      height: number;
      stride: number;
      offset?: number;
    },
  ): void {
    this.device.queue.writeTexture(
      { texture, origin: [region.x, region.y] },
      data,
      { offset: region.offset ?? 0, bytesPerRow: region.stride, rowsPerImage: region.height },
      [region.width, region.height],
    );
    this.memory.uploads++;
    this.memory.uploadedBytes += region.stride * region.height;
  }

  upload(data: TextureData, scope: UploadScope): GPUTexture {
    if (Math.max(data.width, data.height) > this.device.limits.maxTextureDimension2D)
      throw new GpuError('resource-limit', 'Image exceeds the device texture limit');
    const revision = data.revision;
    const residents = this.cached.get(data) ?? [];
    this.cached.set(data, residents);
    let resident = residents.find((item) => item.entry.live && item.revision === revision);
    if (resident) {
      this.memory.uploadHits++;
      scope.use(resident.entry);
    } else {
      resident = residents.find(
        (item) =>
          item.entry.live &&
          !item.entry.pins &&
          item.width === data.width &&
          item.height === data.height,
      );
      if (resident) resident.entry.pin();
      else {
        const bytes = data.bytes.byteLength;
        this.memory.reserveGpu(bytes);
        let texture: GPUTexture;
        try {
          texture = this.device.createTexture({
            label: 'shared pixels',
            format: data.format,
            size: [data.width, data.height],
            usage:
              GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
          });
        } catch (error) {
          this.memory.releaseGpu(bytes);
          throw error;
        }
        let entry: Entry;
        try {
          entry = this.memory.add(
            [],
            192,
            () => {
              texture.destroy();
              this.memory.releaseGpu(bytes);
              const index = residents.findIndex((item) => item.entry === entry);
              if (index >= 0) residents.splice(index, 1);
            },
            'gpu',
          );
        } catch (error) {
          texture.destroy();
          this.memory.releaseGpu(bytes);
          throw error;
        }
        resident = { entry, texture, revision: -1, width: data.width, height: data.height };
        residents.push(resident);
      }
      try {
        const [from, to] = data.changedRows(resident.revision);
        if (to > from) {
          const stride = data.width * data.channels;
          this.write(resident.texture, data.bytes, {
            x: 0,
            y: from,
            width: data.width,
            height: to - from,
            stride,
            offset: from * stride,
          });
        }
        resident.revision = revision;
        scope.use(resident.entry);
        resident.entry.unpin();
      } catch (error) {
        this.memory.remove(resident.entry);
        throw error;
      }
    }
    scope.check(() => {
      if (data.revision !== revision)
        throw new GpuError('conflict', 'Pixels changed during frame preparation');
    });
    return resident.texture;
  }
}
