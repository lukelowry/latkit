import { observeCanvas, type Presentation } from '@latkit/gpu';

import type { Camera } from '../camera/camera.js';
import type { Viewport } from '../camera/projection.js';
import type { Bounds } from '../topology/index.js';
import type { Renderer } from './renderer.js';
import type { Uniforms } from './uniforms.js';

export interface RenderLoopDeps {
  /** Configured HTML canvas presentation resized and rendered by the loop. */
  presentation: Presentation<HTMLCanvasElement>;
  /** Packed uniform views shared with camera, renderer, and picking state. */
  uniforms: Uniforms;
  /** GPU renderer that submits one encoded network frame. */
  renderer: Renderer;
  /** Receives fit-view state transitions after camera ticking. */
  onZoom?: (atFitView: boolean) => void;
  /**
   * Runs after `camera.tick()` and before frame submission so hover state can
   * be resolved against the final camera pose for this frame.
   */
  onFrame?: (sizeSettled: boolean) => void;
  /**
   * Updates viewport-derived visual uniforms before hover picking and GPU
   * submission observe them.
   */
  onBeforeFrame?: (vp: Viewport) => void;
  /** Fires after a successful GPU submit rather than a skipped render attempt. */
  onPaint?: () => void;
}

/**
 * Backing-store quantum in device pixels while a resize gesture is in flight.
 * MSAA/depth attachments must match canvas size exactly, so quantizing avoids
 * reallocating them for every small resize delta.
 */
const RESIZE_QUANTUM = 64;
/** Frames of stable size before the backing store snaps to the exact size. */
const RESIZE_SETTLE_TICKS = 3;

/**
 * Orchestrates the render loop: rAF scheduling, viewport sync, uniform write,
 * and GPU submit.
 *
 * Scheduling invariant: ordinary wakes coalesce to at most one frame per
 * paint. Resizes go through
 * `flushSameFrame()`, which always re-renders before the next paint. The
 * "backing buffer matches CSS-displayed size at paint time" contract wins
 * over single-submit there.
 */
export class RenderLoop {
  private readonly presentation: Presentation<HTMLCanvasElement>;
  private readonly uniforms: Uniforms;
  private readonly renderer: Renderer;
  private readonly onZoom?: (atFitView: boolean) => void;
  private readonly onFrame?: (sizeSettled: boolean) => void;
  private readonly onBeforeFrame?: (vp: Viewport) => void;
  private readonly onPaint?: () => void;
  // Swappable state set by the canvas orchestrator as it changes.
  private camera: Camera | null = null;
  private bounds: Bounds | null = null;

  // Loop state.
  private rafId = 0;
  private microQueued = false;
  private active = true;
  private dead = false;
  private needsFit = false;
  private pendingMove: {
    readonly kind: 'fit' | 'reveal';
    readonly bounds: Bounds;
    readonly animate: boolean;
  } | null = null;
  private lastFit = true;
  /** When the pending rAF is a trailing guard, it renders only if new work
   *  arrived. Any explicit wake upgrades it to an unconditional frame. */
  private guardOnly = false;
  /** Reused per-tick viewport so the loop allocates nothing per frame. */
  private readonly frameVp: Viewport = { w: 0, h: 0 };

  // Backing-store settle state (see RESIZE_QUANTUM).
  private exactW = 0;
  private exactH = 0;
  private sizeStableTicks = RESIZE_SETTLE_TICKS;
  private sizeSettled = true;
  /**
   * Device-pixel size from ResizeObserver, exact and free of the per-tick
   * layout read `syncViewport()` would otherwise do.
   */
  private roW = 0;
  private roH = 0;
  private devicePixelRatio = 1;
  private requestedW = 0;
  private requestedH = 0;

  // Resize wiring. Owned by the loop because the contract, "canvas backing
  // buffer matches CSS-displayed size at paint time", is the loop's
  // responsibility, so the loop owns the timing. Co-locating the
  // ResizeObserver here is what guarantees `flushSameFrame` is the scheduler
  // (one microtask hop; same-frame render before paint). Any other
  // arrangement leaves room for a consumer to wire `wake` (next-frame
  // rAF), which produces a one-frame lag visible as bilinear scaling
  // during continuous CSS-driven resizes (e.g. the workbench rail slot).
  private stopObserving: (() => void) | null = null;

  constructor(deps: RenderLoopDeps) {
    this.presentation = deps.presentation;
    this.uniforms = deps.uniforms;
    this.renderer = deps.renderer;
    this.onZoom = deps.onZoom;
    this.onFrame = deps.onFrame;
    this.onBeforeFrame = deps.onBeforeFrame;
    this.onPaint = deps.onPaint;
    this.tick = this.tick.bind(this);
    this.tickRaf = this.tickRaf.bind(this);

    let ready = false;
    this.stopObserving = observeCanvas(this.presentation.canvas, (width, height, pixelRatio) => {
      this.roW = width;
      this.roH = height;
      this.devicePixelRatio = pixelRatio;
      if (ready) this.flushSameFrame();
    });
    ready = true;
  }

  // Injected state

  /** Replaces the camera ticked by the loop. */
  setCamera(camera: Camera): void {
    this.camera = camera;
  }
  /** Replaces the topology bounds used for pending fit requests. */
  setBounds(bounds: Bounds | null): void {
    this.bounds = bounds;
  }
  /** Next tick will call `camera.init(bounds, vp)` before other work. */
  requestFit(): void {
    this.needsFit = true;
    this.pendingMove = null;
  }
  /** Move after any pending canonical initialization on the next sized frame. */
  requestMove(bounds: Bounds, animate: boolean): void {
    this.pendingMove = { kind: 'fit', bounds, animate };
  }
  /** Reveal after any pending canonical initialization on the next sized frame. */
  requestReveal(bounds: Bounds, animate: boolean): void {
    this.pendingMove = { kind: 'reveal', bounds, animate };
  }
  /** Cancel a deferred subset move or reveal while preserving canonical fit work. */
  cancelDeferredMove(): void {
    this.pendingMove = null;
  }
  /** Cancel deferred camera placement when a newer immediate command wins. */
  cancelPlacement(): void {
    this.needsFit = false;
    this.cancelDeferredMove();
  }

  // Scheduling

  /**
   * Schedules an unconditional tick on the next rAF.
   *
   * Repeated calls coalesce, and a pending trailing guard is upgraded.
   */
  wake(): void {
    if (!this.active || this.dead) return;
    this.guardOnly = false;
    if (!this.rafId) this.rafId = requestAnimationFrame(this.tickRaf);
  }

  /**
   * Re-renders before the next paint unconditionally for the resize path.
   * This cancels a pending rAF and never folds: the
   * backing-buffer/CSS-size contract requires the frame presented after a
   * layout change to be rendered at the new size, even if that means a
   * second submit within one frame during resize-plus-animation overlap.
   */
  private flushSameFrame(): void {
    if (this.microQueued || !this.active || this.dead) return;
    this.microQueued = true;
    queueMicrotask(() => {
      this.microQueued = false;
      if (this.dead || !this.active) return;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
        this.guardOnly = false;
      }
      this.tick();
    });
  }

  /** Render one frame immediately, cancelling any queued duplicate tick. */
  frameNow(): void {
    if (!this.active || this.dead) return;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
      this.guardOnly = false;
    }
    this.tick();
  }

  /** Pause the loop: cancel any pending rAF, stop accepting wakes. */
  pause(): void {
    this.active = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
      this.guardOnly = false;
    }
  }

  /** Resume and immediately schedule a frame if anything is pending. */
  resume(): void {
    this.active = true;
    this.wake();
  }

  /** Shut down permanently. No further frames can be scheduled. */
  destroy(): void {
    this.dead = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.pendingMove = null;
    this.stopObserving?.();
    this.stopObserving = null;
  }

  // Per-frame work

  /**
   * Runs a queued rAF tick, skipping trailing guards when no new work arrived.
   */
  private tickRaf(): void {
    this.rafId = 0;
    const guardOnly = this.guardOnly;
    this.guardOnly = false;
    if (guardOnly && !this.needsFit && !this.pendingMove && this.sizeSettled) {
      return;
    }
    this.tick();
  }

  /** Advances camera state, writes frame uniforms, and submits one frame. */
  private tick(): void {
    this.rafId = 0;
    if (this.dead) return;
    if (!this.camera || !this.bounds) return;
    if (!this.syncViewport()) return;

    const frameVp = this.frameVp;
    const logicalWidth = this.exactW / this.devicePixelRatio;
    const logicalHeight = this.exactH / this.devicePixelRatio;
    if (this.camera.fitIntent && (frameVp.w !== logicalWidth || frameVp.h !== logicalHeight)) {
      this.needsFit = true;
    }
    frameVp.w = logicalWidth;
    frameVp.h = logicalHeight;

    if (this.needsFit) {
      this.camera.init(this.bounds, frameVp);
      this.needsFit = false;
    }
    if (this.pendingMove) {
      const move = this.pendingMove;
      this.pendingMove = null;
      if (move.kind === 'reveal') this.camera.reveal(move.bounds, frameVp, move.animate);
      else this.camera.moveTo(move.bounds, frameVp, move.animate);
    }

    this.camera.tick(performance.now(), frameVp);
    this.onBeforeFrame?.(frameVp);

    const fit = this.camera.isAtFitView();
    if (fit !== this.lastFit) {
      this.lastFit = fit;
      this.onZoom?.(fit);
    }

    this.uniforms.frame.viewportX = this.presentation.canvas.width;
    this.uniforms.frame.viewportY = this.presentation.canvas.height;

    // Hover resolves here after this frame's camera pose is final and before
    // uniforms upload, so the highlight it writes is part of the frame
    // being submitted. Host callbacks may pause or destroy the loop; bail
    // if they did.
    this.onFrame?.(this.sizeSettled);
    if (this.dead || !this.active) return;

    const painted = this.submitFrame();
    if (painted) this.onPaint?.();

    // A host callback may have scheduled a frame mid-tick; never stack a
    // second rAF on top of it.
    if (!this.rafId) {
      if (this.camera.isAnimating() || !this.sizeSettled) {
        this.rafId = requestAnimationFrame(this.tickRaf);
      } else {
        // Trailing guard: catches notifications that arrive later in this
        // frame. Skips the render and reschedules nothing when nothing new
        // arrived.
        this.guardOnly = true;
        this.rafId = requestAnimationFrame(this.tickRaf);
      }
    }
  }

  /**
   * Ensures the canvas backing store matches CSS size times DPR, quantized
   * up to `RESIZE_QUANTUM` while a resize gesture is in flight, exact once
   * the size holds still for `RESIZE_SETTLE_TICKS` frames.
   * @returns False when the element has no area and the caller should skip the frame.
   */
  private syncViewport(): boolean {
    const { canvas } = this.presentation;
    // Prefer the ResizeObserver's device-pixel size, exact and free of a
    // forced layout read; fall back to css times dpr before the first
    // observation and on the visualViewport-only path.
    const pw = this.roW || Math.round(canvas.clientWidth * this.devicePixelRatio);
    const ph = this.roH || Math.round(canvas.clientHeight * this.devicePixelRatio);
    if (pw === 0 || ph === 0) return false;

    if (this.exactW === 0 && this.exactH === 0) {
      // First sighting: no gesture in flight; size exactly so the load
      // paint renders at the true resolution.
      this.exactW = pw;
      this.exactH = ph;
      this.sizeStableTicks = RESIZE_SETTLE_TICKS;
    } else if (pw !== this.exactW || ph !== this.exactH) {
      this.exactW = pw;
      this.exactH = ph;
      this.sizeStableTicks = 0;
    } else if (this.sizeStableTicks < RESIZE_SETTLE_TICKS) {
      this.sizeStableTicks++;
    }

    const settled = this.sizeStableTicks >= RESIZE_SETTLE_TICKS;
    this.sizeSettled = settled;
    const tw = settled ? pw : Math.ceil(pw / RESIZE_QUANTUM) * RESIZE_QUANTUM;
    const th = settled ? ph : Math.ceil(ph / RESIZE_QUANTUM) * RESIZE_QUANTUM;

    if (this.requestedW !== tw || this.requestedH !== th) {
      this.requestedW = tw;
      this.requestedH = th;
      this.presentation.resize(tw, th);
      // Viewport changed. If the user is at fit-view by intent (initial
      // load, F key, doubleTap, fit(true); see camera.fitIntent), the
      // pose is no longer fit because the viewport changed under the
      // camera. Re-fit so the graph stays centered and fully visible. If
      // the user has panned/zoomed, fitIntent is false and we leave the
      // camera alone; their explored pose is preserved (the graph just
      // gets cropped or uncropped by the new viewport).
      if (this.camera?.fitIntent) this.needsFit = true;
    }
    return true;
  }

  /** Uploads frame uniforms and delegates rendering to the GPU renderer. */
  private submitFrame(): boolean {
    const { canvas } = this.presentation;
    this.uniforms.frame.viewportX = canvas.width;
    this.uniforms.frame.viewportY = canvas.height;
    this.uniforms.frame.backingScale = Math.min(
      canvas.width / this.frameVp.w,
      canvas.height / this.frameVp.h,
    );
    this.uniforms.frame.time = performance.now() * 0.001;
    return this.renderer.render(this.uniforms);
  }
}
