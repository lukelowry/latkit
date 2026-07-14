/// <reference types="@webgpu/types" />
import { LanePainter, SEGMENT_BUDGET, COLORMAP_LUT_SIZE, framesPerWindow } from './painter.js';

/**
 * Packed monitor samples over one shared time axis and element axis.
 *
 * @remarks
 * `values` is signal-major. Convert a signal, frame, and element to an index
 * with:
 *
 * ```ts
 * signal * time.length * elementCount + frame * elementCount + element
 * ```
 *
 * `validFrames` lets append-heavy callers load a preallocated buffer before all
 * frames are ready. After writing more samples, call {@link Monitor.extend} to
 * commit the new frame frontier.
 *
 * @example
 * ```ts
 * const series: Series = {
 *   time: Float64Array.from([0, 1, 2]),
 *   values: new Float32Array(1 * 3 * 2),
 *   signalCount: 1,
 *   elementCount: 2,
 *   validFrames: 0,
 * };
 *
 * series.values[0 * 3 * 2 + 0 * 2 + 0] = 0.25;
 * ```
 */
export interface Series {
  /** Time coordinate for each frame. */
  readonly time: Float32Array | Float64Array;
  /** Packed f32 samples for every signal, frame, and element. */
  readonly values: Float32Array;
  /** Number of independent signals stored in `Series.values`. */
  readonly signalCount: number;
  /** Number of elements sampled at each frame. */
  readonly elementCount: number;
  /** Optional per-signal min/max pairs: `[min0, max0, min1, max1, ...]`. */
  readonly ranges?: Float32Array;
  /** Number of frames ready to draw; omit to treat the whole series as committed. */
  readonly validFrames?: number;
}

/**
 * Initial monitor display options.
 *
 * @remarks
 * These options seed the controller returned by {@link createMonitor}. Runtime
 * setters such as {@link Monitor.setValueRange} and {@link Monitor.setColormap}
 * can update the mutable parts later.
 */
export interface Options {
  /**
   * Transfer function for normalized values.
   *
   * @defaultValue A neutral gray ramp.
   */
  colormap?: (t: number) => readonly [number, number, number];
  /**
   * Trace stroke width in CSS pixels.
   *
   * @defaultValue `1.5`.
   */
  lineWidthPx?: number;
  /**
   * Fixed value domain for vertical position and color.
   *
   * @defaultValue Auto-fit the active signal's finite extent.
   */
  valueRange?: readonly [number, number];
}

/** Nearest trace sample under a pointer interaction. */
export interface Reading {
  /** Signal currently displayed by the monitor. */
  readonly signal: number;
  /** Element index nearest the pointer. */
  readonly element: number;
  /** Frame index nearest the pointer. */
  readonly frame: number;
  /** Time value at `Reading.frame`. */
  readonly t: number;
  /** Sample value at the selected signal, frame, and element. */
  readonly value: number;
  /** Cursor position across the canvas in `[0, 1]`. */
  readonly x: number;
  /** Cursor position down the canvas in `[0, 1]`. */
  readonly y: number;
}

/**
 * Events emitted by a {@link Monitor} instance.
 *
 * @remarks
 * `hover` emits `null` when the pointer leaves the canvas. `pick` only emits
 * when a pointer-down interaction resolves to a reading.
 */
export type Events = {
  /** Nearest reading while hovering, or null when the pointer leaves. */
  hover: Reading | null;
  /** Reading selected by a pointer-down interaction. */
  pick: Reading;
  /** WebGPU device-loss notification surfaced before rendering stops. */
  deviceLost: { readonly reason: string; readonly message: string };
};

/**
 * Imperative controller for a WebGPU signal monitor canvas.
 *
 * @remarks
 * The controller owns its renderer resources, but borrows both the device and
 * canvas supplied to {@link createMonitor}. Call {@link Monitor.destroy}
 * before releasing either borrowed resource.
 */
export interface Monitor {
  /**
   * Subscribe to a monitor event and receive an unsubscribe callback.
   *
   * @param event - Event name to observe.
   * @param handler - Callback invoked with the event payload.
   * @returns A function that removes the handler.
   */
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;

  /**
   * Bind a series and schedule its committed frames for painting.
   *
   * @param series - Packed monitor samples and time coordinates.
   * @param signal - Initial signal index. Default: `0`.
   * @throws Error when the series shape or signal index is invalid.
   */
  load(series: Series, signal?: number): void;

  /**
   * Advance the committed frame frontier.
   *
   * Pass `values` to replace the loaded sample buffer; otherwise mutate the
   * existing buffer in place before calling.
   *
   * @param validFrames - Number of frames ready to draw, clamped to the series length.
   * @param values - Optional replacement buffer with the same length as the loaded series.
   * @throws Error when no series is loaded or the replacement buffer length differs.
   */
  extend(validFrames: number, values?: Float32Array): void;

  /**
   * Switch the displayed signal.
   *
   * @param signal - Signal index in `[0, series.signalCount)`.
   * @throws Error when no series is loaded or the signal index is invalid.
   */
  setSignal(signal: number): void;
  /**
   * Override the value domain, or pass null to return to auto-fit.
   *
   * @param range - Fixed `[min, max]` domain, or `null` for auto-fit.
   */
  setValueRange(range: readonly [number, number] | null): void;
  /**
   * Replace the transfer function used for trace color.
   *
   * @param fn - Function mapping normalized values in `[0, 1]` to RGB channels in `[0, 1]`.
   */
  setColormap(fn: (t: number) => readonly [number, number, number]): void;
  /**
   * Highlight one element with a foreground trace, or pass null to clear focus.
   *
   * @param element - Element index to focus, or `null` to clear focus.
   */
  setFocus(element: number | null): void;
  /** Clear the loaded series and blank the monitor. */
  clear(): void;
  /** Pause painting and pointer hover work until resumed. */
  pause(): void;
  /** Resume painting after a consumer pause. */
  resume(): void;
  /** Release event handlers, canvas configuration, and renderer resources. */
  destroy(): void;
}

const ERROR_PREFIX = '@latkit/monitor';
const DEFAULT_LINE_WIDTH_PX = 1.5;
const NEUTRAL_RAMP = (t: number): readonly [number, number, number] => [t, t, t];

interface Bound {
  series: Series;
  signal: number;
  /** Per-frame x in `[0, 1]` over the series' full time extent. */
  xnorm: Float32Array;
  windowFrames: number;
  /** Extend frontier: frames below it have been painted through extend/load. */
  painted: number;
  /** Committed frame count. Frames at and beyond this frontier are provisional. */
  validFrames: number;
}

/** Segment range [from, to) queued for chunked painting onto the history texture. */
interface PaintJob {
  from: number;
  to: number;
  cursor: number;
}

/**
 * Creates a WebGPU-backed monitor on a caller-owned canvas.
 *
 * @param device - Core WebGPU device borrowed for the lifetime of the monitor.
 * @param canvas - Canvas borrowed for presentation and pointer interaction.
 * @param options - Initial display options.
 * @returns A controller for loading series data, subscribing to readings, and releasing renderer resources.
 * @throws TypeError when `device` does not provide Core WebGPU features and limits.
 * @throws Error when canvas presentation or renderer initialization fails.
 *
 * @example
 * ```ts
 * const canvas = document.querySelector<HTMLCanvasElement>('#monitor')!;
 * const monitor = await createMonitor(device, canvas, { valueRange: [0, 1] });
 * monitor.load(series, 0);
 * ```
 *
 * The returned controller never removes `canvas` or destroys `device`.
 * Destroy the monitor before either borrowed resource is released.
 */
export function createMonitor(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  options: Options = {},
): Promise<Monitor> {
  return Promise.resolve().then(() => createMonitorController(device, canvas, options));
}

function createMonitorController(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  options: Options,
): Monitor {
  assertDeviceLimits(device);
  const lifecycle = createControllerLifecycle();
  try {
    return buildMonitorController(device, canvas, options, lifecycle);
  } catch (error) {
    lifecycle.destroy();
    throw error;
  }
}

function buildMonitorController(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  options: Options,
  lifecycle: ControllerLifecycle,
): Monitor {
  const painter = LanePainter.create(device, canvas);
  lifecycle.add(() => painter.destroy());

  const handlers = new Map<keyof Events, Set<(payload: never) => void>>();
  lifecycle.add(() => handlers.clear());
  const emit = <K extends keyof Events>(event: K, payload: Events[K]): void => {
    for (const handler of handlers.get(event) ?? []) (handler as (p: Events[K]) => void)(payload);
  };

  let colormapFn = options.colormap ?? NEUTRAL_RAMP;
  const lineWidthPx = options.lineWidthPx ?? DEFAULT_LINE_WIDTH_PX;
  let pinnedRange: readonly [number, number] | null = options.valueRange
    ? [...options.valueRange]
    : null;
  let effectiveRange: readonly [number, number] = normalizeRange(pinnedRange);

  let bound: Bound | null = null;
  let job: PaintJob | null = null;
  /** Window index whose slab is resident on the GPU; -1 forces re-upload. */
  let residentWindow = -1;
  let focusElement: number | null = null;
  let presentDirty = false;
  let dead = false;
  let destroyed = false;
  let paused = false;
  let pendingResize = false;
  let observedWidthPx = 0;
  let observedHeightPx = 0;
  let rafId: number | null = null;
  let lostForwarded = false;

  let cursor: { x: number; y: number } | null = null;
  let cursorDirty = false;
  let lastReading: Reading | null = null;

  const dpr = (): number => window.devicePixelRatio || 1;

  const schedule = (): void => {
    if (dead || paused || rafId !== null) return;
    rafId = requestAnimationFrame(tick);
  };

  const resizeObserver = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.devicePixelContentBoxSize?.[0];
    if (box) {
      observedWidthPx = Math.max(1, Math.round(box.inlineSize));
      observedHeightPx = Math.max(1, Math.round(box.blockSize));
    }
    pendingResize = true;
    schedule();
  });
  lifecycle.add(() => resizeObserver.disconnect());
  try {
    resizeObserver.observe(canvas, {
      box: 'device-pixel-content-box' as ResizeObserverBoxOptions,
    });
  } catch {
    resizeObserver.observe(canvas);
  }
  lifecycle.add(() => {
    dead = true;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  });

  lifecycle.add(
    forwardDeviceLoss(painter.device, (info) => {
      if (dead || lostForwarded) return;
      lostForwarded = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      dead = true;
      emit('deviceLost', { reason: String(info.reason), message: info.message });
    }),
  );

  function bakeColormap(): void {
    const lut = new Uint8Array(COLORMAP_LUT_SIZE * 4);
    for (let i = 0; i < COLORMAP_LUT_SIZE; i++) {
      const [r, g, b] = colormapFn(i / (COLORMAP_LUT_SIZE - 1));
      lut[i * 4] = channelByte(r);
      lut[i * 4 + 1] = channelByte(g);
      lut[i * 4 + 2] = channelByte(b);
      lut[i * 4 + 3] = 255;
    }
    painter.writeColormap(lut);
  }
  bakeColormap();

  /** The range that drives y and color together: pinned, or the signal's extent. */
  function resolveRange(): readonly [number, number] {
    if (pinnedRange) return normalizeRange(pinnedRange);
    if (!bound) return [0, 1];
    return normalizeRange(seriesRange(bound.series, bound.signal, bound.validFrames));
  }

  function writeUniforms(): void {
    const [min, max] = effectiveRange;
    const base = {
      widthPx: painter.widthPx,
      heightPx: painter.heightPx,
      rangeMin: min,
      rangeScale: 1 / (max - min),
    };
    painter.writeUniform('history', {
      ...base,
      lineWidthPx: lineWidthPx * dpr(),
      elementCount: bound?.series.elementCount ?? 1,
    });
    painter.writeUniform('focus', {
      ...base,
      lineWidthPx: lineWidthPx * dpr() * 2.5,
      elementCount: 1,
    });
  }

  /** Blank the history and queue the committed trajectory: [0, validFrames - 1). */
  function scheduleRepaint(): void {
    if (!bound) return;
    painter.clearHistory();
    const segments = Math.max(0, bound.validFrames - 1);
    job = segments > 0 ? { from: 0, to: segments, cursor: 0 } : null;
    residentWindow = -1;
    presentDirty = true;
    schedule();
  }

  /** Queue segments [fromSeg, toSeg) without clearing. */
  function scheduleAppend(fromSeg: number, toSeg: number): void {
    if (toSeg <= fromSeg) return;
    if (job) {
      job.from = Math.min(job.from, fromSeg);
      job.to = Math.max(job.to, toSeg);
      job.cursor = Math.min(job.cursor, fromSeg);
    } else {
      job = { from: fromSeg, to: toSeg, cursor: fromSeg };
    }
    residentWindow = -1;
    schedule();
  }

  function uploadFocusTrace(): void {
    if (!bound || focusElement === null || bound.validFrames <= 0) return;
    const { series, xnorm, validFrames } = bound;
    const trace = new Float32Array(validFrames);
    for (let f = 0; f < validFrames; f++)
      trace[f] = sampleValue(series, bound.signal, f, focusElement);
    painter.uploadFocus(trace, xnorm.subarray(0, validFrames));
  }

  /** Paint up to SEGMENT_BUDGET instances of the queued job this frame. */
  function paintChunk(): boolean {
    if (!bound || !job) return false;
    const { series, xnorm, windowFrames, validFrames } = bound;
    if (validFrames <= 1) {
      job = null;
      return false;
    }
    const elementCount = series.elementCount;
    const frames = validFrames;
    const segmentsPerWindow = windowFrames - 1;
    const signalBase = bound.signal * elementCount * series.time.length;
    let budget = SEGMENT_BUDGET;
    let progressed = false;

    while (job && budget > 0) {
      const seg = job.cursor;
      const windowIndex = Math.floor(seg / segmentsPerWindow);
      const firstFrame = windowIndex * segmentsPerWindow;
      const lastFrame = Math.min(firstFrame + windowFrames, frames);
      if (residentWindow !== windowIndex) {
        painter.uploadWindow(
          series.values.subarray(
            signalBase + firstFrame * elementCount,
            signalBase + lastFrame * elementCount,
          ),
          xnorm.subarray(firstFrame, lastFrame),
        );
        residentWindow = windowIndex;
      }
      const windowSegEnd = Math.min(lastFrame - 1, job.to);
      const budgetSegs = Math.floor(budget / elementCount);
      if (budgetSegs === 0 && progressed) break;
      const segCount = Math.max(1, Math.min(windowSegEnd - seg, budgetSegs));
      painter.drawHistory(segCount * elementCount, (seg - firstFrame) * elementCount);
      job.cursor += segCount;
      budget -= segCount * elementCount;
      progressed = true;
      if (job.cursor >= job.to) job = null;
    }
    return progressed;
  }

  function scanReading(): Reading | null {
    if (!bound || !cursor || bound.validFrames <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = clamp01((cursor.x - rect.left) / rect.width);
    const y = clamp01((cursor.y - rect.top) / rect.height);
    const { series, signal, validFrames } = bound;
    const time = series.time;
    const t = time[0]! + x * (time[time.length - 1]! - time[0]!);
    const frame = frameAt(time, t);
    if (frame >= validFrames) return null;
    const sample = sampleFrame(series, signal, frame);
    const [min, max] = effectiveRange;
    const scale = 1 / (max - min);
    let best = -1;
    let bestDist = Infinity;
    for (let e = 0; e < sample.length; e++) {
      const v = sample[e]!;
      if (Number.isNaN(v)) continue;
      const yFrac = 1 - (v - min) * scale;
      const dist = Math.abs(yFrac - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    if (best < 0) return null;
    return { signal, element: best, frame, t: time[frame]!, value: sample[best]!, x, y };
  }

  function emitHover(): void {
    const reading = scanReading();
    if (sameReading(reading, lastReading)) return;
    lastReading = reading;
    emit('hover', reading);
  }

  function tick(): void {
    rafId = null;
    if (dead || paused) return;
    if (pendingResize) {
      pendingResize = false;
      const width = observedWidthPx || Math.max(1, Math.round(canvas.clientWidth * dpr()));
      const height = observedHeightPx || Math.max(1, Math.round(canvas.clientHeight * dpr()));
      if (width !== painter.widthPx || height !== painter.heightPx) {
        canvas.width = width;
        canvas.height = height;
        painter.resize(width, height);
        if (bound) {
          writeUniforms();
          scheduleRepaint();
        } else {
          presentDirty = true;
        }
      }
    }
    const progressed = paintChunk();
    if (progressed || presentDirty) {
      presentDirty = false;
      painter.present(focusInstances());
    }
    if (cursorDirty) {
      cursorDirty = false;
      emitHover();
    }
    if (job || presentDirty || cursorDirty) schedule();
  }

  function focusInstances(): number {
    if (!bound || focusElement === null) return 0;
    return Math.max(0, bound.validFrames - 1);
  }

  const onPointerMove = (event: PointerEvent): void => {
    cursor = { x: event.clientX, y: event.clientY };
    cursorDirty = true;
    schedule();
  };
  const onPointerLeave = (): void => {
    cursor = null;
    cursorDirty = true;
    schedule();
  };
  const onPointerDown = (event: PointerEvent): void => {
    cursor = { x: event.clientX, y: event.clientY };
    const reading = scanReading();
    if (reading) emit('pick', reading);
  };
  lifecycle.add(() => {
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('pointerdown', onPointerDown);
  });
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);

  function requireBound(op: string): Bound {
    if (!bound) throw new Error(`${ERROR_PREFIX}: ${op} before load`);
    return bound;
  }

  function bindSeries(series: Series, signal: number, validFrames?: number): void {
    validateSeries(series, signal);
    const frames = series.time.length;
    const committed = clampFrameCount(validFrames ?? series.validFrames ?? frames, frames);
    const xnorm = new Float32Array(frames);
    const t0 = time0(series.time);
    const span = frames > 1 ? series.time[frames - 1]! - t0 : 1;
    const scale = span > 0 ? 1 / span : 0;
    for (let f = 0; f < frames; f++) xnorm[f] = (series.time[f]! - t0) * scale;
    const windowFrames = framesPerWindow(series.elementCount, painter.windowValueCapacity * 4);
    bound = {
      series,
      signal,
      xnorm,
      windowFrames,
      painted: committed,
      validFrames: committed,
    };
    painter.reserve(series.elementCount, windowFrames, frames);
    effectiveRange = resolveRange();
    writeUniforms();
    if (focusElement !== null && focusElement < series.elementCount) uploadFocusTrace();
    else focusElement = null;
    scheduleRepaint();
  }

  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (payload: never) => void);
      return () => set.delete(handler as (payload: never) => void);
    },

    load(series, signal = 0) {
      if (dead) return;
      bindSeries(series, signal);
    },

    extend(validFrames, values) {
      if (dead) return;
      const state = requireBound('extend');
      if (values) {
        if (values.length !== state.series.values.length) {
          throw new Error(
            `${ERROR_PREFIX}: extend values length ${values.length}, expected ${state.series.values.length}`,
          );
        }
        state.series = { ...state.series, values };
      }

      const to = clampFrameCount(validFrames, state.series.time.length);
      state.validFrames = Math.max(state.validFrames, to);

      if (pinnedRange === null) {
        const next = resolveRange();
        if (next[0] !== effectiveRange[0] || next[1] !== effectiveRange[1]) {
          effectiveRange = next;
          writeUniforms();
          if (focusElement !== null) uploadFocusTrace();
          state.painted = Math.max(state.painted, state.validFrames);
          scheduleRepaint();
          return;
        }
      }

      if (state.validFrames <= state.painted && state.painted > 0) return;
      const fromSeg = Math.max(0, state.painted - 1);
      state.painted = Math.max(state.painted, state.validFrames);
      if (focusElement !== null) uploadFocusTrace();
      scheduleAppend(fromSeg, Math.max(fromSeg, state.validFrames - 1));
      presentDirty = true;
    },

    setSignal(signal) {
      if (dead) return;
      const state = requireBound('setSignal');
      if (!Number.isInteger(signal) || signal < 0 || signal >= state.series.signalCount) {
        throw new Error(
          `${ERROR_PREFIX}: signal ${signal} out of [0, ${state.series.signalCount})`,
        );
      }
      bindSeries(state.series, signal, state.validFrames);
    },

    setValueRange(range) {
      if (dead) return;
      pinnedRange = range ? [range[0], range[1]] : null;
      const next = resolveRange();
      if (next[0] === effectiveRange[0] && next[1] === effectiveRange[1]) return;
      effectiveRange = next;
      writeUniforms();
      if (bound) scheduleRepaint();
    },

    setColormap(fn) {
      if (dead) return;
      colormapFn = fn;
      bakeColormap();
      if (bound) scheduleRepaint();
    },

    setFocus(element) {
      if (dead) return;
      const next = element === null ? null : Math.floor(element);
      if (next !== null && (!bound || next < 0 || next >= bound.series.elementCount)) return;
      if (next === focusElement) return;
      focusElement = next;
      if (focusElement !== null) uploadFocusTrace();
      presentDirty = true;
      schedule();
    },

    clear() {
      if (dead) return;
      bound = null;
      job = null;
      residentWindow = -1;
      focusElement = null;
      lastReading = null;
      painter.clearHistory();
      presentDirty = true;
      schedule();
    },

    pause() {
      paused = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },

    resume() {
      if (dead || !paused) return;
      paused = false;
      schedule();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      dead = true;
      lifecycle.destroy();
    },
  };
}

/** Idempotent cleanup stack for transactional controller construction. */
interface ControllerLifecycle {
  add(cleanup: () => void): void;
  destroy(): void;
}

function createControllerLifecycle(): ControllerLifecycle {
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
          // Continue so one cleanup cannot strand the remaining resources.
        }
      }
      cleanups.length = 0;
    },
  };
}

/** Rejects known compatibility limits while allowing older Core implementations. */
function assertDeviceLimits(device: GPUDevice): void {
  const vertexStorage = device.limits.maxStorageBuffersInVertexStage;
  if (vertexStorage !== undefined && vertexStorage < 2) {
    throw new TypeError('A Core WebGPU device is required');
  }
}

/** Relays one device-loss notification without retaining a destroyed monitor. */
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

function validateSeries(series: Series, signal: number): void {
  const frames = series.time.length;
  if (frames < 1) throw new Error(`${ERROR_PREFIX}: series time must include at least one frame`);
  if (!Number.isInteger(series.elementCount) || series.elementCount <= 0) {
    throw new Error(`${ERROR_PREFIX}: elementCount must be a positive integer`);
  }
  if (!Number.isInteger(series.signalCount) || series.signalCount <= 0) {
    throw new Error(`${ERROR_PREFIX}: signalCount must be a positive integer`);
  }
  if (!Number.isInteger(signal) || signal < 0 || signal >= series.signalCount) {
    throw new Error(`${ERROR_PREFIX}: signal ${signal} out of [0, ${series.signalCount})`);
  }
  const expected = series.signalCount * frames * series.elementCount;
  if (series.values.length !== expected) {
    throw new Error(`${ERROR_PREFIX}: values length ${series.values.length}, expected ${expected}`);
  }
  if (series.ranges && series.ranges.length < series.signalCount * 2) {
    throw new Error(
      `${ERROR_PREFIX}: ranges length ${series.ranges.length}, expected at least ${series.signalCount * 2}`,
    );
  }
  if (series.validFrames !== undefined && !Number.isFinite(series.validFrames)) {
    throw new Error(`${ERROR_PREFIX}: validFrames must be finite`);
  }
}

function channelByte(x: number): number {
  return Math.round(Math.min(1, Math.max(0, x)) * 255);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampFrameCount(n: number, frames: number): number {
  if (!Number.isFinite(n)) return frames;
  return Math.min(Math.max(0, Math.floor(n)), frames);
}

function time0(time: Float32Array | Float64Array): number {
  return time.length > 0 ? time[0]! : 0;
}

function frameAt(time: Float32Array | Float64Array, t: number): number {
  const frames = time.length;
  if (frames <= 1 || t <= time[0]!) return 0;
  if (t >= time[frames - 1]!) return frames - 1;
  let lo = 0;
  let hi = frames - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (time[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function sampleFrame(series: Series, signal: number, frame: number): Float32Array {
  const start = signal * series.time.length * series.elementCount + frame * series.elementCount;
  return series.values.subarray(start, start + series.elementCount);
}

function sampleValue(series: Series, signal: number, frame: number, element: number): number {
  return series.values[
    signal * series.time.length * series.elementCount + frame * series.elementCount + element
  ]!;
}

function seriesRange(
  series: Series,
  signal: number,
  validFrames: number,
): readonly [number, number] | null {
  if (series.ranges) {
    return [series.ranges[signal * 2]!, series.ranges[signal * 2 + 1]!];
  }
  let lo = Infinity;
  let hi = -Infinity;
  const frames = Math.min(validFrames, series.time.length);
  const base = signal * series.time.length * series.elementCount;
  const count = frames * series.elementCount;
  for (let i = 0; i < count; i++) {
    const v = series.values[base + i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

function normalizeRange(range: readonly [number, number] | null): readonly [number, number] {
  if (!range) return [0, 1];
  const [min, max] = range;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 0.5, max + 0.5];
  return min < max ? [min, max] : [max, min];
}

function sameReading(a: Reading | null, b: Reading | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.signal === b.signal &&
    a.element === b.element &&
    a.frame === b.frame &&
    a.value === b.value &&
    a.x === b.x &&
    a.y === b.y
  );
}
