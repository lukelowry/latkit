import { failure, type MemoryEntry, type Memory } from '@latkit/model';
import { BufferData } from '../memory/buffer-data.js';
import { distanceField } from './distance-field.js';
import { integer, interruptible } from '../error.js';
import type { Images } from '../memory/images.js';
import type { Textures, TextureResource } from '../memory/textures.js';
import { createTextRasterizer } from './rasterizer.js';
import type {
  TextInput,
  TextOptions,
  TextMetrics,
  TextPage,
  TextRasterizer,
  TextRequest,
  TextRun,
} from './text.js';
import type { Uploader, UploadScope } from '../fields/upload.js';

interface Atlas {
  resource: TextureResource;
  entry: MemoryEntry;
  x: number;
  y: number;
  height: number;
  keys: Set<string>;
}
interface Glyph {
  atlas: Atlas;
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  metrics: TextMetrics;
}
interface Geometry {
  atlas: Atlas;
  data: BufferData;
  count: number;
  binding?: GPUBufferBinding;
  group?: GPUBindGroup;
}
interface Resident {
  entry: MemoryEntry;
  geometry: Geometry[];
}
const em = 48,
  padding = 8;

/** Append-only atlas regions remain immutable for every in-flight frame. */
export class TextAtlas {
  readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly rasterizer: TextRasterizer;
  private readonly size: number;
  private atlases = new Set<Atlas>();
  private glyphs = new Map<string, Glyph>();
  private pending = new Map<string, Promise<Glyph>>();
  private geometry = new WeakMap<readonly TextRun[], Resident>();
  constructor(
    private readonly device: GPUDevice,
    private readonly memory: Memory,
    private readonly textures: Textures,
    private readonly images: Images,
    private readonly uploader: Uploader,
    private readonly signal: AbortSignal,
    options: TextOptions = {},
  ) {
    this.rasterizer = options.rasterizer ?? createTextRasterizer();
    this.size = integer(
      options.atlasSize ?? 1024,
      'text atlas size',
      32,
      device.limits.maxTextureDimension2D,
    );
    this.layout = device.createBindGroupLayout({
      label: 'latkit text',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  async measure(input: TextInput, signal: AbortSignal): Promise<TextMetrics> {
    const glyph = await interruptible(this.glyph(input), signal);
    return glyph.metrics;
  }

  async prepare(
    request: TextRequest,
    scope: UploadScope,
    signal: AbortSignal,
  ): Promise<readonly TextPage[]> {
    signal.throwIfAborted();
    let resident = this.geometry.get(request.runs);
    if (!resident?.entry.live) {
      const held = new Set<MemoryEntry>(),
        glyphs: Glyph[] = [];
      try {
        for (const run of request.runs) {
          if (
            !Number.isFinite(run.size) ||
            run.size <= 0 ||
            run.position.length !== 2 ||
            !run.position.every(Number.isFinite) ||
            (run.color &&
              (run.color.length !== 4 ||
                !run.color.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)))
          )
            throw failure('invalid-input', 'Invalid text size, position, or color');
          integer(run.anchor ?? 0, 'text anchor', 0, 0xffffffff);
          let glyph = await interruptible(this.glyph(run), signal);
          // The promise continuation can interleave with another allocation that evicts a page.
          if (!glyph.atlas.entry.live) glyph = await interruptible(this.glyph(run), signal);
          if (!glyph.atlas.entry.live)
            throw failure('resource-limit', 'Atlas was evicted during text preparation');
          if (!held.has(glyph.atlas.entry)) {
            glyph.atlas.entry.pin();
            held.add(glyph.atlas.entry);
          }
          glyphs.push(glyph);
        }
        // Another view may have completed this same immutable run list while shaping was pending.
        if (this.geometry.get(request.runs)?.entry.live) {
          for (const entry of held) entry.unpin();
          held.clear();
          return this.prepare(request, scope, signal);
        }
        const geometry: Geometry[] = [];
        const maximum = Math.floor(
          Math.min(this.uploader.pageBytes, this.device.limits.maxStorageBufferBindingSize) / 64,
        );
        if (request.runs.length && !maximum)
          throw failure('resource-limit', 'Text instance exceeds the page limit');
        // Keep painter order, including when successive runs use different atlas pages.
        for (let start = 0; start < request.runs.length;) {
          const atlas = glyphs[start].atlas;
          let end = start + 1;
          while (end < request.runs.length && end - start < maximum && glyphs[end].atlas === atlas)
            end++;
          const count = end - start,
            data = new BufferData({ size: count * 64, label: 'text instances' });
          const f = new Float32Array(data.bytes.buffer),
            u = new Uint32Array(data.bytes.buffer);
          for (let i = start; i < end; i++) {
            const run = request.runs[i],
              glyph = glyphs[i],
              at = (i - start) * 16;
            f.set(
              [
                run.position[0] + glyph.left * run.size,
                run.position[1] + glyph.top * run.size,
                (glyph.width / em) * run.size,
                (glyph.height / em) * run.size,
                glyph.x / this.size,
                glyph.y / this.size,
                (glyph.x + glyph.width) / this.size,
                (glyph.y + glyph.height) / this.size,
                ...(run.color ?? [1, 1, 1, 1]),
              ],
              at,
            );
            u[at + 12] = run.anchor ?? 0;
          }
          data.touch();
          geometry.push({ atlas, data, count });
          start = end;
        }
        const entry = this.memory.add(
          geometry.map((item) => item.data.bytes.buffer),
          256 + geometry.length * 128 + request.runs.length * 8,
          () => {
            this.geometry.delete(request.runs);
            for (const item of held) item.unpin();
          },
          'gpu',
        );
        resident = { entry, geometry };
        this.geometry.set(request.runs, resident);
        entry.unpin();
      } catch (error) {
        for (const entry of held) entry.unpin();
        throw error;
      }
    }
    scope.use(resident.entry);
    const pages: TextPage[] = [];
    for (const item of resident.geometry) {
      const binding = this.uploader.buffer(item.data, scope);
      if (
        !item.group ||
        item.binding?.buffer !== binding.buffer ||
        item.binding.offset !== binding.offset ||
        item.binding.size !== binding.size
      ) {
        item.group = this.device.createBindGroup({
          layout: this.layout,
          entries: [
            { binding: 0, resource: binding },
            { binding: 1, resource: item.atlas.resource.texture.createView() },
            { binding: 2, resource: this.sampler },
          ],
        });
        item.binding = binding;
      }
      pages.push({ bindGroup: item.group, count: item.count });
    }
    return pages;
  }

  private glyph(input: TextInput): Promise<Glyph> {
    this.signal.throwIfAborted();
    const key = JSON.stringify([
      input.text,
      input.font?.family ?? 'sans-serif',
      input.font?.weight ?? 400,
      input.font?.style ?? 'normal',
      input.font?.revision ?? '',
      input.direction ?? 'ltr',
    ]);
    const cached = this.glyphs.get(key);
    if (cached?.atlas.entry.live) {
      cached.atlas.entry.touch();
      return Promise.resolve(cached);
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.rasterize(input, key).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }

  private async rasterize(input: TextInput, key: string): Promise<Glyph> {
    if (input.text.length > 4096)
      throw failure('resource-limit', 'Text run exceeds its length bound');
    const maxWidth = this.size - padding * 2;
    const maxHeight = Math.min(
      maxWidth,
      Math.floor(this.memory.budget.stagingBytes / (maxWidth * 32)) - padding * 2,
    );
    if (maxHeight < 1)
      throw failure('resource-limit', 'Text rasterization exceeds the staging budget');
    const bitmap = await this.memory.stageAsync(maxWidth * maxHeight * 5, () =>
      this.rasterizer.rasterize(input, {
        pixelsPerEm: em,
        maxWidth,
        maxHeight,
        signal: this.signal,
      }),
    );
    this.signal.throwIfAborted();
    integer(bitmap.width, 'text bitmap width', 1, maxWidth);
    integer(bitmap.height, 'text bitmap height', 1, maxHeight);
    if (
      !(bitmap.coverage instanceof Uint8Array) ||
      bitmap.coverage.length !== bitmap.width * bitmap.height ||
      ![bitmap.left, bitmap.top, bitmap.advance, bitmap.ascent, bitmap.descent].every(
        Number.isFinite,
      )
    )
      throw failure('invalid-input', 'Invalid text rasterization result');
    const width = bitmap.width + padding * 2,
      height = bitmap.height + padding * 2;
    const sdf = this.memory.stage(width * height * 17 + Math.max(width, height) * 28 + 8, () =>
      distanceField(bitmap.coverage, bitmap.width, bitmap.height, padding),
    );
    let atlas = [...this.atlases].find(
      (item) =>
        item.entry.live &&
        (item.x + width <= this.size
          ? item.y + Math.max(item.height, height) <= this.size
          : item.y + item.height + height <= this.size),
    );
    if (!atlas) atlas = this.create();
    atlas.entry.pin();
    try {
      if (atlas.x + width > this.size) {
        atlas.y += atlas.height;
        atlas.x = 0;
        atlas.height = 0;
      }
      const x = atlas.x,
        y = atlas.y;
      this.images.write(atlas.resource.texture, sdf, { x, y, width, height, stride: width });
      atlas.x += width;
      atlas.height = Math.max(atlas.height, height);
      const { advance, ascent, descent } = bitmap;
      const glyph = {
        atlas,
        x,
        y,
        width,
        height,
        left: bitmap.left - padding / em,
        top: bitmap.top - padding / em,
        metrics: { advance, ascent, descent },
      };
      // Atlas metadata is charged separately, so a page full of tiny strings is bounded too.
      const metadata = this.memory.add([], 128 + key.length * 2, () => {
        if (this.glyphs.get(key) === glyph) this.glyphs.delete(key);
        atlas!.keys.delete(key);
      });
      metadata.unpin();
      atlas.keys.add(key);
      this.glyphs.set(key, glyph);
      return glyph;
    } finally {
      atlas.entry.unpin();
    }
  }

  private create(): Atlas {
    const resource = this.textures.create({
      label: 'shared text atlas',
      size: [this.size, this.size],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    let atlas: Atlas;
    try {
      const entry = this.memory.add(
        [],
        256,
        () => {
          resource.destroy();
          this.atlases.delete(atlas);
          for (const key of atlas.keys) this.glyphs.delete(key);
        },
        'gpu',
      );
      atlas = { resource, entry, x: 0, y: 0, height: 0, keys: new Set() };
      this.atlases.add(atlas);
      entry.unpin();
      return atlas;
    } catch (error) {
      resource.destroy();
      throw error;
    }
  }
}
