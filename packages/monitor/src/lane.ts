import {
  normalizeDomain,
  position,
  validateDomain,
  type Domain,
  type RGBA,
  type Series,
} from '@latkit/model';
import type { Reading } from './monitor.js';
import { LanePainter, SEGMENT_BUDGET } from './painter.js';

type Window = Parameters<Series['read']>[1];
type Block = Awaited<ReturnType<Series['read']>>;
export interface Style {
  timeRange: Domain | null;
  valueRange: Domain | null;
  colorRange: Domain | null;
  lineWidth: number;
  focusColor: RGBA | null;
  unselectedAlpha: number;
}
/** CPU metadata retained across canvas/device changes. */
export interface Scan {
  frames: number;
  range: Domain | null;
}
/** What a lane reports to its host. */
export interface LaneEvents {
  error(error: Error): void;
  range(range: Domain): void;
  /** The latest committed history and selected trace have been presented. */
  rendered(): void;
  /** The lane has new work to show; the host calls `frame()` on its next frame. */
  present(): void;
}
const READ_BYTES = 1024 * 1024;
const FOCUS_FRAMES = 65536;

/** One series scheduler. Construction does not read or submit GPU work. */
export class Lane {
  readonly #series: Series;
  readonly #signalIndex: number;
  readonly #painter: LanePainter;
  readonly #scan: Scan;
  readonly #events: LaneEvents;
  readonly #elements: number;
  readonly #frames: number;
  readonly #focusFrames: number;
  readonly #values: Float32Array;
  readonly #time: Float32Array;
  readonly #focusValues: Float32Array;
  readonly #focusTime: Float32Array;
  #style: Style;
  #range: Domain = [0, 1];
  #domain: Domain = [0, 1];
  #colors: Domain = [0, 1];
  #state: Series['state'];
  #paused = true;
  #destroyed = false;
  #pending = true;
  #repaint = true;
  #focusRepaint = true;
  #painted = 0;
  #focused = 0;
  #selected: number | null = null;
  #resolving: AbortController | null = null;
  #history: AbortController | null = null;
  #focus: AbortController | null = null;
  #wanted = false;
  #version = 0;
  #reported = -1;

  constructor(
    series: Series,
    signalIndex: number,
    painter: LanePainter,
    style: Style,
    scan: Scan,
    events: LaneEvents,
  ) {
    this.#series = series;
    this.#signalIndex = signalIndex;
    this.#painter = painter;
    this.#style = style;
    this.#scan = scan;
    this.#events = events;
    this.#state = series.state;
    this.#elements = Math.max(
      1,
      Math.min(
        series.elementCount,
        Math.floor(painter.windowValueCapacity / 2),
        Math.floor((READ_BYTES - 16) / 16),
      ),
    );
    this.#frames = Math.max(
      2,
      Math.min(
        Math.floor(READ_BYTES / (8 + 8 * this.#elements)),
        Math.floor(painter.windowValueCapacity / this.#elements),
        65536,
      ),
    );
    this.#focusFrames = Math.max(2, Math.min(FOCUS_FRAMES, painter.windowValueCapacity));
    this.#values = new Float32Array(this.#elements * this.#frames * 2);
    this.#time = new Float32Array(this.#frames);
    this.#focusValues = new Float32Array(this.#focusFrames * 2);
    this.#focusTime = new Float32Array(this.#focusFrames);
    painter.reserve(this.#elements, this.#frames, this.#focusFrames);
  }

  update(): void {
    this.#pending = true;
    this.#version++;
    if (this.#paused || this.#resolving || this.#destroyed) return;
    const job = new AbortController();
    this.#resolving = job;
    this.#pending = false;
    let resolved = false;
    void this.#resolve(job.signal)
      .then(() => {
        resolved = true;
      })
      .catch((error) => this.#report(error, job.signal))
      .finally(() => {
        if (this.#resolving !== job) return;
        this.#resolving = null;
        if (this.#pending) this.update();
        else if (resolved) {
          this.#startFocus();
          this.#startHistory();
          this.#present();
        }
      });
  }

  async #resolve(signal: AbortSignal): Promise<void> {
    const state = this.#series.state;
    if (!Number.isSafeInteger(state.frameCount) || state.frameCount < this.#state.frameCount)
      throw new RangeError('series committed frame count must not decrease');
    if (state.timeRange) validateDomain(state.timeRange, 'series timeRange');
    if (!this.#style.valueRange && !state.ranges && state.frameCount > this.#scan.frames) {
      let min = this.#scan.range?.[0] ?? Infinity,
        max = this.#scan.range?.[1] ?? -Infinity;
      let reads = 0;
      for (let f = this.#scan.frames; f < state.frameCount; f += this.#frames)
        for (let e = 0; e < this.#series.elementCount; e += this.#elements) {
          const window = {
            frameOffset: f,
            frameCount: Math.min(this.#frames, state.frameCount - f),
            elementOffset: e,
            elementCount: Math.min(this.#elements, this.#series.elementCount - e),
          };
          const block = await this.#read(window, signal);
          if (++reads % 4 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            signal.throwIfAborted();
          }
          for (let row = 0; row < window.frameCount; row++)
            for (let column = 0; column < window.elementCount; column++) {
              const value = block.values[row * block.stride + column]!;
              if (Number.isFinite(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
              }
            }
        }
      signal.throwIfAborted();
      this.#scan.frames = state.frameCount;
      this.#scan.range = min <= max ? [min, max] : null;
    }
    signal.throwIfAborted();
    const recorded: Domain | null = state.ranges
      ? [state.ranges[this.#signalIndex * 2]!, state.ranges[this.#signalIndex * 2 + 1]!]
      : this.#scan.range;
    const range = normalizeDomain(this.#style.timeRange ?? state.timeRange);
    const domain = normalizeDomain(this.#style.valueRange ?? recorded);
    const colors = normalizeDomain(this.#style.colorRange ?? domain);
    const changed =
      !equal(range, this.#range) || !equal(domain, this.#domain) || !equal(colors, this.#colors);
    const domainChanged = !equal(domain, this.#domain);
    this.#range = range;
    this.#domain = domain;
    this.#colors = colors;
    this.#state = state;
    if (changed || this.#repaint) {
      this.#history?.abort();
      this.#history = null;
      this.#focus?.abort();
      this.#focus = null;
      this.#painted = this.#focused = 0;
      this.#painter.clearHistory();
      this.#painter.clearFocus();
      this.#repaint = false;
      this.#focusRepaint = false;
    }
    if (domainChanged || this.#reported < 0) this.#events.range(domain);
  }

  #startHistory(): void {
    if (
      this.#paused ||
      this.#destroyed ||
      this.#resolving ||
      this.#history ||
      this.#painted >= this.#state.frameCount
    )
      return;
    const job = new AbortController(),
      count = this.#state.frameCount;
    this.#history = job;
    void this.#draw(false, Math.max(0, this.#painted - 1), count, job.signal)
      .then(() => {
        if (this.#history === job && !job.signal.aborted) this.#painted = count;
      })
      .catch((error) => this.#report(error, job.signal))
      .finally(() => {
        if (this.#history !== job) return;
        this.#history = null;
        // A failure stops until a new update; successful work may have an appended tail.
        if (this.#painted === count) this.#startHistory();
        this.#present();
      });
  }
  #startFocus(): void {
    if (this.#paused || this.#destroyed || this.#resolving || this.#focus) return;
    if (this.#focusRepaint) {
      this.#painter.clearFocus();
      this.#focused = 0;
      this.#focusRepaint = false;
    }
    if (this.#selected === null || this.#focused >= this.#state.frameCount) return;
    const job = new AbortController(),
      count = this.#state.frameCount;
    this.#focus = job;
    void this.#draw(true, Math.max(0, this.#focused - 1), count, job.signal)
      .then(() => {
        if (this.#focus === job && !job.signal.aborted) this.#focused = count;
      })
      .catch((error) => this.#report(error, job.signal))
      .finally(() => {
        if (this.#focus !== job) return;
        this.#focus = null;
        if (this.#focused === count) this.#startFocus();
        this.#present();
      });
  }

  async #read(window: Window, signal: AbortSignal): Promise<Block> {
    signal.throwIfAborted();
    const block = await this.#series.read(this.#signalIndex, window, signal);
    signal.throwIfAborted();
    const required =
      window.frameCount && window.elementCount
        ? (window.frameCount - 1) * block.stride + window.elementCount
        : 0;
    if (
      !(block.time instanceof Float64Array) ||
      !(block.values instanceof Float32Array || block.values instanceof Float64Array) ||
      !Number.isSafeInteger(block.stride) ||
      block.stride < window.elementCount ||
      block.time.length !== window.frameCount ||
      block.values.length < required
    )
      throw new RangeError('series returned an invalid sample block');
    for (let i = 0; i < block.time.length; i++)
      if (!Number.isFinite(block.time[i]) || (i && block.time[i]! < block.time[i - 1]!))
        throw new RangeError('series time must be finite and nondecreasing');
    return block;
  }

  *#windows(from: number, to: number, focus: boolean): Generator<Window> {
    const frames = focus ? this.#focusFrames : this.#frames;
    for (let f = from; f < to - 1; f += frames - 1)
      for (let e = 0; e < (focus ? 1 : this.#series.elementCount); e += this.#elements)
        yield {
          frameOffset: f,
          frameCount: Math.min(frames, to - f),
          elementOffset: focus ? this.#selected! : e,
          elementCount: focus ? 1 : Math.min(this.#elements, this.#series.elementCount - e),
        };
  }

  async #draw(focus: boolean, from: number, count: number, signal: AbortSignal): Promise<void> {
    const [start, end] = await this.#series.locate(this.#range, count, signal);
    signal.throwIfAborted();
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > count
    )
      throw new RangeError('series returned invalid time bounds');
    const windows = this.#windows(Math.max(from, start - 1, 0), Math.min(count, end + 1), focus);
    let next = windows.next();
    let pending = next.done ? null : this.#read(next.value, signal);
    let submitted = 0,
      segments = 0;
    while (!next.done && pending) {
      const window = next.value;
      const block = await pending;
      signal.throwIfAborted();
      next = windows.next();
      pending = next.done ? null : this.#read(next.value, signal);
      // Prefetched work can reject while the current submission is yielding.
      void pending?.catch(() => {});
      const values = focus ? this.#focusValues : this.#values;
      const time = focus ? this.#focusTime : this.#time;
      for (let f = 0; f < window.frameCount; f++) {
        time[f] = finiteCoordinate(position(block.time[f]!, this.#range));
        for (let e = 0; e < window.elementCount; e++) {
          const value = block.values[f * block.stride + e]!;
          const at = (f * window.elementCount + e) * 2;
          values[at] = finiteCoordinate(position(value, this.#domain));
          values[at + 1] = finiteCoordinate(position(value, this.#colors));
        }
      }
      this.#painter.writeUniform(focus ? 'focus' : 'history', {
        viewportX: this.#painter.width,
        viewportY: this.#painter.height,
        lineWidth: this.#style.lineWidth * (focus ? 2.5 : 1),
        elementCount: window.elementCount,
        focusColor: this.#style.focusColor ?? [0, 0, 0, -1],
      });
      const data = values.subarray(0, window.frameCount * window.elementCount * 2);
      const axis = time.subarray(0, window.frameCount);
      const instances = (window.frameCount - 1) * window.elementCount;
      if (focus) {
        this.#painter.uploadFocus(data, axis);
        this.#painter.drawFocus(instances);
      } else {
        this.#painter.uploadWindow(data, axis);
        this.#painter.drawHistory(instances);
      }
      this.#present();
      segments += instances;
      if (++submitted >= 4 || segments >= SEGMENT_BUDGET) {
        // Bounded GPU batches, with source prefetch overlapped across the wait.
        await this.#painter.device.queue.onSubmittedWorkDone();
        signal.throwIfAborted();
        await yieldFrame(signal);
        submitted = segments = 0;
      }
    }
  }

  #present(): void {
    if (this.#paused || this.#destroyed) return;
    // Wakes coalesce in the host's frame loop, so every request forwards.
    this.#wanted = true;
    this.#events.present();
  }

  /**
   * Composite onto the canvas when the lane asked to since its last frame, and report `rendered`
   * once everything committed is drawn. The host's frame loop calls this.
   */
  frame(): void {
    if (!this.#wanted || this.#paused || this.#destroyed) return;
    this.#wanted = false;
    this.#painter.present(this.#selected === null ? 1 : this.#style.unselectedAlpha);
    if (
      !this.#resolving &&
      !this.#history &&
      !this.#focus &&
      this.#painted >= this.#state.frameCount &&
      (this.#selected === null || this.#focused >= this.#state.frameCount) &&
      this.#reported !== this.#version
    ) {
      this.#reported = this.#version;
      this.#events.rendered();
    }
  }

  select(element: number | null): void {
    const selected = element === null ? null : storedElement(this.#series, element);
    if (selected === this.#selected) return;
    this.#selected = selected;
    this.#version++;
    this.#focus?.abort();
    this.#focus = null;
    this.#focusRepaint = true;
    this.#startFocus();
    this.#present();
  }
  setStyle(style: Style, repaint = false): void {
    const previous = this.#style;
    this.#style = style;
    this.#version++;
    const geometry =
      repaint ||
      !equal(previous.timeRange, style.timeRange) ||
      !equal(previous.valueRange, style.valueRange) ||
      !equal(previous.colorRange, style.colorRange) ||
      previous.lineWidth !== style.lineWidth;
    if (geometry) {
      this.#resolving?.abort();
      this.#resolving = null;
      this.#history?.abort();
      this.#history = null;
      this.#focus?.abort();
      this.#focus = null;
      this.#repaint = true;
      this.update();
    } else {
      if (!equal(previous.focusColor, style.focusColor)) {
        this.#focus?.abort();
        this.#focus = null;
        this.#focusRepaint = true;
        this.#startFocus();
      }
      this.#present();
    }
  }
  async reading(x: number, y: number, signal: AbortSignal): Promise<Reading | null> {
    const state = this.#state,
      domain = this.#domain;
    const t = this.#range[0] * (1 - x) + this.#range[1] * x;
    const [, end] = await this.#series.locate([t, t], state.frameCount, signal);
    signal.throwIfAborted();
    const frame = end - 1;
    if (frame < 0 || frame >= state.frameCount) return null;
    let best: Reading | null = null,
      distance = Infinity;
    for (let e = 0; e < this.#series.elementCount; e += this.#elements) {
      const count = Math.min(this.#elements, this.#series.elementCount - e);
      const block = await this.#read(
        { frameOffset: frame, frameCount: 1, elementOffset: e, elementCount: count },
        signal,
      );
      for (let i = 0; i < count; i++) {
        const value = block.values[i]!;
        if (!Number.isFinite(value)) continue;
        const d = Math.abs(1 - position(value, domain) - y);
        if (d < distance) {
          distance = d;
          best = {
            signal: this.#signalIndex,
            frame,
            element: this.#series.elements?.[e + i] ?? e + i,
            t: block.time[0]!,
            value,
            x,
            y,
          };
        }
      }
    }
    return best;
  }
  pause(): void {
    this.#paused = true;
    this.#resolving?.abort();
    this.#resolving = null;
    this.#history?.abort();
    this.#history = null;
    this.#focus?.abort();
    this.#focus = null;
    this.#repaint = true;
    this.#wanted = false;
  }
  resume(): void {
    if (!this.#destroyed) {
      this.#paused = false;
      this.update();
    }
  }
  destroy(): void {
    this.pause();
    this.#destroyed = true;
  }
  #report(error: unknown, signal: AbortSignal): void {
    if (signal.aborted || this.#destroyed) return;
    this.#repaint = true;
    this.#events.error(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Map a class index to a stored column without scanning a sparse element axis. */
export function storedElement(series: Series, element: number): number | null {
  if (!series.elements) return element >= 0 && element < series.elementCount ? element : null;
  let lo = 0,
    hi = series.elements.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (series.elements[mid]! < element) lo = mid + 1;
    else hi = mid;
  }
  return series.elements[lo] === element ? lo : null;
}
function equal(a: readonly number[] | null, b: readonly number[] | null): boolean {
  return a === b || (!!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]));
}
function finiteCoordinate(value: number): number {
  return Number.isNaN(value) ? NaN : Math.max(-1e30, Math.min(1e30, value));
}
function yieldFrame(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = requestAnimationFrame(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
    const abort = () => {
      cancelAnimationFrame(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
