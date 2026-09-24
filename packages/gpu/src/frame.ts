/**
 * One canvas's frame scheduler: coalesced wakes, a same-paint re-render on resize, and a backing
 * store sized to the canvas. Renderers own what a frame draws; the loop owns when, and at what
 * size.
 */

import type { Presentation } from './presentation.js';

/** What one frame renders against; the same object every frame, valid only during the call. */
export interface Frame {
  /** The tick's timestamp from `performance.now()`, in milliseconds. */
  readonly now: number;
  /** The canvas's CSS-pixel width. */
  readonly width: number;
  /** The canvas's CSS-pixel height. */
  readonly height: number;
  /** Backing pixels per CSS pixel, after the device limit and resize quantization. */
  readonly backingScale: number;
  /**
   * False while a resize is in flight and the backing store is quantized up; it snaps exact once
   * the size holds for a few frames. Always true for a loop that does not quantize.
   */
  readonly settled: boolean;
}

/** One canvas's frame scheduler. */
export interface FrameLoop {
  /** Schedule a frame on the next animation frame; repeated wakes coalesce into one. */
  wake(): void;
  /** Render a frame now, cancelling one already queued. Dropped while paused or destroyed. */
  frameNow(): void;
  /** Stop rendering until `resume`; wakes while paused are dropped. */
  pause(): void;
  /** Continue, and schedule a frame. */
  resume(): void;
  /** Stop for good and stop observing the canvas; idempotent. */
  destroy(): void;
}

/**
 * Backing-store quantum in device pixels while a resize is in flight. Attachments sized to the
 * canvas must match it exactly, so quantizing spares a reallocation for every small resize step.
 */
const RESIZE_QUANTUM = 64;
/** Frames of stable size before the backing store snaps to the exact size. */
const RESIZE_SETTLE_TICKS = 3;

/** The loop's own view of the frame it hands out; `Frame` is this, read-only. */
interface MutableFrame {
  now: number;
  width: number;
  height: number;
  backingScale: number;
  settled: boolean;
}

/**
 * Drive `render` for a presentation's canvas: coalesced wakes, a re-render before the next paint
 * whenever the canvas resizes, and (unless `quantize` is off) a backing store quantized up while a
 * resize is in flight that snaps exact once the size holds. `render` returns true to be called
 * again on the next frame.
 *
 * @remarks
 * Observation starts at once and ends with `destroy`. The observation's synchronous first report
 * only records the size; every later report, the observer's initial notification included,
 * renders a frame before the next paint whether or not the loop was woken, so `render` must be
 * ready to draw from the moment the loop exists. A canvas without area skips its frame and
 * schedules nothing: the resize that gives it area renders. While paused, neither wakes nor
 * reports render. A `render` that pauses or destroys the loop stops it; one that wakes it
 * schedules exactly one next frame.
 *
 * @param presentation - The configured canvas whose size the loop observes and sets.
 * @param render - Draws one frame and returns true to be called again on the next frame.
 * @param options - `quantize` rounds the backing store up to a multiple of 64 device pixels while
 * a resize is in flight, sparing size-matched attachments a reallocation per resize step. A
 * renderer that repaints everything on any size change passes `false`: the backing store then
 * follows the exact size on every frame, so one resize reallocates once instead of twice
 * (rounded up, then exact).
 * @defaultValue `{ quantize: true }`
 */
export function createFrameLoop(
  presentation: Presentation<HTMLCanvasElement>,
  render: (frame: Frame) => boolean,
  options?: { readonly quantize?: boolean },
): FrameLoop {
  const quantize = options?.quantize ?? true;
  const { canvas } = presentation;
  const frame: MutableFrame = { now: 0, width: 0, height: 0, backingScale: 1, settled: true };

  let rafId = 0;
  let flushQueued = false;
  let active = true;
  let dead = false;

  // The exact device-pixel size the last frame saw, and how long it has held.
  let exactWidth = 0;
  let exactHeight = 0;
  let stableTicks = RESIZE_SETTLE_TICKS;
  // The backing size last requested, so an unchanged request never touches the canvas.
  let requestedWidth = 0;
  let requestedHeight = 0;
  // The observed device-pixel size: exact, and free of the layout read a per-frame
  // `clientWidth` would force.
  let observedWidth = 0;
  let observedHeight = 0;
  let pixelRatio = 1;

  const cancel = (): void => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  };

  /**
   * Size the backing store to the observed size, quantized up while a resize is in flight and
   * exact once the size holds for `RESIZE_SETTLE_TICKS` frames.
   *
   * @returns False when the canvas has no area and the frame should be skipped.
   */
  const syncViewport = (): boolean => {
    // Before the first observation lands, fall back to the laid-out size.
    const width = observedWidth || Math.round(canvas.clientWidth * pixelRatio);
    const height = observedHeight || Math.round(canvas.clientHeight * pixelRatio);
    if (width === 0 || height === 0) return false;

    if (exactWidth === 0 && exactHeight === 0) {
      // First sighting: no resize is in flight, so the first paint renders at the true size.
      stableTicks = RESIZE_SETTLE_TICKS;
    } else if (width !== exactWidth || height !== exactHeight) {
      stableTicks = 0;
    } else if (stableTicks < RESIZE_SETTLE_TICKS) {
      stableTicks++;
    }
    exactWidth = width;
    exactHeight = height;

    const settled = !quantize || stableTicks >= RESIZE_SETTLE_TICKS;
    frame.settled = settled;
    const targetWidth = settled ? width : Math.ceil(width / RESIZE_QUANTUM) * RESIZE_QUANTUM;
    const targetHeight = settled ? height : Math.ceil(height / RESIZE_QUANTUM) * RESIZE_QUANTUM;
    if (requestedWidth !== targetWidth || requestedHeight !== targetHeight) {
      requestedWidth = targetWidth;
      requestedHeight = targetHeight;
      presentation.resize(targetWidth, targetHeight);
    }
    return true;
  };

  const tick = (): void => {
    rafId = 0;
    if (dead || !active || !syncViewport()) return;

    frame.now = performance.now();
    frame.width = exactWidth / pixelRatio;
    frame.height = exactHeight / pixelRatio;
    // The device limit may shrink the backing store below the request; report what it holds.
    frame.backingScale = Math.min(canvas.width / frame.width, canvas.height / frame.height);

    const again = render(frame);
    // `render` may have paused or destroyed the loop, or woken it; never stack a second frame.
    if (dead || !active || rafId) return;
    if (again || !frame.settled) rafId = requestAnimationFrame(tick);
  };

  // A resize re-renders before the next paint, cancelling a queued frame rather than waiting for
  // it: the frame presented after a layout change must be drawn at the new size, even when that
  // costs a second submit within one frame. A wake here would lag a frame, visible as a
  // stretched image through a continuous resize.
  const flushSameFrame = (): void => {
    if (flushQueued || dead || !active) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      if (dead || !active) return;
      cancel();
      tick();
    });
  };

  let observing = false;
  let stopObserving: (() => void) | null = presentation.observe((width, height, ratio) => {
    observedWidth = width;
    observedHeight = height;
    pixelRatio = ratio;
    // The synchronous first report only records the size. Every later one renders, the
    // observer's initial notification included: a size change is drawn before the next paint.
    if (observing) flushSameFrame();
  });
  observing = true;

  return {
    wake() {
      if (active && !dead && !rafId) rafId = requestAnimationFrame(tick);
    },

    frameNow() {
      if (!active || dead) return;
      cancel();
      tick();
    },

    pause() {
      active = false;
      cancel();
    },

    resume() {
      if (dead) return;
      active = true;
      if (!rafId) rafId = requestAnimationFrame(tick);
    },

    destroy() {
      if (dead) return;
      dead = true;
      cancel();
      const stop = stopObserving;
      stopObserving = null;
      stop?.();
    },
  };
}
