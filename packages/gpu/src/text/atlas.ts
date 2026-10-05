import { interruptible, failure, type MemoryEntry, type Memory } from '@latkit/model';
import { BufferData } from '../memory/buffer-data.js';
import { distanceField } from './distance-field.js';
import { integer } from '../error.js';
import type { Images } from '../memory/images.js';
import type { Textures, TextureResource } from '../memory/textures.js';
import { createTextRasterizer } from './rasterizer.js';
import type {
  TextFont,
  TextInput,
  TextLayout,
  TextLayoutInput,
  TextOptions,
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
  /** Each glyph drawn on the page, with the font map that holds it. */
  glyphs: Set<{ readonly font: Map<string, Glyph>; readonly part: string }>;
}
/** One grapheme of one font: its atlas region, if it has ink, and its metrics in em units. */
interface Glyph {
  atlas?: Atlas;
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
  ascent: number;
  descent: number;
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
  padding = 8,
  ellipsis = '…';
/** Whether a string holds only characters that are each their own grapheme. */
const simple = /^[ -~\u00a0-\u02ff]*$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function clusters(text: string): string[] {
  return simple.test(text) ? [...text] : Array.from(segmenter.segment(text), (s) => s.segment);
}
/** Font keys by font object: a view's runs share their style's font. */
const fontKeys = new WeakMap<TextFont, string>();
function fontKey(font: TextFont | undefined): string {
  if (!font) return 'sans-serif\u0000400\u0000normal\u0000';
  let key = fontKeys.get(font);
  if (key === undefined) {
    key = [font.family, font.weight ?? 400, font.style ?? 'normal', font.revision ?? ''].join(
      '\u0000',
    );
    fontKeys.set(font, key);
  }
  return key;
}
/** Layouts kept for text laid out again, such as axis ticks and port names. */
const LAYOUTS = 8192;

/** One SDF per grapheme and font, shared by every string; atlas regions stay immutable in flight. */
export class TextAtlas {
  readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly rasterizer: TextRasterizer;
  private readonly size: number;
  private atlases = new Set<Atlas>();
  /** Glyphs by font, then grapheme. */
  private fonts = new Map<string, Map<string, Glyph>>();
  private pending = new Map<string, Promise<Glyph>>();
  private layouts = new Map<string, TextLayout>();
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

  /** Lines of text in the units of `size`: broken to `maxWidth` as `overflow` says, each a run. */
  async layoutText(input: TextLayoutInput, signal: AbortSignal): Promise<TextLayout> {
    if (!Number.isFinite(input.size) || input.size <= 0)
      throw failure('invalid-input', 'Invalid text size');
    const key = [
      fontKey(input.font),
      input.size,
      input.maxWidth ?? '',
      input.overflow ?? '',
      input.direction ?? '',
      input.color?.join() ?? '',
      input.text,
    ].join('\u0000');
    const cached = this.layouts.get(key);
    if (cached) return cached;
    const layout = await this.lay(input, signal);
    if (this.layouts.size >= LAYOUTS) this.layouts.clear();
    this.layouts.set(key, layout);
    return layout;
  }
  private async lay(input: TextLayoutInput, signal: AbortSignal): Promise<TextLayout> {
    const size = input.size;
    const max = input.maxWidth ?? Infinity,
      lines: { text: string; width: number }[] = [];
    let ascent = 0,
      descent = 0;
    const measured = async (text: string) => {
      const parts = clusters(text),
        glyphs = await this.resolve(parts, input.font, signal);
      for (const glyph of glyphs) {
        ascent = Math.max(ascent, glyph.ascent);
        descent = Math.max(descent, glyph.descent);
      }
      return { parts, advances: glyphs.map((glyph) => glyph.advance * size) };
    };
    const dots = max < Infinity ? (await measured(ellipsis)).advances[0] : 0;
    for (const line of input.text.split(/\r?\n/)) {
      const { parts, advances } = await measured(line),
        width = advances.reduce((sum, advance) => sum + advance, 0);
      if (width <= max) lines.push({ text: line, width });
      else if (input.overflow === 'wrap') lines.push(...wrap(parts, advances, max));
      else {
        let fit = 0,
          used = 0;
        while (fit < parts.length && used + advances[fit] + dots <= max) used += advances[fit++];
        lines.push({ text: parts.slice(0, fit).join('') + ellipsis, width: used + dots });
      }
    }
    const lineHeight = Math.max(1, ascent + descent) * size * 1.2,
      runs = (input.text ? lines : []).map((line, i): TextRun => ({
        text: line.text,
        font: input.font,
        direction: input.direction,
        size,
        color: input.color,
        position: [0, i * lineHeight + ascent * size],
      }));
    return {
      runs,
      width: lines.reduce((m, line) => Math.max(m, line.width), 0),
      height: input.text ? lines.length * lineHeight : 0,
      ascent: ascent * size,
      descent: descent * size,
    };
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
        shaped: { run: TextRun; glyphs: readonly Glyph[] }[] = [];
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
          shaped.push({ run, glyphs: await this.resolve(clusters(run.text), run.font, signal) });
        }
        // The promise continuations can interleave with an allocation that evicts a page.
        for (const { glyphs } of shaped)
          for (const glyph of glyphs)
            if (glyph.atlas && !glyph.atlas.entry.live)
              throw failure('resource-limit', 'Atlas was evicted during text preparation');
        for (const { glyphs } of shaped)
          for (const glyph of glyphs)
            if (glyph.atlas && !held.has(glyph.atlas.entry)) {
              glyph.atlas.entry.pin();
              held.add(glyph.atlas.entry);
            }
        // Another view may have completed this same immutable run list while shaping was pending.
        if (this.geometry.get(request.runs)?.entry.live) {
          for (const entry of held) entry.unpin();
          held.clear();
          return this.prepare(request, scope, signal);
        }
        const geometry = this.instances(shaped);
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

  /** One instance per inked glyph, in run order, a geometry per run of glyphs on one page. */
  private instances(shaped: readonly { run: TextRun; glyphs: readonly Glyph[] }[]): Geometry[] {
    const maximum = Math.floor(
        Math.min(this.uploader.pageBytes, this.device.limits.maxStorageBufferBindingSize) / 64,
      ),
      geometry: Geometry[] = [];
    if (!maximum) throw failure('resource-limit', 'Text instance exceeds the page limit');
    let f = new Float32Array(0),
      u = new Uint32Array(0),
      count = 0,
      atlas: Atlas | undefined;
    const flush = () => {
      if (!atlas || !count) return;
      const data = new BufferData({ size: count * 64, label: 'text instances' });
      data.bytes.set(new Uint8Array(f.buffer, 0, count * 64));
      data.touch();
      geometry.push({ atlas, data, count });
      count = 0;
    };
    for (const { run, glyphs } of shaped) {
      const { size } = run,
        [x, y] = run.position,
        color = run.color ?? [1, 1, 1, 1],
        order = run.direction === 'rtl' ? [...glyphs].reverse() : glyphs;
      let pen = 0;
      for (const glyph of order) {
        if (glyph.atlas) {
          if (glyph.atlas !== atlas || count === maximum) {
            flush();
            atlas = glyph.atlas;
          }
          if ((count + 1) * 16 > f.length) {
            const next = new Float32Array(Math.min(maximum, Math.max(64, count * 2)) * 16);
            next.set(f.subarray(0, count * 16));
            f = next;
            u = new Uint32Array(f.buffer);
          }
          const at = count++ * 16;
          f[at] = x + pen + glyph.left * size;
          f[at + 1] = y + glyph.top * size;
          f[at + 2] = (glyph.width / em) * size;
          f[at + 3] = (glyph.height / em) * size;
          f[at + 4] = glyph.x / this.size;
          f[at + 5] = glyph.y / this.size;
          f[at + 6] = (glyph.x + glyph.width) / this.size;
          f[at + 7] = (glyph.y + glyph.height) / this.size;
          f.set(color, at + 8);
          u[at + 12] = run.anchor ?? 0;
        }
        pen += glyph.advance * size;
      }
    }
    flush();
    return geometry;
  }

  /** The glyphs of these graphemes in one font, rasterizing only those never drawn. */
  private resolve(
    parts: readonly string[],
    font: TextFont | undefined,
    signal: AbortSignal,
  ): Promise<readonly Glyph[]> | readonly Glyph[] {
    this.signal.throwIfAborted();
    const family = fontKey(font),
      glyphs = new Array<Glyph>(parts.length);
    let known = this.fonts.get(family),
      missing: Promise<void>[] | undefined;
    if (!known) this.fonts.set(family, (known = new Map<string, Glyph>()));
    for (let i = 0; i < parts.length; i++) {
      const cached = known.get(parts[i]);
      if (cached && (!cached.atlas || cached.atlas.entry.live)) {
        cached.atlas?.entry.touch();
        glyphs[i] = cached;
        continue;
      }
      const key = family + '\u0000' + parts[i];
      let pending = this.pending.get(key);
      if (!pending) {
        pending = this.rasterize({ text: parts[i], font }, known, parts[i]).finally(() =>
          this.pending.delete(key),
        );
        this.pending.set(key, pending);
      }
      (missing ??= []).push(
        pending.then((glyph) => {
          glyphs[i] = glyph;
        }),
      );
    }
    return missing ? interruptible(Promise.all(missing), signal).then(() => glyphs) : glyphs;
  }

  private async rasterize(
    input: TextInput,
    font: Map<string, Glyph>,
    part: string,
  ): Promise<Glyph> {
    const maxWidth = Math.min(this.size - padding * 2, em * 8),
      maxHeight = Math.min(this.size - padding * 2, em * 4);
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
    const { advance, ascent, descent } = bitmap,
      glyph: Glyph = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, advance, ascent, descent },
      owned = { font, part };
    if (bitmap.coverage.some((value) => value > 0)) {
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
        this.images.write(atlas.resource.texture, sdf, {
          x: atlas.x,
          y: atlas.y,
          width,
          height,
          stride: width,
        });
        Object.assign(glyph, {
          atlas,
          x: atlas.x,
          y: atlas.y,
          width,
          height,
          left: bitmap.left - padding / em,
          top: bitmap.top - padding / em,
        });
        atlas.x += width;
        atlas.height = Math.max(atlas.height, height);
        atlas.glyphs.add(owned);
      } finally {
        atlas.entry.unpin();
      }
    }
    // Glyph metadata is charged separately, so a page full of small glyphs is bounded too.
    const metadata = this.memory.add([], 128 + part.length * 2, () => {
      if (font.get(part) === glyph) font.delete(part);
      glyph.atlas?.glyphs.delete(owned);
    });
    metadata.unpin();
    font.set(part, glyph);
    return glyph;
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
          for (const { font, part } of atlas.glyphs) font.delete(part);
        },
        'gpu',
      );
      atlas = { resource, entry, x: 0, y: 0, height: 0, glyphs: new Set() };
      this.atlases.add(atlas);
      entry.unpin();
      return atlas;
    } catch (error) {
      resource.destroy();
      throw error;
    }
  }
}

/** Break at spaces where a line would pass `max`, and inside a word only when it alone does. */
function wrap(
  parts: readonly string[],
  advances: readonly number[],
  max: number,
): { text: string; width: number }[] {
  const lines: { text: string; width: number }[] = [];
  let start = 0,
    width = 0,
    space = -1,
    before = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === ' ') {
      space = i;
      before = width;
    }
    if (width + advances[i] > max && i > start) {
      const end = space > start ? space : i;
      lines.push({ text: parts.slice(start, end).join(''), width: space > start ? before : width });
      start = space > start ? space + 1 : i;
      width = 0;
      for (let j = start; j < i; j++) width += advances[j];
      space = -1;
    }
    width += advances[i];
  }
  lines.push({ text: parts.slice(start).join(''), width });
  return lines;
}
