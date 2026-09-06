/// <reference types="@webgpu/types" />
import { createPresentation, type DeviceLease, type Presentation } from '@latkit/gpu';
import {
  bakeColormap,
  createEmitter,
  extent,
  frameAt,
  sample,
  type Domain,
  type RGBA,
  type Series,
} from '@latkit/model';

import { OPTIONS, own, resolveOptions, validateOptions, type Options } from './options.js';
import { LanePainter, SEGMENT_BUDGET, framesPerWindow } from './painter.js';

export type { Options } from './options.js';

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
 * Events emitted by a {@link Monitor} instance, keyed by name with their payload.
 *
 * @remarks
 * `hover` carries `null` when the pointer leaves the canvas. `select` reports the reading a
 * pointer-down resolved to; the monitor selects that reading's element itself. Programmatic
 * {@link Monitor.select} does not emit `select`.
 */
export type Events = {
  /** Nearest reading while hovering, or null when the pointer leaves. */
  hover: Reading | null;
  /** Reading selected by a pointer-down interaction. */
  select: Reading;
  /** Bound to a canvas after {@link Monitor.attach}, or released from one. */
  attached: boolean;
  /**
   * The WebGPU device was lost. The controller releases it, leases a replacement, and replays
   * every retained state; `recovering` is false only when no replacement could be leased, and
   * the controller then stays detached.
   */
  deviceLost: { readonly reason: string; readonly message: string; readonly recovering: boolean };
};

/**
 * Imperative controller for a WebGPU signal monitor canvas.
 *
 * @remarks
 * A controller outlives any canvas and any device. The series, the displayed signal, the
 * committed frame frontier, the selection, and every option are retained on the CPU side;
 * {@link Monitor.attach} leases a device, binds a canvas, and replays them, and
 * {@link Monitor.detach} releases both while keeping every state for the next attach. The
 * controller never removes a canvas or destroys a device.
 */
export interface Monitor {
  /** Whether a canvas is bound and painting. */
  readonly attached: boolean;

  /**
   * Subscribe to a monitor event and receive an unsubscribe callback.
   *
   * @param event - Event name to observe.
   * @param handler - Callback invoked with the event payload.
   * @returns A function that removes the handler.
   */
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;

  /**
   * Lease a device from the `devices` option and bind `canvas`, replaying every retained state.
   *
   * A newer `attach` or a `detach` supersedes an attach still awaiting its device, which then
   * rejects with an `AbortError`. The previous canvas, if any, is released first.
   *
   * @param canvas - Borrowed canvas used for presentation and pointer interaction.
   * @throws GpuUnavailableError when no device can be leased.
   * @throws TypeError when the leased device does not provide Core WebGPU features and limits.
   * @throws Error when canvas presentation or renderer initialization fails.
   */
  attach(canvas: HTMLCanvasElement): Promise<void>;
  /** Release the device lease, renderer resources, and canvas listeners; every state stays. */
  detach(): void;

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
   * Pass `values` to replace the loaded sample buffer; otherwise mutate the existing buffer in
   * place before calling. Frames below the frontier are treated as final: the auto-fit value
   * range grows with the newly committed frames only.
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
   * Update display options. `devices` remains construction-only.
   *
   * @param options - Partial display option patch.
   * @throws TypeError or RangeError when any option is invalid; nothing is applied.
   */
  setOptions(options: Options): void;
  /**
   * Highlight one element with a foreground trace, or clear the selection with `null`, without
   * emitting `select`. An element outside the loaded series is ignored.
   *
   * @param element - Element index to select, or `null` to clear.
   */
  select(element: number | null): void;
  /** Clear the loaded series and blank the monitor. */
  clear(): void;

  /** Pause painting and pointer hover work until resumed. */
  pause(): void;
  /** Resume painting after a consumer pause. */
  resume(): void;
  /** Detach and forget every retained state; the controller cannot be used afterwards. */
  destroy(): void;
}

/** Durable CPU-side state of the loaded series. */
interface Bound {
  series: Series;
  signal: number;
  /** Per-frame x in `[0, 1]` over the series' full time extent. */
  readonly xnorm: Float32Array;
  /** Committed frame count. Frames at and beyond this frontier are provisional. */
  validFrames: number;
  /** Finite extent of the committed frames of `signal`, or null when none is finite. */
  extent: Domain | null;
  /** The selected element's committed values, gathered once and grown with the frontier. */
  readonly focus: Float32Array;
}

/** Segment range [from, to) queued for chunked painting onto the history texture. */
interface PaintJob {
  from: number;
  to: number;
  cursor: number;
}

interface BackingSize {
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
}

/** Everything that exists only while a canvas is bound: the lease, the painter, and paint progress. */
interface Binding {
  readonly generation: number;
  readonly canvas: HTMLCanvasElement;
  readonly presentation: Presentation<HTMLCanvasElement>;
  readonly painter: LanePainter;
  readonly lifecycle: Lifecycle;
  released: boolean;
  rafId: number | null;
  pendingSize: BackingSize | null;
  backingScale: number;
  windowFrames: number;
  /** Window index whose slab is resident on the GPU; -1 forces re-upload. */
  residentWindow: number;
  job: PaintJob | null;
  /** Frames whose segments have been queued onto the history texture. */
  painted: number;
  presentDirty: boolean;
  cursor: { readonly x: number; readonly y: number } | null;
  cursorDirty: boolean;
}

/**
 * Creates a WebGPU monitor controller.
 *
 * @param options - Initial display options and the device pool `attach` leases from.
 * @returns A controller for loading series data, attaching canvases, and subscribing to readings.
 * @throws TypeError or RangeError when any option is invalid; whatever the colormap throws.
 *
 * @example
 * ```ts
 * const monitor = createMonitor({ valueRange: [0, 1] });
 * monitor.load(series, 0);
 * await monitor.attach(canvas);
 * ```
 *
 * The controller owns its renderer resources and the device lease it holds while attached, but
 * never the canvas. Detach or destroy the controller before removing its canvas.
 */
export function createMonitor(options: Options = {}): Monitor {
  const resolved = resolveOptions(options);
  const events = createEmitter<Events>();

  let colormapLut = bakeColormap(resolved.colormap);
  let lineWidthPx = resolved.lineWidthPx;
  let valueRange: Domain | null = resolved.valueRange;
  let valueDomain: Domain = normalizeDomain(valueRange);
  let timeRange: Domain | null = resolved.timeRange;
  let focusColor: RGBA | null = resolved.focusColor;
  let unselectedAlpha = resolved.unselectedAlpha;

  let bound: Bound | null = null;
  let selected: number | null = null;
  let lastReading: Reading | null = null;
  let consumerPaused = false;
  let destroyed = false;
  let generation = 0;
  let binding: Binding | null = null;

  /** The value domain that drives y and color together: pinned, or the signal's committed extent. */
  function resolveValueDomain(): Domain {
    if (valueRange) return normalizeDomain(valueRange);
    if (!bound) return [0, 1];
    const { series, signal } = bound;
    if (series.ranges)
      return normalizeDomain([series.ranges[signal * 2]!, series.ranges[signal * 2 + 1]!]);
    return normalizeDomain(bound.extent);
  }

  /**
   * The time window as an affine map over the normalized axis: `x = (xnorm - timeMin) * timeScale`.
   * Identity without a pinned window or a series.
   */
  function resolveTimeMap(): readonly [min: number, scale: number] {
    if (!timeRange || !bound) return [0, 1];
    const { time } = bound.series;
    const t0 = time[0]!;
    const span = time[time.length - 1]! - t0 || 1;
    const [from, to] = timeRange;
    return [(from - t0) / span, span / Math.max(to - from, 1e-9)];
  }

  /** Adopt the resolved value domain; true when it moved. */
  function refreshValueDomain(): boolean {
    const next = resolveValueDomain();
    if (next[0] === valueDomain[0] && next[1] === valueDomain[1]) return false;
    valueDomain = next;
    return true;
  }

  /** Gather the selected element's values for frames [from, to) into the focus trace. */
  function gatherFocus(state: Bound, from: number, to: number): void {
    if (selected === null) return;
    const { series, signal, focus } = state;
    const elements = series.elementCount;
    const base = signal * series.time.length * elements + selected;
    for (let frame = from; frame < to; frame++)
      focus[frame] = series.values[base + frame * elements]!;
  }

  function writeUniforms(entry: Binding): void {
    const { painter } = entry;
    const [min, max] = valueDomain;
    const [timeMin, timeScale] = resolveTimeMap();
    const base = {
      viewportX: painter.width,
      viewportY: painter.height,
      valueMin: min,
      valueScale: 1 / (max - min),
      timeMin,
      timeScale,
      focusColor: focusColor ?? ([0, 0, 0, -1] as const),
      alpha: selected === null ? 1 : unselectedAlpha,
    };
    painter.writeUniform('history', {
      ...base,
      lineWidth: lineWidthPx * entry.backingScale,
      elementCount: bound?.series.elementCount ?? 1,
    });
    painter.writeUniform('focus', {
      ...base,
      lineWidth: lineWidthPx * entry.backingScale * 2.5,
      elementCount: 1,
    });
  }

  /** Upload focus-trace frames [from, to) when an element is selected. */
  function uploadFocus(entry: Binding, from: number, to: number): void {
    if (!bound || selected === null || to <= from) return;
    entry.painter.uploadFocus(bound.focus.subarray(from, to), bound.xnorm.subarray(from, to), from);
  }

  /** Blank the history and queue the committed trajectory: [0, validFrames - 1). */
  function scheduleRepaint(entry: Binding): void {
    if (!bound) return;
    entry.painter.clearHistory();
    const segments = Math.max(0, bound.validFrames - 1);
    entry.job = segments > 0 ? { from: 0, to: segments, cursor: 0 } : null;
    entry.residentWindow = -1;
    entry.painted = bound.validFrames;
    entry.presentDirty = true;
    schedule(entry);
  }

  /** Queue segments [fromSeg, toSeg) without clearing. */
  function scheduleAppend(entry: Binding, fromSeg: number, toSeg: number): void {
    if (toSeg <= fromSeg) return;
    const { job } = entry;
    if (job) {
      job.from = Math.min(job.from, fromSeg);
      job.to = Math.max(job.to, toSeg);
      job.cursor = Math.min(job.cursor, fromSeg);
    } else {
      entry.job = { from: fromSeg, to: toSeg, cursor: fromSeg };
    }
    entry.residentWindow = -1;
    schedule(entry);
  }

  /** Paint up to SEGMENT_BUDGET instances of the queued job this frame. */
  function paintChunk(entry: Binding): boolean {
    if (!bound || !entry.job) return false;
    const { series, xnorm, validFrames } = bound;
    if (validFrames <= 1) {
      entry.job = null;
      return false;
    }
    const { painter, windowFrames } = entry;
    const elementCount = series.elementCount;
    const segmentsPerWindow = windowFrames - 1;
    const signalBase = bound.signal * elementCount * series.time.length;
    let budget = SEGMENT_BUDGET;
    let progressed = false;

    while (entry.job && budget > 0) {
      const job = entry.job;
      const seg = job.cursor;
      const windowIndex = Math.floor(seg / segmentsPerWindow);
      const firstFrame = windowIndex * segmentsPerWindow;
      const lastFrame = Math.min(firstFrame + windowFrames, validFrames);
      if (entry.residentWindow !== windowIndex) {
        painter.uploadWindow(
          series.values.subarray(
            signalBase + firstFrame * elementCount,
            signalBase + lastFrame * elementCount,
          ),
          xnorm.subarray(firstFrame, lastFrame),
        );
        entry.residentWindow = windowIndex;
      }
      const windowSegEnd = Math.min(lastFrame - 1, job.to);
      const budgetSegs = Math.floor(budget / elementCount);
      if (budgetSegs === 0 && progressed) break;
      const segCount = Math.max(1, Math.min(windowSegEnd - seg, budgetSegs));
      painter.drawHistory(segCount * elementCount, (seg - firstFrame) * elementCount);
      job.cursor += segCount;
      budget -= segCount * elementCount;
      progressed = true;
      if (job.cursor >= job.to) entry.job = null;
    }
    return progressed;
  }

  function focusInstances(): number {
    if (!bound || selected === null) return 0;
    return Math.max(0, bound.validFrames - 1);
  }

  function scanReading(entry: Binding): Reading | null {
    if (!bound || !entry.cursor || bound.validFrames <= 0) return null;
    const rect = entry.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = clamp01((entry.cursor.x - rect.left) / rect.width);
    const y = clamp01((entry.cursor.y - rect.top) / rect.height);
    const { series, signal, validFrames } = bound;
    const { time } = series;
    // The cursor sits on the windowed axis; map it back to the series' full span.
    const [timeMin, timeScale] = resolveTimeMap();
    const xnorm = timeMin + x / timeScale;
    if (xnorm < 0 || xnorm > 1) return null;
    const t = time[0]! + xnorm * (time[time.length - 1]! - time[0]!);
    const frame = frameAt(time, t);
    if (frame >= validFrames) return null;
    const values = sample(series, signal, frame);
    const [min, max] = valueDomain;
    const scale = 1 / (max - min);
    let best = -1;
    let bestDist = Infinity;
    for (let element = 0; element < values.length; element++) {
      const value = values[element]!;
      if (Number.isNaN(value)) continue;
      const dist = Math.abs(1 - (value - min) * scale - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = element;
      }
    }
    if (best < 0) return null;
    return { signal, element: best, frame, t: time[frame]!, value: values[best]!, x, y };
  }

  function emitHover(entry: Binding): void {
    const reading = scanReading(entry);
    if (sameReading(reading, lastReading)) return;
    lastReading = reading;
    events.emit('hover', reading);
  }

  function schedule(entry: Binding): void {
    if (entry.released || consumerPaused || entry.rafId !== null) return;
    entry.rafId = requestAnimationFrame(() => tick(entry));
  }

  function tick(entry: Binding): void {
    entry.rafId = null;
    if (entry.released || consumerPaused) return;
    const { painter, presentation, canvas } = entry;
    if (entry.pendingSize) {
      const size = entry.pendingSize;
      entry.pendingSize = null;
      const resized = presentation.resize(size.width, size.height);
      const nextScale = fittedBackingScale(canvas, size);
      const scaleChanged = nextScale !== entry.backingScale;
      entry.backingScale = nextScale;
      if (resized) painter.resize(canvas.width, canvas.height);
      if (resized || scaleChanged) {
        if (bound) {
          writeUniforms(entry);
          scheduleRepaint(entry);
        } else {
          entry.presentDirty = true;
        }
      }
    }
    const progressed = paintChunk(entry);
    if (progressed || entry.presentDirty) {
      entry.presentDirty = false;
      painter.present(focusInstances());
    }
    if (entry.cursorDirty) {
      entry.cursorDirty = false;
      emitHover(entry);
    }
    if (entry.job || entry.presentDirty || entry.cursorDirty) schedule(entry);
  }

  /** Select without emitting; the caller has validated `next`. */
  function applySelection(next: number | null): void {
    if (next === selected) return;
    const dimmed = (selected === null) !== (next === null) && unselectedAlpha !== 1;
    selected = next;
    if (bound) gatherFocus(bound, 0, bound.validFrames);
    const entry = binding;
    if (!entry) return;
    if (bound) uploadFocus(entry, 0, bound.validFrames);
    if (dimmed && bound) {
      // The history texture carries the trace alpha, so a dimming change repaints it.
      writeUniforms(entry);
      scheduleRepaint(entry);
      return;
    }
    entry.presentDirty = true;
    schedule(entry);
  }

  /** Build every device-bound collaborator for one attach; on any failure nothing is kept. */
  function bind(lease: DeviceLease, canvas: HTMLCanvasElement, own: number): Binding {
    const lifecycle = createLifecycle();
    // Registered first, so it runs last: nothing outlives the lease it paints on.
    lifecycle.add(() => lease.release());
    try {
      const presentation = createPresentation(lease.device, canvas, {
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      });
      lifecycle.add(() => presentation.destroy());

      let entry: Binding | null = null;
      let initial: BackingSize | null = null;
      lifecycle.add(
        presentation.observe((width, height, ratio) => {
          const size = { width: Math.max(1, width), height: Math.max(1, height), ratio };
          if (!entry) {
            initial = size;
            return;
          }
          entry.pendingSize = size;
          schedule(entry);
        }),
      );
      const size: BackingSize = initial ?? {
        width: Math.max(1, canvas.width),
        height: Math.max(1, canvas.height),
        ratio: 1,
      };
      presentation.resize(size.width, size.height);
      const painter = new LanePainter(presentation, canvas.width, canvas.height);
      lifecycle.add(() => painter.destroy());

      const built: Binding = {
        generation: own,
        canvas,
        presentation,
        painter,
        lifecycle,
        released: false,
        rafId: null,
        pendingSize: null,
        backingScale: fittedBackingScale(canvas, size),
        windowFrames: 2,
        residentWindow: -1,
        job: null,
        painted: 0,
        presentDirty: false,
        cursor: null,
        cursorDirty: false,
      };
      entry = built;

      const onPointerMove = (event: PointerEvent): void => {
        built.cursor = { x: event.clientX, y: event.clientY };
        built.cursorDirty = true;
        schedule(built);
      };
      const onPointerLeave = (): void => {
        built.cursor = null;
        built.cursorDirty = true;
        schedule(built);
      };
      const onPointerDown = (event: PointerEvent): void => {
        built.cursor = { x: event.clientX, y: event.clientY };
        const reading = scanReading(built);
        if (!reading) return;
        applySelection(reading.element);
        events.emit('select', reading);
      };
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerleave', onPointerLeave);
      canvas.addEventListener('pointerdown', onPointerDown);
      lifecycle.add(() => {
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerleave', onPointerLeave);
        canvas.removeEventListener('pointerdown', onPointerDown);
      });

      lifecycle.add(forwardDeviceLoss(lease.device, (info) => recover(own, info)));
      // Registered last, so it runs first: every callback goes inert before resources go.
      lifecycle.add(() => {
        built.released = true;
        if (built.rafId !== null) cancelAnimationFrame(built.rafId);
        built.rafId = null;
      });
      return built;
    } catch (error) {
      lifecycle.destroy();
      throw error;
    }
  }

  /** Push every retained state into a freshly bound painter. */
  function replayInto(entry: Binding): void {
    entry.painter.writeColormap(colormapLut);
    if (!bound) return;
    const { series } = bound;
    entry.windowFrames = framesPerWindow(
      series.elementCount,
      entry.painter.windowValueCapacity * 4,
    );
    entry.painter.reserve(series.elementCount, entry.windowFrames, series.time.length);
    writeUniforms(entry);
    uploadFocus(entry, 0, bound.validFrames);
    scheduleRepaint(entry);
  }

  /** Release the current binding, if any, and say so. */
  function release(): void {
    const entry = binding;
    if (!entry) return;
    binding = null;
    lastReading = null;
    entry.lifecycle.destroy();
    if (!destroyed) events.emit('attached', false);
  }

  /** A device the platform lost: release it, say so, and lease a replacement. */
  function recover(own: number, info: GPUDeviceLostInfo): void {
    const entry = binding;
    if (!entry || entry.generation !== own || destroyed) return;
    const { canvas } = entry;
    release();
    events.emit('deviceLost', {
      reason: info.reason ?? 'unknown',
      message: info.message || 'WebGPU device was lost',
      recovering: true,
    });
    api.attach(canvas).catch((error: unknown) => {
      // A newer attach or a detach overtook the recovery; it owns the outcome now.
      if (isAbortError(error) || destroyed) return;
      events.emit('deviceLost', {
        reason: 'unavailable',
        message: describe(error),
        recovering: false,
      });
    });
  }

  function requireBound(operation: string): Bound {
    if (!bound) throw new Error(`monitor: ${operation} before load`);
    return bound;
  }

  const api: Monitor = {
    get attached() {
      return binding !== null;
    },

    on(event, handler) {
      return events.on(event, handler);
    },

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
        replayInto(entry);
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

    load(series, signal = 0) {
      if (destroyed) return;
      validateSeries(series, signal);
      const frames = series.time.length;
      const committed = clampFrameCount(series.validFrames ?? frames, frames);
      const xnorm = new Float32Array(frames);
      const t0 = series.time[0]!;
      const span = frames > 1 ? series.time[frames - 1]! - t0 : 1;
      const scale = span > 0 ? 1 / span : 0;
      for (let frame = 0; frame < frames; frame++)
        xnorm[frame] = (series.time[frame]! - t0) * scale;
      const state: Bound = {
        series,
        signal,
        xnorm,
        validFrames: committed,
        extent: null,
        focus: new Float32Array(frames),
      };
      state.extent = committedExtent(state, 0, committed);
      bound = state;
      if (selected !== null && selected >= series.elementCount) selected = null;
      gatherFocus(state, 0, committed);
      refreshValueDomain();
      if (binding) replayInto(binding);
    },

    extend(validFrames, values) {
      if (destroyed) return;
      const state = requireBound('extend');
      const replaced = values !== undefined;
      if (values) {
        if (values.length !== state.series.values.length) {
          throw new Error(
            `monitor: extend values length ${values.length}, expected ${state.series.values.length}`,
          );
        }
        state.series = { ...state.series, values };
      }
      const from = state.validFrames;
      const to = clampFrameCount(validFrames, state.series.time.length);
      if (to <= from && !replaced) return;
      state.validFrames = Math.max(from, to);
      const start = replaced ? 0 : from;
      state.extent = replaced
        ? committedExtent(state, 0, state.validFrames)
        : mergeExtent(state.extent, committedExtent(state, from, state.validFrames));
      gatherFocus(state, start, state.validFrames);
      const domainMoved = refreshValueDomain();

      const entry = binding;
      if (!entry) return;
      if (domainMoved) {
        writeUniforms(entry);
        uploadFocus(entry, 0, state.validFrames);
        scheduleRepaint(entry);
        return;
      }
      uploadFocus(entry, start, state.validFrames);
      const fromSeg = Math.max(0, entry.painted - 1);
      entry.painted = state.validFrames;
      scheduleAppend(entry, fromSeg, Math.max(fromSeg, state.validFrames - 1));
      entry.presentDirty = true;
      schedule(entry);
    },

    setSignal(signal) {
      if (destroyed) return;
      const state = requireBound('setSignal');
      const count = state.series.signalCount;
      if (!Number.isInteger(signal) || signal < 0 || signal >= count) {
        throw new Error(`monitor: signal ${signal} out of [0, ${count})`);
      }
      if (signal === state.signal) return;
      state.signal = signal;
      state.extent = committedExtent(state, 0, state.validFrames);
      gatherFocus(state, 0, state.validFrames);
      refreshValueDomain();
      const entry = binding;
      if (!entry) return;
      writeUniforms(entry);
      uploadFocus(entry, 0, state.validFrames);
      scheduleRepaint(entry);
    },

    setOptions(patch) {
      if (destroyed) return;
      validateOptions(patch);
      // Sample the colormap before anything is applied: caller code may throw.
      const lut = patch.colormap === undefined ? null : bakeColormap(patch.colormap);
      let uniformsDirty = false;
      let repaint = false;
      let present = false;
      for (const [key, definition] of Object.entries(OPTIONS)) {
        if (!definition.live || patch[key as keyof Options] === undefined) continue;
        switch (key as keyof Options) {
          case 'colormap':
            colormapLut = lut!;
            repaint = true;
            break;
          case 'lineWidthPx':
            if (patch.lineWidthPx === lineWidthPx) break;
            lineWidthPx = patch.lineWidthPx!;
            uniformsDirty = true;
            repaint = true;
            break;
          case 'valueRange':
            valueRange = own(patch.valueRange!);
            if (refreshValueDomain()) {
              uniformsDirty = true;
              repaint = true;
            }
            break;
          case 'timeRange':
            timeRange = own(patch.timeRange!);
            uniformsDirty = true;
            repaint = true;
            break;
          case 'focusColor':
            focusColor = own(patch.focusColor!);
            uniformsDirty = true;
            present = true;
            break;
          case 'unselectedAlpha':
            if (patch.unselectedAlpha === unselectedAlpha) break;
            unselectedAlpha = patch.unselectedAlpha!;
            if (selected !== null) {
              uniformsDirty = true;
              repaint = true;
            }
            break;
          case 'devices':
            break;
        }
      }
      const entry = binding;
      if (!entry) return;
      if (lut) entry.painter.writeColormap(lut);
      if (uniformsDirty) writeUniforms(entry);
      if (repaint && bound) scheduleRepaint(entry);
      else if (present) {
        entry.presentDirty = true;
        schedule(entry);
      }
    },

    select(element) {
      if (destroyed) return;
      const next = element === null ? null : Math.floor(element);
      if (next !== null && (!bound || !(next >= 0 && next < bound.series.elementCount))) return;
      applySelection(next);
    },

    clear() {
      if (destroyed) return;
      bound = null;
      selected = null;
      lastReading = null;
      const entry = binding;
      if (!entry) return;
      entry.job = null;
      entry.residentWindow = -1;
      entry.painted = 0;
      entry.painter.releaseSlabs();
      entry.painter.clearHistory();
      entry.presentDirty = true;
      schedule(entry);
    },

    pause() {
      consumerPaused = true;
      const entry = binding;
      if (!entry || entry.rafId === null) return;
      cancelAnimationFrame(entry.rafId);
      entry.rafId = null;
    },

    resume() {
      if (destroyed || !consumerPaused) return;
      consumerPaused = false;
      if (binding) schedule(binding);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      release();
      bound = null;
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

/** The line-width scale that keeps CSS pixels honest after the device limit shrinks the backing. */
function fittedBackingScale(canvas: HTMLCanvasElement, size: BackingSize): number {
  return size.ratio * Math.min(canvas.width / size.width, canvas.height / size.height);
}

function validateSeries(series: Series, signal: number): void {
  const frames = series.time.length;
  if (frames < 1) throw new Error('monitor: series time must include at least one frame');
  if (!Number.isInteger(series.elementCount) || series.elementCount <= 0) {
    throw new Error('monitor: elementCount must be a positive integer');
  }
  if (!Number.isInteger(series.signalCount) || series.signalCount <= 0) {
    throw new Error('monitor: signalCount must be a positive integer');
  }
  if (!Number.isInteger(signal) || signal < 0 || signal >= series.signalCount) {
    throw new Error(`monitor: signal ${signal} out of [0, ${series.signalCount})`);
  }
  const expected = series.signalCount * frames * series.elementCount;
  if (series.values.length !== expected) {
    throw new Error(`monitor: values length ${series.values.length}, expected ${expected}`);
  }
  if (series.ranges && series.ranges.length < series.signalCount * 2) {
    throw new Error(
      `monitor: ranges length ${series.ranges.length}, expected at least ${series.signalCount * 2}`,
    );
  }
  if (series.validFrames !== undefined && !Number.isFinite(series.validFrames)) {
    throw new Error('monitor: validFrames must be finite');
  }
}

/** Finite extent of the displayed signal over frames [from, to), or null when none is finite. */
function committedExtent(state: Bound, from: number, to: number): Domain | null {
  if (to <= from) return null;
  const { series, signal } = state;
  const elements = series.elementCount;
  const base = signal * series.time.length * elements;
  return extent(series.values.subarray(base + from * elements, base + to * elements));
}

function mergeExtent(a: Domain | null, b: Domain | null): Domain | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampFrameCount(n: number, frames: number): number {
  if (!Number.isFinite(n)) return frames;
  return Math.min(Math.max(0, Math.floor(n)), frames);
}

function normalizeDomain(range: Domain | null): Domain {
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
