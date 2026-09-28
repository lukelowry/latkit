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
import { Lane, storedElement, type Scan, type Style } from './lane.js';
import { OPTIONS, own, resolveOptions, validateOptions, type Options } from './options.js';
import { LanePainter } from './painter.js';
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
  pause(): void;
  resume(): void;
  destroy(): void;
}
interface Binding {
  readonly canvas: HTMLCanvasElement;
  readonly presentation: Presentation<HTMLCanvasElement>;
  readonly painter: LanePainter;
  /** One frame loop per binding: backing size, cursor readings, and the lane's presents. */
  readonly loop: FrameLoop;
  released: boolean;
  backingScale: number;
  cursor: { readonly x: number; readonly y: number } | null;
  cursorDirty: boolean;
  lane: Lane | null;
  off: (() => void) | null;
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
  let scan: Scan = { frames: 0, range: null, domain: null };
  let selected: number | null = null;
  let lastReading: Reading | null = null;
  let consumerPaused = false,
    destroyed = false;
  /** The binding in effect, set once its collaborators exist so its replay can draw. */
  let binding: Binding | null = null;

  const style = (entry: Binding): Style => ({
    timeRange: settings.timeRange,
    valueRange: settings.valueRange,
    colorRange: settings.colorRange,
    lineWidth: settings.lineWidthPx * entry.backingScale,
    focusColor: settings.focusColor,
    unselectedAlpha: settings.unselectedAlpha,
  });
  function cancelReadings(entry: Binding): void {
    entry.hover?.abort();
    entry.hover = null;
    entry.pick?.abort();
    entry.pick = null;
    entry.context?.abort();
    entry.context = null;
  }
  function forgetLane(entry: Binding): void {
    cancelReadings(entry);
    entry.off?.();
    entry.off = null;
    entry.lane?.destroy();
    entry.lane = null;
  }
  function replay(entry: Binding): void {
    forgetLane(entry);
    entry.painter.writeColormap(colormapLut);
    entry.painter.reset();
    if (!series) {
      entry.painter.releaseSlabs();
      if (!consumerPaused) entry.painter.present();
      return;
    }
    const lane = new Lane(series, signalIndex, entry.painter, style(entry), scan, {
      error: (error) => {
        if (entry.lane === lane && !entry.released) events.emit('error', error);
      },
      range: (range) => {
        if (entry.lane === lane && !entry.released) events.emit('valueRange', range);
      },
      rendered: () => {
        if (entry.lane === lane && !entry.released) events.emit('rendered', undefined);
      },
      present: () => {
        if (entry.lane === lane && !entry.released) entry.loop.wake();
      },
    });
    entry.lane = lane;
    entry.off = series.on('change', () => {
      if (entry.lane === lane) lane.update();
    });
    lane.select(selected);
    if (!consumerPaused) lane.resume();
  }
  /**
   * Render one frame: adopt a backing size the loop changed (the shown image stretches to it, and
   * the lane repaints at the new size and line scale once the size settles), resolve the latest
   * cursor reading, then present what the lane asked to show.
   */
  function render(entry: Binding, frame: Frame): boolean {
    if (entry.released || consumerPaused) return false;
    const { canvas, painter } = entry;
    const resized = canvas.width !== painter.width || canvas.height !== painter.height;
    const moved = entry.backingScale !== frame.backingScale;
    entry.backingScale = frame.backingScale;
    if (resized) painter.resize(canvas.width, canvas.height);
    if (resized || moved) {
      cancelReadings(entry);
      if (entry.lane) entry.lane.setStyle(style(entry), true);
      else painter.present();
    }
    if (entry.cursorDirty) {
      entry.cursorDirty = false;
      if (entry.cursor) void reading(entry, 'hover');
      else if (lastReading !== null) {
        lastReading = null;
        events.emit('hover', null);
      }
    }
    entry.lane?.frame(frame.settled);
    return false;
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
      lane = entry.lane;
    if (!cursor || !lane || consumerPaused) return;
    const rect = entry.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    entry[kind]?.abort();
    const job = new AbortController();
    entry[kind] = job;
    try {
      const result = await lane.reading(
        clamp((cursor.x - rect.left) / rect.width),
        clamp((cursor.y - rect.top) / rect.height),
        job.signal,
      );
      if (
        job.signal.aborted ||
        entry[kind] !== job ||
        entry.released ||
        entry.lane !== lane ||
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
    }
  }
  function applySelection(element: number | null): void {
    if (element === selected) return;
    selected = element;
    binding?.lane?.select(element);
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
    const painter = new LanePainter(presentation, canvas.width, canvas.height);
    cleanup(() => painter.destroy());
    let entry: Binding | null = null;
    const loop = createFrameLoop(presentation, (frame) => (entry ? render(entry, frame) : false));
    cleanup(() => loop.destroy());
    if (consumerPaused) loop.pause();
    const built: Binding = {
      canvas,
      presentation,
      painter,
      loop,
      released: false,
      // The loop's formula, so an unchanged size never reads as a moved scale on its first frame.
      backingScale: Math.min(canvas.width / (width / ratio), canvas.height / (height / ratio)),
      cursor: null,
      cursorDirty: false,
      lane: null,
      off: null,
      hover: null,
      pick: null,
      context: null,
    };
    entry = built;
    const move = (event: PointerEvent) => {
      built.hover?.abort();
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
      // Only the primary button picks; a secondary press is answered by its context menu.
      if (event.button !== 0) {
        secondary ||= event.button === 2;
        return;
      }
      built.cursor = { x: event.clientX, y: event.clientY };
      void reading(built, 'pick');
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
      forgetLane(built);
    });
    binding = built;
    cleanup(() => {
      if (binding === built) binding = null;
    });
    replay(built);
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

  const api: Monitor = {
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
        scan = { frames: 0, range: null, domain: null };
        if (binding) replay(binding);
        return;
      }
      checkLoad(input);
      const { series: next, signal: index } = input;
      if (series === next && signalIndex === index) {
        binding?.lane?.update();
        return;
      }
      series = next;
      signalIndex = index;
      scan = { frames: 0, range: null, domain: null };
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
        Object.assign(next, { [key]: Array.isArray(value) ? own(value) : value });
      }
      settings = next;
      if (lut) colormapLut = lut;
      if (binding) {
        cancelReadings(binding);
        if (lut) binding.painter.writeColormap(lut);
        binding.lane?.setStyle(style(binding), lut !== null);
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
    pause() {
      consumerPaused = true;
      if (!binding) return;
      cancelReadings(binding);
      binding.lane?.pause();
      binding.loop.pause();
    },
    resume() {
      if (destroyed || !consumerPaused) return;
      consumerPaused = false;
      if (binding) {
        if (binding.lane) binding.lane.resume();
        else replay(binding);
        binding.loop.resume();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      attachment.destroy();
      series = null;
      selected = null;
      events.clear();
    },
  };
  return api;
}
function clamp(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function sameSample(a: Reading | null, b: Reading | null): boolean {
  return (
    a === b ||
    (!!a && !!b && a.signal === b.signal && a.element === b.element && a.frame === b.frame)
  );
}
