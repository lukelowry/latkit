/// <reference types="@webgpu/types" />
import {
  createFrameLoop,
  createPresentation,
  type DeviceLease,
  type Frame,
  type FrameLoop,
  type Presentation,
} from '@latkit/gpu';
import {
  bakeColormap,
  createEmitter,
  validateSeries,
  type Domain,
  type Series,
} from '@latkit/model';
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
  select: Reading;
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
   * The WebGPU device was lost. The monitor releases it, leases a replacement, and replays its
   * retained state. `recovering` is false when the monitor stays detached: no replacement could
   * be leased, or the host already detached or attached anew from its `attached` handler. A
   * `detach` or `attach` from this handler also wins over the recovery.
   */
  deviceLost: { readonly reason: string; readonly message: string; readonly recovering: boolean };
};
/** A durable view of one signal. Borrows its series and canvas; owns renderer resources. */
export interface Monitor {
  readonly attached: boolean;
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;
  /** Lease a device and replay retained state. A newer attach/detach rejects this attach with AbortError. */
  attach(canvas: HTMLCanvasElement): Promise<void>;
  /** Release resources and subscriptions, retaining data, selection, and options. */
  detach(): void;
  /** Bind a series; committed appends are observed automatically. Loading it again retries failed work. */
  load(series: Series, signal?: number): void;
  setSignal(signal: number): void;
  /** Validate the entire patch before changing anything. devices is construction-only. */
  setOptions(options: Options): void;
  /** Highlight a class element; an unrecorded index is ignored. */
  select(element: number | null): void;
  clear(): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}
interface Binding {
  readonly generation: number;
  readonly canvas: HTMLCanvasElement;
  readonly presentation: Presentation<HTMLCanvasElement>;
  readonly painter: LanePainter;
  readonly lifecycle: Lifecycle;
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
    destroyed = false,
    generation = 0;
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
    entry.off = series.on('append', () => {
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
      if (entry.cursor) void reading(entry, false);
      else if (lastReading !== null) {
        lastReading = null;
        events.emit('hover', null);
      }
    }
    entry.lane?.frame(frame.settled);
    return false;
  }
  async function reading(entry: Binding, selecting: boolean): Promise<void> {
    const cursor = entry.cursor,
      lane = entry.lane;
    if (!cursor || !lane || consumerPaused) return;
    const rect = entry.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const key = selecting ? 'pick' : 'hover';
    entry[key]?.abort();
    const job = new AbortController();
    entry[key] = job;
    try {
      const result = await lane.reading(
        clamp((cursor.x - rect.left) / rect.width),
        clamp((cursor.y - rect.top) / rect.height),
        job.signal,
      );
      if (
        job.signal.aborted ||
        entry[key] !== job ||
        entry.released ||
        entry.lane !== lane ||
        consumerPaused ||
        (!selecting && entry.cursor !== cursor)
      )
        return;
      if (selecting) {
        if (result) {
          applySelection(result.element);
          events.emit('select', result);
        }
      } else if (!sameSample(result, lastReading)) {
        lastReading = result;
        events.emit('hover', result);
      }
    } catch (error) {
      if (!job.signal.aborted && entry[key] === job && !entry.released)
        events.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (entry[key] === job) entry[key] = null;
    }
  }
  function applySelection(element: number | null): void {
    if (element === selected) return;
    selected = element;
    binding?.lane?.select(element);
  }
  function bind(lease: DeviceLease, canvas: HTMLCanvasElement, own: number): Binding {
    const lifecycle = createLifecycle();
    lifecycle.add(() => lease.release());
    try {
      const presentation = createPresentation(lease.device, canvas, {
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      lifecycle.add(() => presentation.destroy());
      // Size the backing store before the painter allocates targets, as the loop's first frame
      // would: from the laid-out size, since the first observation reports that too.
      const ratio = (canvas.ownerDocument?.defaultView ?? globalThis.window)?.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      presentation.resize(width, height);
      const painter = new LanePainter(presentation, canvas.width, canvas.height);
      lifecycle.add(() => painter.destroy());
      let entry: Binding | null = null;
      const loop = createFrameLoop(presentation, (frame) => (entry ? render(entry, frame) : false));
      lifecycle.add(() => loop.destroy());
      if (consumerPaused) loop.pause();
      const built: Binding = {
        generation: own,
        canvas,
        presentation,
        painter,
        lifecycle,
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
      const down = (event: PointerEvent) => {
        built.cursor = { x: event.clientX, y: event.clientY };
        void reading(built, true);
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerleave', leave);
      canvas.addEventListener('pointerdown', down);
      lifecycle.add(() => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerleave', leave);
        canvas.removeEventListener('pointerdown', down);
      });
      lifecycle.add(forwardDeviceLoss(lease.device, (info) => recover(own, info)));
      lifecycle.add(() => {
        built.released = true;
        forgetLane(built);
      });
      return built;
    } catch (error) {
      lifecycle.destroy();
      throw error;
    }
  }
  function release(): void {
    const entry = binding;
    if (!entry) return;
    binding = null;
    lastReading = null;
    entry.lifecycle.destroy();
    if (!destroyed) events.emit('attached', false);
  }
  function recover(own: number, info: GPUDeviceLostInfo): void {
    const entry = binding;
    if (!entry || entry.generation !== own || destroyed) return;
    const canvas = entry.canvas;
    // A detach or attach made from the `attached` or `deviceLost` handler bumps the generation;
    // the host's call then owns the outcome, and the recovery stands aside.
    const mark = generation;
    release();
    events.emit('deviceLost', {
      reason: info.reason ?? 'unknown',
      message: info.message || 'WebGPU device was lost',
      recovering: generation === mark && !destroyed,
    });
    if (generation !== mark || destroyed) return;
    void api.attach(canvas).catch((error: unknown) => {
      if (isAbortError(error) || destroyed) return;
      events.emit('deviceLost', {
        reason: 'unavailable',
        message: describe(error),
        recovering: false,
      });
    });
  }
  function checkSignal(input: Series, index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= input.signalCount)
      throw new RangeError(`monitor: signal ${index} out of [0, ${input.signalCount})`);
  }

  const api: Monitor = {
    get attached() {
      return binding !== null;
    },
    on: (event, handler) => events.on(event, handler),
    async attach(canvas) {
      if (destroyed) throw new Error('monitor: the controller is destroyed');
      const own = ++generation;
      release();
      const lease = await resolved.devices.acquire();
      if (own !== generation || destroyed) {
        lease.release();
        throw superseded();
      }
      try {
        assertDeviceLimits(lease.device);
      } catch (error) {
        lease.release();
        throw error;
      }
      const entry = bind(lease, canvas, own);
      binding = entry;
      try {
        replay(entry);
      } catch (error) {
        binding = null;
        entry.lifecycle.destroy();
        throw error;
      }
      events.emit('attached', true);
    },
    detach() {
      generation++;
      release();
    },
    load(next, index = 0) {
      if (destroyed) return;
      validateSeries(next);
      checkSignal(next, index);
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
    setSignal(index) {
      if (destroyed) return;
      if (!series) throw new Error('monitor: setSignal before load');
      api.load(series, index);
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
    clear() {
      if (destroyed) return;
      series = null;
      selected = null;
      lastReading = null;
      scan = { frames: 0, range: null, domain: null };
      if (binding) replay(binding);
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
      generation++;
      release();
      series = null;
      selected = null;
      events.clear();
    },
  };
  return api;
}
/** Resources registered transactionally while a binding is constructed. */
interface Lifecycle {
  add(cleanup: () => void): void;
  destroy(): void;
}

/** Creates an idempotent, reverse-order cleanup stack. */
function createLifecycle(): Lifecycle {
  const cleanups: Array<() => void> = [];
  let destroyed = false;

  return {
    add(cleanup) {
      cleanups.push(cleanup);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try {
          cleanups[i]!();
        } catch {
          // Cleanup is best-effort so one resource cannot strand the remainder.
        }
      }
      cleanups.length = 0;
    },
  };
}

/** Rejects devices known not to meet the renderer's Core WebGPU limits. */
function assertDeviceLimits(device: GPUDevice): void {
  const vertexStorage = device.limits.maxStorageBuffersInVertexStage;
  if (vertexStorage !== undefined && vertexStorage < 2) {
    throw new TypeError('A Core WebGPU device is required');
  }
}

/** Relays one device-loss notification without retaining a released binding. */
function forwardDeviceLoss(
  device: GPUDevice,
  listener: (info: GPUDeviceLostInfo) => void,
): () => void {
  let active: ((info: GPUDeviceLostInfo) => void) | undefined = listener;
  void device.lost.then((info) => active?.(info));
  return () => {
    active = undefined;
  };
}

/** The rejection of an attach that a newer attach or a detach overtook. */
function superseded(): DOMException {
  return new DOMException('The attach was superseded.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
