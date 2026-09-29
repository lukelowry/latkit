import type { GlyphSnapshot, RenderTarget } from '@latkit/gpu';
import { normalizeDomain, type Domain, type Series } from '@latkit/model';
import { Lane, type LaneEvents, type Scan, type Style } from './lane.js';
import { LanePainter } from './painter.js';
import { Axes } from './axes.js';
import { SHADE_HOST_WORDS } from './shade.js';
import type { ResolvedOptions } from './options.js';

/** One plot assembly for a live canvas and a deterministic offscreen scene. */
export class Plot {
  readonly #painter: LanePainter;
  readonly axes: Axes;
  readonly #target: RenderTarget;
  readonly #events: LaneEvents;
  #options: ResolvedOptions;
  #scale: number;
  #off: (() => void) | null = null;
  #lane: Lane | null = null;
  #selected: number | null = null;
  #time: number | null = null;
  #dirty = true;
  readonly #composition = {
    timeMs: 0,
    host: new Float32Array(SHADE_HOST_WORDS),
    pointerPx: null as readonly [number, number] | null,
    viewport: { w: 0, h: 0 },
    scale: 1,
    originX: 0,
    originY: 0,
  };

  constructor(
    target: RenderTarget,
    options: ResolvedOptions,
    colormap: Uint8Array,
    scale: number,
    events: LaneEvents,
    glyphs?: GlyphSnapshot,
  ) {
    this.#target = target;
    this.#options = options;
    this.#scale = scale;
    this.#events = events;
    this.axes = new Axes(target, options, scale, glyphs);
    const rect = this.axes.rect;
    try {
      this.#painter = new LanePainter(target, rect.width, rect.height);
      this.#painter.writeColormap(colormap);
    } catch (error) {
      this.axes.destroy();
      throw error;
    }
  }
  get lane(): Lane | null {
    return this.#lane;
  }
  get timeRange(): Domain {
    return normalizeDomain(this.#options.timeRange ?? this.#lane?.timeRange ?? null);
  }
  get valueRange(): Domain {
    return normalizeDomain(this.#options.valueRange ?? this.#lane?.valueRange ?? null);
  }
  #style(): Style {
    const o = this.#options;
    return {
      timeRange: o.timeRange,
      valueRange: o.valueRange,
      colorRange: o.colorRange,
      lineWidth: o.lineWidthPx * this.#scale,
      focusColor: o.focusColor,
      unselectedAlpha: o.unselectedAlpha,
    };
  }
  load(
    series: Series | null,
    signal: number,
    scan: Scan,
    selected: number | null,
    observe = true,
  ): void {
    this.#off?.();
    this.#off = null;
    this.#lane?.destroy();
    this.#lane = null;
    this.#painter.reset();
    this.#dirty = true;
    this.#selected = selected;
    this.#layout(this.valueRange, true);
    if (!series) {
      this.#painter.releaseSlabs();
      return;
    }
    const lane = new Lane(series, signal, this.#painter, this.#style(), scan, {
      ...this.#events,
      range: (domain) => {
        // Resolve the gutter before rebuilding history, including offscreen preparation.
        this.#layout(domain);
        this.#events.range(domain);
      },
    });
    this.#lane = lane;
    if (observe) this.#off = series.on('change', () => lane.update());
    lane.select(selected);
  }
  configure(options: ResolvedOptions, scale: number, colormap?: Uint8Array): boolean {
    const changed = options !== this.#options || scale !== this.#scale || !!colormap;
    this.#options = options;
    this.#scale = scale;
    const resized = this.#layout(this.valueRange);
    if (!resized && !changed) return false;
    if (colormap) this.#painter.writeColormap(colormap);
    this.#lane?.setStyle(this.#style(), resized || !!colormap);
    this.#dirty = true;
    return true;
  }
  /** Lay the axes out for `value`, the gutter measured afresh when `reset`; true when it resized. */
  #layout(value: Domain, reset = false): boolean {
    const resized = this.axes.configure(this.#options, this.#scale, value, reset);
    if (resized) this.#painter.resize(this.axes.rect.width, this.axes.rect.height);
    return resized;
  }
  async setShade(wgsl: string | null): Promise<void> {
    await this.#painter.setShade(wgsl);
    this.#dirty = true;
  }
  refreshFont(): void {
    this.axes.refreshFont();
    this.#dirty = true;
  }
  select(element: number | null): void {
    this.#selected = element;
    this.#lane?.select(element);
  }
  seek(time: number | null): void {
    if (time !== this.#time) {
      this.#time = time;
      this.#dirty = true;
    }
  }
  /** Map backing pixels into the shared plot rectangle; gutters are not data. */
  point(x: number, y: number): { x: number; y: number } | null {
    const r = this.axes.rect;
    if (x < r.x || y < r.y || x > r.x + r.width || y > r.y + r.height) return null;
    return { x: (x - r.x) / r.width, y: (y - r.y) / r.height };
  }
  frame(
    settled: boolean,
    timeMs: number,
    host: Float32Array,
    pointer: readonly [number, number] | null,
    changed: boolean,
    refine = true,
  ): void {
    // A gesture draws the retained image; only its final range starts source work.
    if (refine)
      this.#lane?.frame(settled, () => {
        this.#dirty = true;
      });
    if (this.#dirty || changed) this.draw(timeMs, host, pointer);
  }
  async prepare(signal: AbortSignal): Promise<void> {
    await this.#lane?.prepare(signal);
  }
  draw(timeMs = 0, host?: Float32Array, pointer: readonly [number, number] | null = null): void {
    const frame = this.#composition;
    frame.timeMs = timeMs;
    if (host) frame.host.set(host);
    frame.pointerPx = pointer;
    frame.scale = this.#scale;
    frame.viewport.w = this.#target.width / this.#scale;
    frame.viewport.h = this.#target.height / this.#scale;
    frame.originX = this.axes.rect.x / this.#scale;
    frame.originY = this.axes.rect.y / this.#scale;
    const { width, height, device } = this.#target,
      r = this.axes.rect;
    this.axes.update(this.timeRange, this.valueRange);
    const encoder = device.createCommandEncoder({ label: 'monitor-plot' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.#target.texture().createView(),
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    this.axes.grid(pass);
    pass.setViewport(r.x, r.y, r.width, r.height, 0, 1);
    pass.setScissorRect(r.x, r.y, r.width, r.height);
    this.#painter.compose(
      pass,
      this.#selected === null ? 1 : this.#options.unselectedAlpha,
      this.timeRange,
      this.valueRange,
      frame,
    );
    pass.setViewport(0, 0, width, height, 0, 1);
    pass.setScissorRect(0, 0, width, height);
    this.axes.cursor(pass, this.#time, this.timeRange);
    this.axes.labels(pass);
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.#dirty = false;
  }
  destroy(): void {
    this.#off?.();
    this.#lane?.destroy();
    this.#painter.destroy();
    this.axes.destroy();
  }
}
