import { GpuError, integer } from '../error.js';

export interface PixelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Mutable application pixels for glyph atlases, colormaps, and images. Revisions are per consumer. */
export class TextureData {
  readonly format: 'r8unorm' | 'rgba8unorm';
  readonly channels: number;
  private pixels: Uint8Array<ArrayBuffer>;
  private w: number;
  private h: number;
  private serial = 0;
  private history: { revision: number; from: number; to: number }[] = [];

  constructor(options: {
    readonly width: number;
    readonly height: number;
    readonly format?: 'r8unorm' | 'rgba8unorm';
  }) {
    this.format = options.format ?? 'rgba8unorm';
    if (this.format !== 'r8unorm' && this.format !== 'rgba8unorm')
      throw new GpuError('unsupported', 'Unsupported pixel format');
    this.channels = this.format === 'r8unorm' ? 1 : 4;
    this.w = integer(options.width, 'image width', 1);
    this.h = integer(options.height, 'image height', 1);
    this.pixels = new Uint8Array(integer(this.w * this.h * this.channels, 'image bytes', 1));
  }
  get width(): number {
    return this.w;
  }
  get height(): number {
    return this.h;
  }
  get bytes(): Uint8Array<ArrayBuffer> {
    return this.pixels;
  }
  get revision(): number {
    return this.serial;
  }

  resize(size: { readonly width: number; readonly height: number }): void {
    const width = integer(size.width, 'image width', 1),
      height = integer(size.height, 'image height', 1);
    if (width === this.w && height === this.h) return;
    const next = new Uint8Array(integer(width * height * this.channels, 'image bytes', 1));
    const stride = Math.min(width, this.w) * this.channels;
    for (let y = 0; y < Math.min(height, this.h); y++)
      next.set(
        this.pixels.subarray(y * this.w * this.channels, y * this.w * this.channels + stride),
        y * width * this.channels,
      );
    this.pixels = next;
    this.w = width;
    this.h = height;
    this.touch();
  }

  write(options: PixelRegion & { readonly data: Uint8Array; readonly bytesPerRow?: number }): void {
    this.region(options);
    const rowBytes = options.width * this.channels;
    const stride = integer(options.bytesPerRow ?? rowBytes, 'pixel row stride', rowBytes);
    if (options.height && (options.height - 1) * stride + rowBytes > options.data.byteLength)
      throw new GpuError('invalid-input', 'Pixel input does not cover its region');
    const data = options.data.buffer === this.pixels.buffer ? options.data.slice() : options.data;
    for (let row = 0; row < options.height; row++)
      this.pixels.set(
        data.subarray(row * stride, row * stride + rowBytes),
        ((options.y + row) * this.w + options.x) * this.channels,
      );
    this.touch(options);
  }

  /** Call after changing bytes directly. Uploads coalesce into whole rows. */
  touch(region: PixelRegion = { x: 0, y: 0, width: this.w, height: this.h }): void {
    this.region(region);
    this.history.push({ revision: ++this.serial, from: region.y, to: region.y + region.height });
    if (this.history.length > 64) this.history.shift();
  }
  changedRows(revision: number): readonly [from: number, to: number] {
    if (revision === this.serial) return [0, 0];
    if (revision > this.serial || revision < (this.history[0]?.revision ?? this.serial + 1) - 1)
      return [0, this.h];
    let from = this.h,
      to = 0;
    for (const item of this.history)
      if (item.revision > revision) {
        from = Math.min(from, item.from);
        to = Math.max(to, item.to);
      }
    return from < to ? [from, Math.min(this.h, to)] : [0, 0];
  }
  private region(region: PixelRegion): void {
    integer(region.x, 'pixel x', 0, this.w);
    integer(region.y, 'pixel y', 0, this.h);
    integer(region.width, 'pixel width', 0, this.w - region.x);
    integer(region.height, 'pixel height', 0, this.h - region.y);
  }
}
