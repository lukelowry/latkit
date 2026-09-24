import type { Rect } from './geometry.js';
import type { Insets } from './options.js';

/** Where the camera looks: the diagram point at the viewport center and the zoom. */
export interface Pose {
  /** Diagram x at the viewport center. */
  readonly centerX: number;
  /** Diagram y at the viewport center; y grows downward. */
  readonly centerY: number;
  /** CSS pixels per diagram unit; `1` is actual size. */
  readonly zoom: number;
}

/** A canvas's size in CSS pixels. */
export interface Viewport {
  readonly w: number;
  readonly h: number;
}

/** The share of the limiting viewport dimension a default fit fills. */
const FIT_FILL = 0.9;
/** The least a padded fit may fill, so an inset larger than the canvas still shows something. */
const MIN_FILL = 0.05;
/** The closest zoom, in CSS pixels per diagram unit. */
const MAX_ZOOM = 8;
/** The farthest zoom never needs to be closer than this, however small the content. */
const MIN_ZOOM_CEILING = 0.25;
/** How far below the fit zoom the camera may pull back. */
const MIN_ZOOM_BELOW_FIT = 4;
/** `isAtFit` tolerance on the center, in CSS pixels. */
const AT_FIT_PX = 0.5;
/** `isAtFit` tolerance on the zoom, relative. */
const AT_FIT_ZOOM = 0.001;

/** An eased move from one pose to another; `start` is NaN until the first tick stamps it. */
interface Easing {
  readonly fromX: number;
  readonly fromY: number;
  readonly fromZoom: number;
  toX: number;
  toY: number;
  toZoom: number;
  start: number;
  readonly durationMs: number;
}

/** A partial pose held until the camera is placed. */
interface PendingPose {
  centerX?: number;
  centerY?: number;
  zoom?: number;
}

/** Camera math requires a finite, non-empty CSS-pixel viewport. */
function usable(vp: Viewport): boolean {
  return Number.isFinite(vp.w) && Number.isFinite(vp.h) && vp.w > 0 && vp.h > 0;
}

/** Cubic in-out: slow start, slow finish. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * The 2D camera: a pose, zoom limits from the content, eased moves, and a fit deferred until a
 * viewport has area.
 *
 * @remarks
 * Zoom limits are `[min(fitZoom / 4, 0.25), 8]`, `fitZoom` from the last content bounds, and
 * `[0.25, 8]` without content. Easing is cubic in-out over `durationMs`; a user gesture cancels
 * it, and every newer command replaces it. A default fit fills 90% of the viewport's limiting
 * dimension; `fitPaddingPx` insets override it and asymmetric insets shift the center. `fit`
 * defines the fit view `isAtFit` compares with, and a camera left there follows the viewport: a
 * resize re-frames the same bounds, so `isAtFit` keeps holding until a gesture, `setPose`, or a
 * `moveTo` explores away. `moveTo` frames other bounds without redefining the fit view.
 *
 * Content-free bounds never unplace a camera: it keeps its pose, or takes the origin at actual
 * size when it has none, so points keep mapping on an empty diagram. Only `reset` unplaces it.
 */
export class Camera {
  private centerX = 0;
  private centerY = 0;
  private zoom = 0;
  private isPlaced = false;
  /** Content bounds: the canonical fit and the zoom floor derive from them. */
  private bounds: Rect | null = null;
  /** Insets every fit keeps clear, CSS px; null for the default fill. */
  private padding: Insets | null = null;
  /** The last usable viewport, for the zoom floor and deferred commands. */
  private vpW = 0;
  private vpH = 0;
  /** What the last fit framed; a camera following it re-frames on resize. */
  private fitBounds: Rect | null = null;
  /** The pose the last fit landed on, for `isAtFit`; stale after a resize until re-framed. */
  private fitX = Number.NaN;
  private fitY = Number.NaN;
  private fitZoom = Number.NaN;
  /** Whether the camera follows `fitBounds`: set by a fit, cleared by any exploration. */
  private fitIntent = false;
  /** A fit of `fitBounds` awaits a viewport with area. */
  private pendingFit = false;
  /** A pose requested before placement, merged over the placing fit. */
  private pendingPose: PendingPose | null = null;
  /** Bounds a `moveTo` frames once the camera is placed and a viewport has area. */
  private pendingMove: Rect | null = null;
  private easing: Easing | null = null;
  /** The pose `framing` computed last; scratch, so framing allocates nothing. */
  private framedX = 0;
  private framedY = 0;
  private framedZoom = 0;

  /** Current state; `zoom` 0 until placed. */
  get pose(): Pose {
    return { centerX: this.centerX, centerY: this.centerY, zoom: this.zoom };
  }

  /** Whether a pose has been placed. */
  get placed(): boolean {
    return this.isPlaced;
  }

  /** Whether an eased move is in flight. */
  get animating(): boolean {
    return this.easing !== null;
  }

  /**
   * Content bounds the fit frames and zoom limits derive from; null when there is no content.
   * New bounds drop a deferred `moveTo`, framed against the old content.
   *
   * With `fit`, or while not yet placed, the camera frames `bounds` at once when a viewport with
   * area is known, else on the first `tick` that has one. Without `fit` a placed camera keeps its
   * pose and only its zoom limits follow. Null bounds frame nothing: a placed camera keeps its
   * pose, which with `fit` becomes the fit view; an unplaced one is placed at once, without a
   * viewport, at the origin at actual size (then a pose requested meanwhile).
   */
  setBounds(bounds: Rect | null, fit: boolean): void {
    this.bounds = bounds;
    this.pendingFit = false;
    this.pendingMove = null;
    if (bounds === null) {
      this.fitBounds = null;
      this.fitIntent = false;
      if (!this.isPlaced) {
        this.isPlaced = true;
        this.easing = null;
        this.centerX = 0;
        this.centerY = 0;
        this.zoom = 1;
        this.markFit();
        this.applyPendingPose();
      } else if (fit) {
        this.easing = null;
        this.markFit();
      }
      return;
    }
    if (!fit && this.isPlaced) {
      // The pose stays; it no longer follows a fit of content that changed.
      this.fitIntent = false;
      return;
    }
    this.easing = null;
    this.fitBounds = bounds;
    this.fitIntent = true;
    if (this.hasViewport()) this.place();
    else this.pendingFit = true;
  }

  /**
   * Frame `bounds` as the fit view, now or eased; deferred until `viewport` has area. The first
   * placement never eases. `padding` becomes the insets every later fit keeps clear.
   */
  fit(
    bounds: Rect,
    viewport: Viewport,
    padding: Insets | null,
    animate: boolean,
    durationMs: number,
  ): void {
    this.padding = padding;
    this.fitBounds = bounds;
    this.fitIntent = true;
    this.pendingMove = null;
    if (!usable(viewport)) {
      this.easing = null;
      this.pendingFit = true;
      return;
    }
    this.vpW = viewport.w;
    this.vpH = viewport.h;
    this.pendingFit = false;
    if (!this.isPlaced) {
      this.place();
      return;
    }
    this.pendingPose = null;
    this.refit(animate && durationMs > 0 ? 'ease' : 'jump', durationMs);
  }

  /**
   * Frame `bounds` the way a fit would, zoom clamped, without redefining the fit view: `isAtFit`
   * keeps comparing with the last `fit`, and a resize does not re-frame `bounds`. It takes the
   * camera from a fit it follows and replaces any easing or pose in flight, even when it lands
   * where the camera already is. Deferred until the camera is placed and `viewport` has area,
   * and then not eased.
   */
  moveTo(bounds: Rect, viewport: Viewport, animate: boolean, durationMs: number): void {
    this.fitIntent = false;
    this.pendingPose = null;
    // A deferred fit is superseded; an unplaced camera's is its placement, so it stays.
    if (this.isPlaced) this.pendingFit = false;
    if (!this.isPlaced || !usable(viewport)) {
      this.easing = null;
      this.pendingMove = bounds;
      return;
    }
    this.pendingMove = null;
    this.vpW = viewport.w;
    this.vpH = viewport.h;
    this.frameBounds(bounds, animate && durationMs > 0, durationMs);
  }

  /**
   * Let the current pose supersede a camera move in flight: an easing, a pose awaiting placement,
   * a deferred re-fit of a placed camera, or a deferred `moveTo`. Returns whether it stopped any
   * of them but a deferred `moveTo`; the camera then no longer follows its fit. An idle camera is
   * left as it is.
   */
  claim(): boolean {
    this.pendingMove = null;
    const refit = this.pendingFit && this.isPlaced;
    if (this.easing === null && this.pendingPose === null && !refit) return false;
    this.easing = null;
    this.pendingPose = null;
    if (refit) this.pendingFit = false;
    this.fitIntent = false;
    return true;
  }

  /** Forget everything but the fit insets: unplaced, no content, no fit, nothing pending. */
  reset(): void {
    this.isPlaced = false;
    this.centerX = 0;
    this.centerY = 0;
    this.zoom = 0;
    this.bounds = null;
    this.vpW = 0;
    this.vpH = 0;
    this.fitBounds = null;
    this.fitX = this.fitY = this.fitZoom = Number.NaN;
    this.fitIntent = false;
    this.pendingFit = false;
    this.pendingPose = null;
    this.pendingMove = null;
    this.easing = null;
  }

  /**
   * Replace the insets fits keep clear (the live `fitPaddingPx`). A camera following a fit
   * re-frames at once, or retargets the eased fit in flight.
   */
  setPadding(padding: Insets | null): void {
    this.padding = padding;
    if (this.fitIntent && this.isPlaced && this.fitBounds !== null) this.refit('follow');
  }

  /**
   * Merge a partial pose, zoom clamped; returns whether the camera changed. Before placement the
   * request is kept and applied over the placing fit, and the call returns true. Either way it
   * replaces a deferred `moveTo`.
   *
   * @throws RangeError naming a field that is not finite, or a zoom that is not positive.
   */
  setPose(pose: Partial<Pose>, animate: boolean, durationMs: number): boolean {
    const { centerX, centerY, zoom } = pose;
    if (centerX !== undefined && !Number.isFinite(centerX)) {
      throw new RangeError('pose.centerX must be a finite number');
    }
    if (centerY !== undefined && !Number.isFinite(centerY)) {
      throw new RangeError('pose.centerY must be a finite number');
    }
    if (zoom !== undefined && !(Number.isFinite(zoom) && zoom > 0)) {
      throw new RangeError('pose.zoom must be a finite number greater than 0');
    }
    const deferred = this.pendingMove !== null;
    this.pendingMove = null;
    if (!this.isPlaced) {
      this.pendingPose = { ...this.pendingPose, ...pose };
      return true;
    }
    const x = centerX ?? this.centerX;
    const y = centerY ?? this.centerY;
    const z = this.clampZoom(zoom ?? this.zoom);
    if (this.easing === null && x === this.centerX && y === this.centerY && z === this.zoom) {
      return deferred;
    }
    this.fitIntent = false;
    this.goTo(x, y, z, animate && durationMs > 0, durationMs);
    return true;
  }

  /** Drag the content by CSS pixels; returns whether the camera moved. A gesture: stops easing. */
  panBy(dx: number, dy: number): boolean {
    if (!this.isPlaced) return false;
    this.easing = null;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return false;
    this.fitIntent = false;
    this.pendingPose = null;
    this.pendingMove = null;
    this.centerX -= dx / this.zoom;
    this.centerY -= dy / this.zoom;
    return true;
  }

  /**
   * Zoom by `factor` about a canvas-local CSS-pixel point, which keeps the diagram point under
   * it; returns whether the camera moved. A gesture: stops easing.
   */
  zoomAt(factor: number, sx: number, sy: number, viewport: Viewport): boolean {
    if (!this.isPlaced || !usable(viewport)) return false;
    this.easing = null;
    this.pendingMove = null;
    this.vpW = viewport.w;
    this.vpH = viewport.h;
    if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(sx) || !Number.isFinite(sy)) {
      return false;
    }
    const zoom = this.clampZoom(this.zoom * factor);
    if (zoom === this.zoom) return false;
    const ox = sx - viewport.w / 2;
    const oy = sy - viewport.h / 2;
    const x = this.centerX + ox / this.zoom;
    const y = this.centerY + oy / this.zoom;
    this.centerX = x - ox / zoom;
    this.centerY = y - oy / zoom;
    this.zoom = zoom;
    this.fitIntent = false;
    return true;
  }

  /**
   * Advance an easing, and place a deferred fit and then a deferred `moveTo` once a viewport has
   * area; true while moving.
   *
   * A camera following a fit re-frames when the viewport changed size since the last tick.
   */
  tick(now: number, viewport: Viewport): boolean {
    if (!usable(viewport)) return false;
    const resized = viewport.w !== this.vpW || viewport.h !== this.vpH;
    this.vpW = viewport.w;
    this.vpH = viewport.h;
    if (this.pendingFit) {
      this.pendingFit = false;
      if (this.fitBounds !== null) {
        if (this.isPlaced) this.refit('jump');
        else this.place();
      }
    } else if (resized && this.fitIntent && this.isPlaced && this.fitBounds !== null) {
      this.refit('follow');
    }
    const move = this.pendingMove;
    if (move !== null && this.isPlaced) {
      this.pendingMove = null;
      this.fitIntent = false;
      this.frameBounds(move, false, 0);
    }
    const easing = this.easing;
    if (easing === null) return false;
    if (Number.isNaN(easing.start)) easing.start = now;
    const t = easing.durationMs > 0 ? (now - easing.start) / easing.durationMs : 1;
    if (!(t < 1)) {
      this.centerX = easing.toX;
      this.centerY = easing.toY;
      this.zoom = easing.toZoom;
      this.easing = null;
      return false;
    }
    const e = easeInOutCubic(Math.max(0, t));
    this.centerX = easing.fromX + (easing.toX - easing.fromX) * e;
    this.centerY = easing.fromY + (easing.toY - easing.fromY) * e;
    // Zoom eases geometrically so a large change feels even at every scale.
    this.zoom = easing.fromZoom * (easing.toZoom / easing.fromZoom) ** e;
    return true;
  }

  /** Whether the camera sits at the last fit target, within 0.5 CSS px and 0.1% zoom. */
  isAtFit(): boolean {
    if (!this.isPlaced || this.easing !== null || !(this.fitZoom > 0)) return false;
    return (
      Math.abs(this.centerX - this.fitX) * this.fitZoom <= AT_FIT_PX &&
      Math.abs(this.centerY - this.fitY) * this.fitZoom <= AT_FIT_PX &&
      Math.abs(this.zoom / this.fitZoom - 1) <= AT_FIT_ZOOM
    );
  }

  /** The diagram point under a canvas-local CSS-pixel point; NaN until placed. */
  toDiagram(sx: number, sy: number, viewport: Viewport): readonly [number, number] {
    if (!this.isPlaced) return [Number.NaN, Number.NaN];
    return [
      this.centerX + (sx - viewport.w / 2) / this.zoom,
      this.centerY + (sy - viewport.h / 2) / this.zoom,
    ];
  }

  /** The canvas-local CSS-pixel point of a diagram point; NaN until placed. */
  toScreen(x: number, y: number, viewport: Viewport): readonly [number, number] {
    if (!this.isPlaced) return [Number.NaN, Number.NaN];
    return [
      (x - this.centerX) * this.zoom + viewport.w / 2,
      (y - this.centerY) * this.zoom + viewport.h / 2,
    ];
  }

  /** The visible diagram rectangle; NaN until placed. */
  view(viewport: Viewport): Rect {
    if (!this.isPlaced) return [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
    const hw = viewport.w / 2 / this.zoom;
    const hh = viewport.h / 2 / this.zoom;
    return [this.centerX - hw, this.centerY - hh, this.centerX + hw, this.centerY + hh];
  }

  /** Whether a usable viewport has been seen. */
  private hasViewport(): boolean {
    return this.vpW > 0 && this.vpH > 0;
  }

  /** The first placement: frame `fitBounds` at once, then apply a pose requested meanwhile. */
  private place(): void {
    this.isPlaced = true;
    this.refit('jump');
    this.applyPendingPose();
  }

  /** Apply a pose requested before placement over the placing one; it leaves the fit. */
  private applyPendingPose(): void {
    const pending = this.pendingPose;
    this.pendingPose = null;
    if (pending === null) return;
    this.fitIntent = false;
    this.centerX = pending.centerX ?? this.centerX;
    this.centerY = pending.centerY ?? this.centerY;
    this.zoom = this.clampZoom(pending.zoom ?? this.zoom);
  }

  /** Record the current pose as the fit target: what a fit of no content lands on. */
  private markFit(): void {
    this.fitX = this.centerX;
    this.fitY = this.centerY;
    this.fitZoom = this.zoom;
  }

  /**
   * Frame `fitBounds` in the last viewport and record it as the fit target: at once, eased, or
   * `follow` (a resize): retarget an easing in flight, else at once.
   */
  private refit(how: 'jump' | 'ease' | 'follow', durationMs = 0): void {
    const bounds = this.fitBounds;
    if (bounds === null) return;
    this.framing(bounds);
    this.fitX = this.framedX;
    this.fitY = this.framedY;
    this.fitZoom = this.framedZoom;
    const easing = this.easing;
    if (how === 'follow' && easing !== null) {
      // A resize during an eased fit retargets it rather than cutting it short.
      easing.toX = this.fitX;
      easing.toY = this.fitY;
      easing.toZoom = this.fitZoom;
      return;
    }
    this.goTo(this.fitX, this.fitY, this.fitZoom, how === 'ease', durationMs);
  }

  /** Frame `bounds` in the last viewport without touching the fit target: at once or eased. */
  private frameBounds(bounds: Rect, animate: boolean, durationMs: number): void {
    this.framing(bounds);
    const { framedX: x, framedY: y, framedZoom: zoom } = this;
    // A move that lands where the camera is still replaces an easing in flight.
    if (this.easing === null && x === this.centerX && y === this.centerY && zoom === this.zoom) {
      return;
    }
    this.goTo(x, y, zoom, animate, durationMs);
  }

  /** The pose framing `bounds` in the last viewport, written to `framedX/framedY/framedZoom`. */
  private framing(bounds: Rect): void {
    const w = this.vpW;
    const h = this.vpH;
    const [fillX, fillY, shiftX, shiftY] = this.frame(w, h);
    const bw = bounds[2] - bounds[0];
    const bh = bounds[3] - bounds[1];
    // A zero-size extent does not limit the zoom; the upper clamp does.
    const zx = bw > 0 ? (w * fillX) / bw : Number.POSITIVE_INFINITY;
    const zy = bh > 0 ? (h * fillY) / bh : Number.POSITIVE_INFINITY;
    const zoom = this.clampZoom(Math.min(zx, zy));
    // The content center lands `shift` px off the viewport center, toward the smaller insets.
    this.framedX = (bounds[0] + bounds[2]) / 2 - shiftX / zoom;
    this.framedY = (bounds[1] + bounds[3]) / 2 - shiftY / zoom;
    this.framedZoom = zoom;
  }

  /** Set the pose, or ease toward it from the current one. */
  private goTo(x: number, y: number, zoom: number, animate: boolean, durationMs: number): void {
    if (!animate) {
      this.easing = null;
      this.centerX = x;
      this.centerY = y;
      this.zoom = zoom;
      return;
    }
    this.easing = {
      fromX: this.centerX,
      fromY: this.centerY,
      fromZoom: this.zoom,
      toX: x,
      toY: y,
      toZoom: zoom,
      start: Number.NaN,
      durationMs,
    };
  }

  /** Fill fractions and centering shift for a viewport: `[fillX, fillY, shiftX, shiftY]`. */
  private frame(w: number, h: number): readonly [number, number, number, number] {
    const padding = this.padding;
    if (padding === null) return [FIT_FILL, FIT_FILL, 0, 0];
    const [top, right, bottom, left] =
      typeof padding === 'number' ? [padding, padding, padding, padding] : padding;
    return [
      Math.max(MIN_FILL, (w - left - right) / w),
      Math.max(MIN_FILL, (h - top - bottom) / h),
      (left - right) / 2,
      (top - bottom) / 2,
    ];
  }

  /** Clamp a zoom to `[min(fitZoom / 4, 0.25), 8]`, `fitZoom` framing the content bounds. */
  private clampZoom(zoom: number): number {
    return Math.min(MAX_ZOOM, Math.max(this.minZoom(), zoom));
  }

  /** The farthest zoom: a quarter of the content's fit zoom, and never closer than 0.25. */
  private minZoom(): number {
    const bounds = this.bounds;
    if (bounds === null || !this.hasViewport()) return MIN_ZOOM_CEILING;
    const [fillX, fillY] = this.frame(this.vpW, this.vpH);
    const bw = bounds[2] - bounds[0];
    const bh = bounds[3] - bounds[1];
    const zx = bw > 0 ? (this.vpW * fillX) / bw : Number.POSITIVE_INFINITY;
    const zy = bh > 0 ? (this.vpH * fillY) / bh : Number.POSITIVE_INFINITY;
    const fit = Math.min(zx, zy);
    if (!Number.isFinite(fit)) return MIN_ZOOM_CEILING;
    return Math.min(fit / MIN_ZOOM_BELOW_FIT, MIN_ZOOM_CEILING);
  }
}
