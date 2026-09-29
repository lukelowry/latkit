import {
  GlyphAtlas,
  createGlyphTexture,
  glyphMetrics,
  glyphShader,
  type GlyphSnapshot,
  type GlyphTexture,
  type RenderTarget,
} from '@latkit/gpu';
import type { Domain } from '@latkit/model';
import type { RGBA } from '@latkit/colormaps';
import type { ResolvedOptions } from './options.js';
import { ticks, formatTick, tickOffset } from './ticks.js';
import { position } from './position.js';
import source from './gpu/axes.wgsl?raw';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const NUMERIC = '0123456789+-eE. ';
const WORDS = 12;

/** Cached screen-space geometry. Font rasterization and layout never run on playhead frames. */
export class Axes {
  readonly atlas: GlyphAtlas;
  readonly #target: RenderTarget;
  readonly #texture: GlyphTexture;
  readonly #pipeline: GPURenderPipeline;
  readonly #uniform: GPUBuffer;
  readonly #sampler: GPUSampler;
  #blank: GPUTexture | null = null;
  #buffer: GPUBuffer | null = null;
  #capacity = 0;
  #group: GPUBindGroup | null = null;
  #grid = 0;
  #labels = 0;
  #settings: ResolvedOptions;
  #scale: number;
  #dirty = true;
  #layoutWidth = 0;
  #layoutHeight = 0;
  #layoutValue: Domain = [0, 1];
  /** The widest value label laid out since the last reset: the gutter only grows while a series streams. */
  #columns = 0;
  #time: Domain | null = null;
  #value: Domain | null = null;
  #rect: Rect;
  readonly #cursor = new Float32Array(WORDS);

  constructor(
    target: RenderTarget,
    options: ResolvedOptions,
    scale: number,
    glyphs?: GlyphSnapshot,
  ) {
    this.#target = target;
    this.#settings = options;
    this.#scale = scale;
    this.atlas = glyphs ? GlyphAtlas.from(glyphs) : new GlyphAtlas(options.fontFamily);
    this.#texture = createGlyphTexture(target.device, 'monitor-glyphs');
    const module = target.device.createShaderModule({
      label: 'monitor-axes',
      code: glyphShader + source,
    });
    this.#pipeline = target.device.createRenderPipeline({
      label: 'monitor-axes',
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: {
        module,
        entryPoint: 'fragment',
        targets: [
          {
            format: target.format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    this.#uniform = target.device.createBuffer({
      label: 'monitor-axes-uniform',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#sampler = target.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.#rect = this.#layout();
  }
  get rect(): Rect {
    return this.#rect;
  }
  configure(
    options: ResolvedOptions,
    scale: number,
    value: Domain = this.#layoutValue,
    reset = false,
  ): boolean {
    if (
      !reset &&
      options === this.#settings &&
      scale === this.#scale &&
      this.#layoutWidth === this.#target.width &&
      this.#layoutHeight === this.#target.height &&
      this.#layoutValue[0] === value[0] &&
      this.#layoutValue[1] === value[1]
    )
      return false;
    if (options.fontFamily !== this.#settings.fontFamily) this.atlas.setFont(options.fontFamily);
    this.#dirty = true;
    this.#settings = options;
    this.#scale = scale;
    this.#layoutValue = value;
    if (reset) this.#columns = 0;
    const next = this.#layout(),
      previous = this.#rect;
    this.#rect = next;
    return next.width !== previous.width || next.height !== previous.height;
  }
  refreshFont(): void {
    this.atlas.setFont(this.#settings.fontFamily);
    this.#dirty = true;
  }
  #layout(): Rect {
    const { width, height } = this.#target,
      o = this.#settings,
      s = this.#scale,
      font = o.fontSizePx * s;
    this.#layoutWidth = width;
    this.#layoutHeight = height;
    const top = o.valueAxis === null ? 0 : Math.ceil(font * 1.8);
    const bottom = o.timeAxis === null ? 0 : Math.ceil(font * 3.4 + 4 * s);
    // Measure the labels that are actually drawn. This runs only when the domain,
    // font, options or canvas size changes, never for playhead-only frames.
    let columns = this.#columns;
    if (o.valueAxis) {
      const value = this.#layoutValue;
      const offset = tickOffset(value, o.valueAxis);
      const domain: Domain = [value[0] - offset, value[1] - offset];
      const axis = { ...o.valueAxis, minSpacingPx: o.valueAxis.minSpacingPx ?? o.fontSizePx * 2.5 };
      for (const tick of ticks(value, Math.max(1, height - top - bottom) / s, axis))
        columns = Math.max(
          columns,
          glyphMetrics.columns(tick.label ?? formatTick(tick.value - offset, domain, axis)),
        );
    }
    this.#columns = columns;
    const left =
      o.valueAxis === null
        ? 0
        : Math.min(Math.ceil(width / 3), Math.ceil(font * glyphMetrics.advance * columns + 10 * s));
    const x = Math.min(left, Math.max(0, width - 1)),
      y = Math.min(top, Math.max(0, height - 1));
    return { x, y, width: Math.max(1, width - x), height: Math.max(1, height - y - bottom) };
  }
  /** Prewarm every user label plus all numeric glyphs, including ticks at another export size. */
  snapshot(): GlyphSnapshot {
    return snapshotGlyphs(this.#settings, this.atlas);
  }
  update(time: Domain, value: Domain): void {
    const { width, height, device } = this.#target;
    this.configure(this.#settings, this.#scale);
    if (
      !this.#dirty &&
      this.#time?.[0] === time[0] &&
      this.#time[1] === time[1] &&
      this.#value?.[0] === value[0] &&
      this.#value[1] === value[1]
    )
      return;
    const r = this.#rect,
      o = this.#settings,
      s = this.#scale,
      font = o.fontSizePx * s;
    const grid: number[] = [],
      labels: number[] = [];
    const quad = (
      into: number[],
      x: number,
      y: number,
      w: number,
      h: number,
      color: RGBA,
      uv: readonly number[] = [0, 0, -1, -1],
    ) => into.push(x, y, w, h, ...uv, ...color);
    const text = (label: string, x: number, cy: number, align: number, available: number) => {
      const parts = [...segmenter.segment(label)].map((p) => p.segment);
      const columns = parts.reduce(
        (n, part) => n + (glyphMetrics.isWide(part.codePointAt(0)!) ? 2 : 1),
        0,
      );
      const extent = columns * glyphMetrics.advance * font;
      if (extent > available || cy - font * 0.625 < 0 || cy + font * 0.625 > height) return;
      let at = x - extent * align;
      const scale = font / this.atlas.fontPx;
      for (const part of parts) {
        const cell = this.atlas.cell(part),
          index = cell & ~glyphMetrics.wideBit;
        const span = glyphMetrics.isWide(part.codePointAt(0)!) ? 2 : 1;
        if (index)
          quad(
            labels,
            at - this.atlas.sdfPx * scale,
            cy - (this.atlas.cellHeight * scale) / 2,
            this.atlas.cellWidth * span * scale,
            this.atlas.cellHeight * scale,
            o.textColor,
            [
              (index % this.atlas.cols) * this.atlas.cellWidth,
              Math.floor(index / this.atlas.cols) * this.atlas.cellHeight,
              this.atlas.cellWidth * span,
              this.atlas.cellHeight,
            ],
          );
        at += span * glyphMetrics.advance * font;
      }
    };
    const caption = (label: string | undefined, offset: number) =>
      [label, offset ? `${offset > 0 ? '+' : ''}${offset}` : ''].filter(Boolean).join('  ');
    if (o.timeAxis) {
      const offset = tickOffset(time, o.timeAxis);
      const domain: Domain = [time[0] - offset, time[1] - offset];
      let end = -Infinity,
        previous = '';
      const list = ticks(time, r.width / s, o.timeAxis);
      for (const tick of list) {
        const x = r.x + position(tick.value, time) * r.width;
        if (o.timeAxis.grid !== false)
          quad(grid, Math.min(width - s, Math.round(x)), r.y, s, r.height, o.gridColor);
        quad(grid, Math.min(width - s, Math.round(x)), r.y + r.height, s, 4 * s, o.axisColor);
        const label = tick.label ?? formatTick(tick.value - offset, domain, o.timeAxis);
        if (label === previous) continue;
        previous = label;
        const extent = glyphMetrics.columns(label) * glyphMetrics.advance * font;
        const center = Math.max(r.x + extent / 2, Math.min(width - extent / 2, x));
        if (center - extent / 2 < end + 6 * s) continue;
        text(label, center, r.y + r.height + 5 * s + font * 0.625, 0.5, r.width);
        end = center + extent / 2;
      }
      quad(grid, r.x, Math.min(height - s, r.y + r.height), r.width, s, o.axisColor);
      const title = caption(o.timeAxis.label, offset);
      if (title) text(title, r.x + r.width / 2, height - font * 0.75, 0.5, r.width);
    }
    if (o.valueAxis) {
      const offset = tickOffset(value, o.valueAxis);
      const domain: Domain = [value[0] - offset, value[1] - offset];
      let last = Infinity,
        previous = '';
      for (const tick of ticks(value, r.height / s, {
        ...o.valueAxis,
        minSpacingPx: o.valueAxis.minSpacingPx ?? (font / s) * 2.5,
      })) {
        const y = r.y + (1 - position(tick.value, value)) * r.height;
        if (o.valueAxis.grid !== false)
          quad(
            grid,
            r.x,
            Math.max(r.y, Math.min(r.y + r.height - s, Math.round(y))),
            r.width,
            s,
            o.gridColor,
          );
        quad(
          grid,
          Math.max(0, r.x - 4 * s),
          Math.min(height - s, Math.round(y)),
          4 * s,
          s,
          o.axisColor,
        );
        const cy = Math.max(r.y + font * 0.65, Math.min(r.y + r.height - font * 0.65, y));
        if (last - cy < font * 1.5) continue;
        const label = tick.label ?? formatTick(tick.value - offset, domain, o.valueAxis);
        if (label === previous) continue;
        previous = label;
        text(label, r.x - 7 * s, cy, 1, Math.max(0, r.x - 10 * s));
        last = cy;
      }
      quad(grid, r.x, r.y, s, r.height, o.axisColor);
      const title = caption(o.valueAxis.label, offset);
      if (title) text(title, r.x, font * 0.8, 0, width - r.x);
    }
    this.#grid = grid.length / WORDS;
    this.#labels = labels.length / WORDS;
    const data = new Float32Array([...grid, ...labels, ...this.#cursor]);
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    if (data.byteLength > limit)
      throw new RangeError('Monitor axis geometry exceeds device limits');
    if (!this.#buffer || data.byteLength > this.#capacity) {
      this.#buffer?.destroy();
      this.#capacity = Math.min(limit, Math.max(1024, 2 ** Math.ceil(Math.log2(data.byteLength))));
      this.#buffer = device.createBuffer({
        label: 'monitor-axes-quads',
        size: this.#capacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#group = null;
    }
    device.queue.writeBuffer(this.#buffer, 0, data);
    let view: GPUTextureView;
    if (this.#labels > 0) {
      if (this.#texture.sync(this.atlas) || this.#blank) this.#group = null;
      this.#blank?.destroy();
      this.#blank = null;
      view = this.#texture.view;
    } else {
      if (!this.#blank) {
        this.#blank = device.createTexture({
          label: 'monitor-blank-glyph',
          size: [1, 1],
          format: 'r8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING,
        });
        this.#group = null;
      }
      view = this.#blank.createView();
    }
    device.queue.writeBuffer(
      this.#uniform,
      0,
      new Float32Array([width, height, this.atlas.width, this.atlas.height]),
    );
    this.#dirty = false;
    this.#time = time;
    this.#value = value;
    this.#group ??= device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: { buffer: this.#buffer } },
        { binding: 2, resource: view },
        { binding: 3, resource: this.#sampler },
      ],
    });
  }
  grid(pass: GPURenderPassEncoder): void {
    this.#draw(pass, this.#grid, 0);
  }
  labels(pass: GPURenderPassEncoder): void {
    this.#draw(pass, this.#labels, this.#grid);
  }
  cursor(pass: GPURenderPassEncoder, time: number | null, range: Domain): void {
    if (time === null || !this.#buffer) return;
    const fraction = position(time, range);
    if (fraction < 0 || fraction > 1) return;
    const r = this.#rect,
      data = this.#cursor;
    data.set([
      Math.min(r.x + r.width - this.#scale, r.x + fraction * r.width),
      r.y,
      this.#scale,
      r.height,
      0,
      0,
      -1,
      -1,
    ]);
    data.set(this.#settings.cursorColor, 8);
    this.#target.device.queue.writeBuffer(
      this.#buffer,
      (this.#grid + this.#labels) * WORDS * 4,
      data,
    );
    this.#draw(pass, 1, this.#grid + this.#labels);
  }
  #draw(pass: GPURenderPassEncoder, count: number, first: number): void {
    if (!count || !this.#group) return;
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#group);
    pass.draw(4, count, 0, first);
  }
  destroy(): void {
    this.#buffer?.destroy();
    this.#uniform.destroy();
    this.#texture.destroy();
    this.#blank?.destroy();
  }
}

/** Capture a complete label alphabet even before a monitor has attached. */
export function snapshotGlyphs(
  options: ResolvedOptions,
  atlas = new GlyphAtlas(options.fontFamily),
): GlyphSnapshot {
  for (const glyph of NUMERIC) atlas.cell(glyph);
  for (const axis of [options.timeAxis, options.valueAxis]) {
    for (const text of [axis?.label ?? '', ...(axis?.ticks?.map((t) => t.label ?? '') ?? [])])
      for (const { segment } of segmenter.segment(text)) atlas.cell(segment);
  }
  return atlas.snapshot();
}
