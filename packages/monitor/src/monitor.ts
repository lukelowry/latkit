import type { Scene } from './snapshot.js';
/// <reference types="@webgpu/types" />
import {
  createAttachment,
  createFrameLoop,
  createPresentation,
  type Frame,
  type FrameLoop,
  type Presentation,
} from '@latkit/gpu';
import type { Domain, Series } from '@latkit/model';
import { bakeColormap, createEmitter } from '@latkit/gpu';
import { validateSeries } from '@latkit/model';
import { storedElement, type Scan } from './lane.js';
import { OPTIONS, resolveOptions, validateOptions, type Options } from './options.js';
import { createInteraction } from './interaction.js';
import { transformRange } from './view.js';
import { SHADE_HOST_WORDS, type Shade, type ShadeFrame } from './shade.js';
import { Plot } from './plot.js';
import { snapshotGlyphs } from './axes.js';
export type { Options } from './options.js';

/** Exact sample selected by a pointer; element is the original class index. */
export interface Reading {
  readonly signal: number;
  readonly element: number;
  readonly frame: number;
  readonly t: number;
  readonly value: number;
  readonly x: number;
  readonly y: number;
}
/** Controller events. Programmatic selection does not emit select. */
export type Events = {
  hover: Reading | null;
  /** The primary button picked a sample; other buttons select nothing. */
  select: Reading;
  /**
   * A context menu was asked for, and the native one suppressed: by the pointer, with the sample
   * under it, resolved against the series shown when it was asked; or by the keyboard, at the
   * sample last hovered, else the canvas center. Nothing is selected.
   */
  contextmenu: {
    readonly event: MouseEvent;
    readonly keyboard: boolean;
    readonly clientX: number;
    readonly clientY: number;
    readonly reading: Reading | null;
  };
  error: Error;
  valueRange: Domain;
  /**
   * The latest committed history and selected trace have been submitted and presented. Like the
   * network's `painted`, never before the canvas has a layout size: a canvas without area renders
   * no frames, and the resize that gives it area presents and reports.
   */
  rendered: undefined;
  attached: boolean;
  /**
   * The WebGPU device was lost. The monitor releases it, leases a replacement for the same canvas,
   * and replays its retained state; attaching that canvas joins the recovery. `recovering` is false
   * when the monitor stays detached: no replacement could be leased, or an `attached` handler
   * detached or attached another canvas first. A `detach` or another canvas's `attach` from this
   * handler also ends the recovery.
   */
  deviceLost: { readonly reason: string; readonly message: string; readonly recovering: boolean };
};
/** A durable view of one signal. Borrows its series and canvas; owns renderer resources. */
export interface Monitor {
  /** Capture display settings and the borrowed signal binding. */
  snapshot(): Scene;
  readonly attached: boolean;
  /** The canvas bound or binding, or null. */
  readonly canvas: HTMLCanvasElement | null;
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;
  /**
   * Lease a device and replay retained state; attaching the canvas already bound or binding joins
   * that attach. Resolves true once bound, false when a newer attach or a detach took over first.
   */
  attach(canvas: HTMLCanvasElement): Promise<boolean>;
  /**
   * Release resources and subscriptions, retaining data, selection, and options; with `canvas`,
   * only while that canvas is the one bound or binding.
   */
  detach(canvas?: HTMLCanvasElement): void;
  /**
   * Show one signal of a series, such as a model field, or nothing with null; committed appends
   * are observed automatically. Loading it again retries failed work.
   *
   * @throws TypeError when `binding` is not a series binding; RangeError for a signal the series
   * lacks.
   */
  load(binding: { readonly series: Series; readonly signal: number } | null): void;
  /** Validate the entire patch before changing anything. devices is construction-only. */
  setOptions(options: Options): void;
  /** Highlight a class element; an unrecorded index is ignored. */
  select(element: number | null): void;
  /** Move or hide the simulation playhead without rereading history. */
  seek(time: number | null): void;
  /** Translate the displayed plot by CSS pixels. Source refinement waits for movement to settle. */
  pan(dx: number, dy: number): void;
  /** Zoom both axes; a factor above 1 zooms in. Omit the client-coordinate anchor for the plot center. */
  zoom(factor: number, anchor?: { readonly clientX: number; readonly clientY: number }): void;
  /** Restore automatic time and value ranges. */
  fit(): void;
  /**
   * Compile a composed-trace shade, or reset with null. Failed builds keep the previous shade.
   * Detached controllers retain it and compile on attach, reporting failures through error.
   */
  setShade(shade: Shade | null): Promise<void>;
  /** Map viewport client coordinates to data, or null outside the plot or before preparation. */
  toData(
    clientX: number,
    clientY: number,
  ): { readonly time: number; readonly value: number } | null;
  pause(): void;
  resume(): void;
  destroy(): void;
}
interface Binding {
  readonly canvas: HTMLCanvasElement;
  readonly presentation: Presentation<HTMLCanvasElement>;
  readonly plot: Plot;
  /** One frame loop per binding: backing size, cursor readings, and the lane's presents. */
  readonly loop: FrameLoop;
  released: boolean;
  backingScale: number;
  refinement: ReturnType<typeof setTimeout> | null;
  interaction: ReturnType<typeof createInteraction> | null;
  shadeReady: boolean;
  cursor: { readonly x: number; readonly y: number } | null;
  cursorDirty: boolean;
  hover: AbortController | null;
  pick: AbortController | null;
  context: AbortController | null;
}

/** Create a monitor without acquiring a device or reading samples until attach. */
export function createMonitor(options: Options = {}): Monitor {
  const resolved = resolveOptions(options);
  const events = createEmitter<Events>();
  let settings = resolved;
  let colormapLut = bakeColormap(resolved.colormap);
  let series: Series | null = null;
  let signalIndex = 0;
  let scan: Scan = { frames: 0, range: null, domain: null, time: null };
  let selected: number | null = null;
  let lastReading: Reading | null = null;
  let playhead: number | null = null;
  let shade: Shade | null = null;
  let shadeVersion = 0;
  const host = new Float32Array(SHADE_HOST_WORDS);
  const pointer: [number, number] = [0, 0];
  const shadeFrame: { -readonly [K in keyof ShadeFrame]: ShadeFrame[K] } = {
    timeMs: 0,
    pointerPx: null,
    viewport: { w: 0, h: 0 },
  };
  const viewport = { w: 0, h: 0 };
  shadeFrame.viewport = viewport;
  let consumerPaused = false,
    destroyed = false;
  /** The binding in effect, set once its collaborators exist so its replay can draw. */
  let binding: Binding | null = null;

  function cancelReadings(entry: Binding): void {
    entry.hover?.abort();
    entry.hover = null;
    entry.pick?.abort();
    entry.pick = null;
    entry.context?.abort();
    entry.context = null;
  }
  function replay(entry: Binding): void {
    cancelReadings(entry);
    entry.plot.load(series, signalIndex, scan, selected);
    entry.plot.seek(playhead);
    if (!consumerPaused) {
      entry.plot.lane?.resume();
      entry.loop.wake();
    }
  }
  /**
   * Render one frame: adopt a backing size the loop changed (the shown image stretches to it, and
   * the lane repaints at the new size and line scale once the size settles), resolve the latest
   * cursor reading, then present what the lane asked to show.
   */
  function render(entry: Binding, frame: Frame): boolean {
    if (entry.released || consumerPaused) return false;
    entry.backingScale = frame.backingScale;
    if (entry.plot.configure(settings, entry.backingScale)) cancelReadings(entry);
    const cursorChanged = entry.cursorDirty;
    if (entry.cursorDirty) {
      entry.cursorDirty = false;
      if (entry.cursor && !entry.interaction?.active) void reading(entry, 'hover');
      else if (lastReading !== null) {
        lastReading = null;
        events.emit('hover', null);
      }
    }
    shadeFrame.timeMs = frame.now;
    viewport.w = frame.width;
    viewport.h = frame.height;
    if (entry.cursor) {
      const rect = entry.canvas.getBoundingClientRect();
      pointer[0] = entry.cursor.x - rect.left;
      pointer[1] = entry.cursor.y - rect.top;
      shadeFrame.pointerPx = pointer;
    } else shadeFrame.pointerPx = null;
    const tick = entry.shadeReady ? shade?.tick : undefined;
    const animate = tick?.(host, shadeFrame) ?? false;
    entry.plot.frame(
      frame.settled,
      frame.now,
      host,
      shadeFrame.pointerPx,
      !!tick || (cursorChanged && shade !== null),
      entry.refinement === null && !entry.interaction?.active,
    );
    return animate;
  }
  /**
   * Read the sample under the cursor for a hover, a pick, or a context menu, dropping the answer
   * when a newer ask, another series, or a release supersedes it.
   */
  async function reading(
    entry: Binding,
    kind: 'hover' | 'pick' | 'context',
    menu?: MouseEvent,
  ): Promise<void> {
    const cursor = entry.cursor,
      lane = entry.plot.lane;
    if (!cursor || !lane || consumerPaused) return;
    if (kind === 'hover' && entry.hover) return;
    const rect = entry.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const point = entry.plot.point(
      ((cursor.x - rect.left) / rect.width) * entry.canvas.width,
      ((cursor.y - rect.top) / rect.height) * entry.canvas.height,
    );
    if (!point) {
      if (kind === 'hover' && lastReading !== null) {
        lastReading = null;
        events.emit('hover', null);
      }
      if (kind === 'context')
        events.emit('contextmenu', {
          event: menu!,
          keyboard: false,
          clientX: cursor.x,
          clientY: cursor.y,
          reading: null,
        });
      return;
    }
    entry[kind]?.abort();
    const job = new AbortController();
    entry[kind] = job;
    try {
      const sample = await lane.reading(
        point.x,
        point.y,
        job.signal,
        entry.plot.timeRange,
        entry.plot.valueRange,
      );
      const plot = entry.plot.axes.rect;
      const result = sample
        ? {
            ...sample,
            x: (plot.x + sample.x * plot.width) / entry.canvas.width,
            y: (plot.y + sample.y * plot.height) / entry.canvas.height,
          }
        : null;
      if (
        job.signal.aborted ||
        entry[kind] !== job ||
        entry.released ||
        entry.plot.lane !== lane ||
        consumerPaused ||
        (kind === 'hover' && entry.cursor !== cursor)
      )
        return;
      if (kind === 'pick') {
        if (result) {
          applySelection(result.element);
          events.emit('select', result);
        }
      } else if (kind === 'context') {
        events.emit('contextmenu', {
          event: menu!,
          keyboard: false,
          clientX: cursor.x,
          clientY: cursor.y,
          reading: result,
        });
      } else if (!sameSample(result, lastReading)) {
        lastReading = result;
        events.emit('hover', result);
      }
    } catch (error) {
      if (!job.signal.aborted && entry[kind] === job && !entry.released)
        events.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (entry[kind] === job) entry[kind] = null;
      if (
        kind === 'hover' &&
        !entry.released &&
        entry.cursor !== cursor &&
        entry.cursor &&
        !consumerPaused
      ) {
        entry.cursorDirty = true;
        entry.loop.wake();
      }
    }
  }
  function applySelection(element: number | null): void {
    if (element === selected) return;
    selected = element;
    binding?.plot.select(element);
  }
  /** Build what draws into `canvas` and replay into it; cleanups run in reverse on failure. */
  function bind(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    cleanup: (release: () => void) => void,
  ): Binding {
    if ((device.limits.maxStorageBuffersInVertexStage ?? 2) < 2) {
      throw new TypeError('A Core WebGPU device is required');
    }
    const presentation = createPresentation(device, canvas, {
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    cleanup(() => presentation.destroy());
    // Size the backing store before the painter allocates targets, as the loop's first frame
    // would: from the laid-out size, since the first observation reports that too.
    const ratio = (canvas.ownerDocument?.defaultView ?? globalThis.window)?.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    presentation.resize(width, height);
    let entry: Binding | null = null;
    const scale = Math.min(canvas.width / (width / ratio), canvas.height / (height / ratio));
    const plot = new Plot(presentation, settings, colormapLut, scale, {
      error: (error) => {
        if (entry && !entry.released) events.emit('error', error);
      },
      range: (range) => {
        if (entry && !entry.released) events.emit('valueRange', range);
      },
      rendered: () => {
        if (entry && !entry.released) events.emit('rendered', undefined);
      },
      present: () => {
        if (entry && !entry.released) entry.loop.wake();
      },
    });
    cleanup(() => plot.destroy());
    const loop = createFrameLoop(presentation, (frame) => {
      if (!entry) return false;
      try {
        return render(entry, frame);
      } catch (error) {
        attachment.detach(canvas);
        events.emit('error', error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    });
    cleanup(() => loop.destroy());
    if (consumerPaused) loop.pause();
    const built: Binding = {
      canvas,
      presentation,
      plot,
      loop,
      released: false,
      // The loop's formula, so an unchanged size never reads as a moved scale on its first frame.
      backingScale: Math.min(canvas.width / (width / ratio), canvas.height / (height / ratio)),
      refinement: null,
      interaction: null,
      shadeReady: shade === null,
      cursor: null,
      cursorDirty: false,
      hover: null,
      pick: null,
      context: null,
    };
    entry = built;
    const fonts = canvas.ownerDocument?.fonts;
    const refreshFont = () => {
      if (built.released) return;
      plot.refreshFont();
      loop.wake();
    };
    fonts?.addEventListener('loadingdone', refreshFont);
    cleanup(() => fonts?.removeEventListener('loadingdone', refreshFont));
    const move = (event: PointerEvent) => {
      built.cursor = { x: event.clientX, y: event.clientY };
      built.cursorDirty = true;
      loop.wake();
    };
    const leave = () => {
      built.hover?.abort();
      built.cursor = null;
      built.cursorDirty = true;
      loop.wake();
    };
    /** A secondary press came first: the next context menu is the pointer's, not the keyboard's. */
    let secondary = false;
    const down = (event: PointerEvent) => {
      secondary ||= event.button === 2;
    };
    const menu = (event: MouseEvent) => {
      event.preventDefault();
      const pointer = secondary || event.button === 2;
      secondary = false;
      if (pointer) {
        built.cursor = { x: event.clientX, y: event.clientY };
        void reading(built, 'context', event);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const anchor = lastReading;
      events.emit('contextmenu', {
        event,
        keyboard: true,
        clientX: rect.left + (anchor ? anchor.x : 0.5) * rect.width,
        clientY: rect.top + (anchor ? anchor.y : 0.5) * rect.height,
        reading: anchor,
      });
    };
    built.interaction = createInteraction(canvas, {
      enabled: () => settings.interaction && !consumerPaused,
      contains: (x, y) => clientPoint(built, x, y) !== null && !!built.plot.lane?.resolved,
      pan: (dx, dy) => api.pan(dx, dy),
      zoom: (factor, anchor) => api.zoom(factor, anchor),
      pick: (event) => {
        built.cursor = { x: event.clientX, y: event.clientY };
        void reading(built, 'pick');
      },
      settled: () => {
        built.cursorDirty = true;
        loop.wake();
      },
    });
    cleanup(() => built.interaction?.destroy());
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('contextmenu', menu);
    cleanup(() => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('contextmenu', menu);
    });
    cleanup(() => {
      built.released = true;
      if (built.refinement !== null) clearTimeout(built.refinement);
      cancelReadings(built);
    });
    binding = built;
    cleanup(() => {
      if (binding === built) binding = null;
    });
    replay(built);
    if (shade) {
      const version = shadeVersion;
      void plot.setShade(shade.wgsl).then(
        () => {
          if (!built.released && version === shadeVersion) {
            built.shadeReady = true;
            loop.wake();
          }
        },
        (error: unknown) => {
          if (!built.released && version === shadeVersion)
            events.emit('error', error instanceof Error ? error : new Error(String(error)));
        },
      );
    }
    return built;
  }
  const attachment = createAttachment<Binding>({
    devices: resolved.devices,
    bind,
    release: () => {
      binding = null;
      lastReading = null;
    },
    attached: (bound) => events.emit('attached', bound),
    lost: (loss) => events.emit('deviceLost', loss),
  });
  function checkLoad(input: { readonly series: Series; readonly signal: number }): void {
    if (!input || typeof input !== 'object')
      throw new TypeError('monitor: load takes { series, signal }');
    validateSeries(input.series);
    const { series: next, signal: index } = input;
    if (!Number.isInteger(index) || index < 0 || index >= next.signals.length)
      throw new RangeError(`monitor: signal ${index} out of [0, ${next.signals.length})`);
  }

  function clientPoint(entry: Binding, x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const rect = entry.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return entry.plot.point(
      ((x - rect.left) / rect.width) * entry.canvas.width,
      ((y - rect.top) / rect.height) * entry.canvas.height,
    );
  }
  function moveView(timeRange: Domain, valueRange: Domain): void {
    const entry = binding;
    if (!entry) return;
    settings = { ...settings, timeRange, valueRange };
    cancelReadings(entry);
    entry.cursorDirty = true;
    entry.plot.configure(settings, entry.backingScale);
    if (entry.refinement !== null) clearTimeout(entry.refinement);
    entry.refinement = setTimeout(() => {
      entry.refinement = null;
      if (!entry.released) entry.loop.wake();
    }, 120);
    entry.loop.wake();
  }

  const api: Monitor = {
    snapshot() {
      if (!series) throw new DOMException('No monitor series is loaded', 'InvalidStateError');
      const { devices: _devices, colormap: _colormap, ...style } = settings;
      return {
        kind: 'monitor',
        series,
        signal: signalIndex,
        options: structuredClone({
          ...style,
          timeRange: binding?.plot.lane?.resolved
            ? binding.plot.timeRange
            : (style.timeRange ?? series.state.timeRange),
          valueRange: binding?.plot.lane?.resolved
            ? binding.plot.valueRange
            : (style.valueRange ?? scan.domain),
        }),
        glyphs: binding ? binding.plot.axes.snapshot() : snapshotGlyphs(settings),
        colormap: colormapLut.slice(),
        selected,
        ...(shade ? { shade: { wgsl: shade.wgsl, uniforms: host.slice() } } : {}),
        ...(binding
          ? {
              viewport: [
                binding.canvas.width / binding.backingScale,
                binding.canvas.height / binding.backingScale,
              ] as const,
            }
          : {}),
      };
    },
    get attached() {
      return binding !== null;
    },
    get canvas() {
      return attachment.canvas;
    },
    on: (event, handler) => events.on(event, handler),
    attach: (canvas) => attachment.attach(canvas),
    detach: (canvas) => attachment.detach(canvas),
    load(input) {
      if (destroyed) return;
      if (input === null) {
        series = null;
        selected = null;
        lastReading = null;
        scan = { frames: 0, range: null, domain: null, time: null };
        if (binding) replay(binding);
        return;
      }
      checkLoad(input);
      const { series: next, signal: index } = input;
      if (series === next && signalIndex === index) {
        binding?.plot.lane?.update();
        return;
      }
      series = next;
      signalIndex = index;
      scan = { frames: 0, range: null, domain: null, time: null };
      lastReading = null;
      if (selected !== null && storedElement(next, selected) === null) selected = null;
      if (binding) replay(binding);
    },
    setOptions(patch) {
      if (destroyed) return;
      validateOptions(patch);
      const lut =
        patch.colormap === undefined || patch.colormap === settings.colormap
          ? null
          : bakeColormap(patch.colormap);
      const next = { ...settings };
      for (const key of Object.keys(OPTIONS) as (keyof Options)[]) {
        if (key === 'devices' || patch[key] === undefined) continue;
        const value = patch[key];
        Object.assign(next, { [key]: value });
      }
      settings = resolveOptions(next);
      if (lut) colormapLut = lut;
      if (binding) {
        cancelReadings(binding);
        binding.plot.configure(settings, binding.backingScale, lut ?? undefined);
        binding.interaction?.sync();
        if (patch.timeRange !== undefined || patch.valueRange !== undefined) {
          if (binding.refinement !== null) clearTimeout(binding.refinement);
          binding.refinement = null;
          binding.interaction?.cancel();
        }
        binding.loop.wake();
      }
    },
    select(element) {
      if (destroyed) return;
      const next = element === null ? null : Math.floor(element);
      if (
        next !== null &&
        (!series || !Number.isFinite(next) || storedElement(series, next) === null)
      )
        return;
      applySelection(next);
    },
    seek(time) {
      if (time !== null && !Number.isFinite(time))
        throw new RangeError('Monitor playhead must be finite or null');
      if (destroyed || time === playhead) return;
      playhead = time;
      binding?.plot.seek(time);
      binding?.loop.wake();
    },
    pan(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy))
        throw new RangeError('Monitor pan must be finite');
      const entry = binding;
      if (destroyed || !entry?.plot.lane?.resolved || (dx === 0 && dy === 0)) return;
      const rect = entry.canvas.getBoundingClientRect(),
        plot = entry.plot.axes.rect;
      if (rect.width <= 0 || rect.height <= 0) return;
      moveView(
        transformRange(
          entry.plot.timeRange,
          1,
          0.5,
          (-dx * entry.canvas.width) / rect.width / plot.width,
        ),
        transformRange(
          entry.plot.valueRange,
          1,
          0.5,
          (dy * entry.canvas.height) / rect.height / plot.height,
        ),
      );
    },
    zoom(factor, anchor) {
      if (!Number.isFinite(factor) || factor <= 0)
        throw new RangeError('Monitor zoom factor must be finite and positive');
      const entry = binding;
      if (destroyed || !entry?.plot.lane?.resolved || factor === 1) return;
      const point = anchor
        ? clientPoint(entry, anchor.clientX, anchor.clientY)
        : { x: 0.5, y: 0.5 };
      if (!point) return;
      moveView(
        transformRange(entry.plot.timeRange, factor, point.x),
        transformRange(entry.plot.valueRange, factor, 1 - point.y),
      );
    },
    fit() {
      api.setOptions({ timeRange: null, valueRange: null });
    },
    async setShade(next) {
      if (destroyed) return;
      if (
        next !== null &&
        (typeof next.wgsl !== 'string' ||
          (next.tick !== undefined && typeof next.tick !== 'function'))
      )
        throw new TypeError('Monitor shade requires WGSL and an optional tick function');
      const owned = next ? { wgsl: next.wgsl, tick: next.tick } : null;
      const version = ++shadeVersion;
      while (binding) {
        const entry = binding;
        try {
          await entry.plot.setShade(owned?.wgsl ?? null);
        } catch (error) {
          if (version === shadeVersion && !entry.released) {
            // Also restores an initial attach compile superseded by this failed request.
            await entry.plot.setShade(shade?.wgsl ?? null);
            entry.shadeReady = true;
            entry.loop.wake();
          }
          throw error;
        }
        if (destroyed || version !== shadeVersion) return;
        if (binding === entry) {
          entry.shadeReady = true;
          break;
        }
      }
      if (destroyed || version !== shadeVersion) return;
      shade = owned;
      host.fill(0);
      binding?.loop.wake();
    },
    toData(clientX, clientY) {
      if (!binding?.plot.lane?.resolved || !series) return null;
      const point = clientPoint(binding, clientX, clientY);
      if (!point) return null;
      const time = binding.plot.timeRange,
        value = binding.plot.valueRange;
      return {
        time: time[0] * (1 - point.x) + time[1] * point.x,
        value: value[0] * point.y + value[1] * (1 - point.y),
      };
    },
    pause() {
      consumerPaused = true;
      if (!binding) return;
      cancelReadings(binding);
      binding.interaction?.sync();
      binding.plot.lane?.pause();
      binding.loop.pause();
    },
    resume() {
      if (destroyed || !consumerPaused) return;
      consumerPaused = false;
      if (binding) {
        binding.interaction?.sync();
        if (binding.plot.lane) binding.plot.lane.resume();
        else replay(binding);
        binding.loop.resume();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      shadeVersion++;
      shade = null;
      attachment.destroy();
      series = null;
      selected = null;
      events.clear();
    },
  };
  return api;
}
function sameSample(a: Reading | null, b: Reading | null): boolean {
  return (
    a === b ||
    (!!a && !!b && a.signal === b.signal && a.element === b.element && a.frame === b.frame)
  );
}
