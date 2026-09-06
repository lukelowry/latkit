import { Camera } from './camera.js';
import { DEFAULT_OPTIONS, type Insets } from '../options.js';
import { PROJECTION_DEFS, type Projection } from '../projections.js';
import {
  DEFAULT_FIT_FRAME,
  type FitFrame,
  type Pose,
  type PlaneView,
  type CameraProjection,
  type Viewport,
} from './projection.js';
import type { Bounds } from '../topology/types.js';
import type { CameraRegion } from '../webgpu/uniforms.js';

/** The fit options the rig turns into a frame per viewport. */
export interface FitOptions {
  /** Inset in CSS px, or null for the default fill fraction. */
  readonly paddingPx: Insets | null;
  /** Pitch in degrees, or null for the view's own rest. */
  readonly pitch: number | null;
  /** Bearing in degrees clockwise from north. */
  readonly bearing: number;
}

/** The least a padded fit may fill, so an inset larger than the canvas still shows something. */
const MIN_FILL = 0.05;

/** Camera command retained until the first frame with a usable viewport. */
type Pending =
  | { readonly kind: 'move'; readonly bounds: Bounds; readonly animate: boolean }
  | { readonly kind: 'reveal'; readonly bounds: Bounds; readonly animate: boolean }
  | {
      readonly kind: 'place';
      readonly pose: Pose;
      readonly px: number;
      readonly fitIntent: boolean;
    };

/** Camera math requires a finite, non-empty CSS-pixel viewport. */
function usable(vp: Viewport): boolean {
  return Number.isFinite(vp.w) && Number.isFinite(vp.h) && vp.w > 0 && vp.h > 0;
}

/**
 * The single camera authority: active projection, mode, bounds, and deferred
 * placement. Commands apply immediately under a usable viewport, else they
 * are retained (`needsFit` + one `pending` slot) and replayed on the first
 * sized frame; the render loop only calls `tick()`.
 */
export class CameraRig {
  /** Camera bound to the active projection; identity changes on family switches. */
  camera: Camera;
  /** CameraProjection implementation currently used for camera math and uniform packing. */
  private projection: CameraProjection;
  private modeValue: Projection = 'flat';
  /** Topology bounds used for canonical fits; null before a scene loads. */
  private bounds: Bounds | null = null;
  /** Canonical fit/init required before the next rendered frame. */
  private needsFit = false;
  /** Latest deferred command; applied after any canonical fit. */
  private pending: Pending | null = null;
  /** Fit reference is stale (in-family view switch) and needs a refresh. */
  private fitStale = false;
  /** Last viewport a frame was ticked under; carries poses across hidden spells. */
  private readonly lastVp: Viewport = { w: 0, h: 0 };
  /** The live fit options; every fit derives its frame from them. */
  private fitOptions: FitOptions = {
    paddingPx: DEFAULT_OPTIONS.fitPaddingPx,
    pitch: DEFAULT_OPTIONS.fitPitch,
    bearing: DEFAULT_OPTIONS.fitBearing,
  };

  /** Duration of an animated fit, reveal, or pose; the live `animationMs` option. */
  animationMs = DEFAULT_OPTIONS.animationMs;

  /** Creates a rig with the flat projection as the initial mode. */
  constructor(private readonly region: CameraRegion) {
    this.projection = PROJECTION_DEFS.flat.create();
    this.camera = this.createCamera();
  }

  /** A camera over the active projection that shares the rig's animation duration and fit frame. */
  private createCamera(): Camera {
    return new Camera(
      this.projection,
      this.region,
      () => this.animationMs,
      (vp) => this.frameFor(vp),
    );
  }

  /**
   * Change how fits frame the scene. A camera at fit re-lands on the next frame, as a resize
   * would; an explored pose keeps its place and only its fit reference follows.
   */
  setFitOptions(options: FitOptions): void {
    this.fitOptions = options;
    if (this.camera.fitIntent) this.needsFit = true;
    else this.fitStale = true;
  }

  /** The frame for one viewport: a pixel inset becomes a fill fraction and a centering shift. */
  private frameFor(vp: Viewport): FitFrame {
    const { paddingPx, pitch, bearing } = this.fitOptions;
    if (paddingPx === null || !usable(vp)) {
      if (pitch === null && bearing === 0) return DEFAULT_FIT_FRAME;
      return { fill: DEFAULT_FIT_FRAME.fill, shiftPx: DEFAULT_FIT_FRAME.shiftPx, pitch, bearing };
    }
    const [top, right, bottom, left] =
      typeof paddingPx === 'number' ? [paddingPx, paddingPx, paddingPx, paddingPx] : paddingPx;
    return {
      fill: [
        Math.max(MIN_FILL, (vp.w - left - right) / vp.w),
        Math.max(MIN_FILL, (vp.h - top - bottom) / vp.h),
      ],
      shiftPx: [(left - right) / 2, (top - bottom) / 2],
      pitch,
      bearing,
    };
  }

  /** Public projection mode corresponding to the active projection implementation. */
  get mode(): Projection {
    return this.modeValue;
  }

  /** True while a deferred camera command awaits a sized frame. */
  get pendingPlacement(): boolean {
    return this.needsFit || this.pending !== null;
  }

  /**
   * Replace the scene bounds. A new scene schedules its canonical fit; with `fit` false a placed
   * camera keeps its pose and only its fit reference follows the new bounds.
   */
  setBounds(bounds: Bounds | null, fit = true): void {
    this.bounds = bounds;
    this.pending = null;
    if (bounds === null) {
      this.needsFit = false;
      return;
    }
    if (fit || !this.camera.placed) this.needsFit = true;
    else this.fitStale = true;
  }

  /** Fit the whole scene: animated when possible, else on the next sized frame. */
  fit(vp: Viewport, animate: boolean): void {
    if (!this.bounds) return;
    // An unplaced camera has no view to animate from; defer to the canonical fit.
    if (animate && usable(vp) && this.camera.placed) {
      this.needsFit = false;
      this.pending = null;
      this.camera.fitView(this.bounds, vp);
    } else {
      this.needsFit = true;
      this.pending = null;
    }
  }

  /** Frame subset bounds now, or after canonical placement on the next sized frame. */
  moveTo(bounds: Bounds, vp: Viewport, animate: boolean): void {
    if (usable(vp) && this.camera.moveTo(bounds, vp, animate)) {
      this.needsFit = false;
      this.pending = null;
      return;
    }
    this.needsFit = true;
    this.pending = { kind: 'move', bounds, animate };
  }

  /** Center bounds preserving zoom and orientation, deferring while unusable. */
  reveal(bounds: Bounds, vp: Viewport, animate: boolean): void {
    if (!usable(vp)) {
      // Zero-size initial placement already retains needsFit; established
      // cameras must keep their current zoom when the viewport returns.
      this.pending = { kind: 'reveal', bounds, animate };
      return;
    }
    const result = this.camera.reveal(bounds, vp, animate);
    if (result === 'unavailable') {
      this.needsFit = true;
      this.pending = { kind: 'reveal', bounds, animate };
    } else if (result === 'unchanged') {
      this.dropDeferredMove();
    } else {
      this.needsFit = false;
      this.pending = null;
    }
  }

  /**
   * Let the rendered pose supersede stale motion and deferred moves: a
   * claimed camera cancels all deferred placement, an idle one only drops
   * deferred moves.
   */
  claim(): boolean {
    const claimed = this.camera.claimCurrent();
    if (claimed) {
      this.needsFit = false;
      this.pending = null;
    } else {
      this.dropDeferredMove();
    }
    return claimed;
  }

  /**
   * Switch projection mode, always preserving the current view.
   *
   * In-family switches retarget the shared camera. Cross-family switches
   * behave as if a frame ticked first: deferred commands flush into the
   * outgoing camera against the live (or last rendered) viewport, then the
   * settled pose and anchor scale carry into the new camera. A view is only
   * surrendered to the canonical fit while fit intent is active.
   */
  switchTo(mode: Projection, vp: Viewport): void {
    if (mode === this.modeValue) return;
    const sameFamily = PROJECTION_DEFS[this.modeValue].family === PROJECTION_DEFS[mode].family;
    if (sameFamily) {
      this.modeValue = mode;
      this.camera.setView(mode as PlaneView, usable(vp) ? vp : this.lastVp, this.bounds);
      this.fitStale = true;
      return;
    }

    // Flush before modeValue changes so the deferred replay is exactly the
    // one a rendered frame under the outgoing mode would have performed.
    const ref = usable(vp) ? vp : usable(this.lastVp) ? this.lastVp : null;
    if (ref && this.bounds) this.apply(ref);
    const carried = ref !== null && !this.camera.fitIntent ? this.camera.carry(ref) : null;
    const fitIntent = this.camera.fitIntent;
    this.modeValue = mode;
    this.projection = PROJECTION_DEFS[mode].create();
    this.camera = this.createCamera();
    if (carried) {
      this.needsFit = false;
      this.pending = { kind: 'place', pose: carried.pose, px: carried.px, fitIntent };
    } else {
      this.needsFit = true;
    }
    if (usable(vp) && this.bounds) this.apply(vp);
  }

  /**
   * Advance one frame: deferred placement, fit upkeep, chase, uniform pack.
   *
   * Returns false when no scene is loaded and the frame should be skipped.
   */
  tick(now: number, vp: Viewport): boolean {
    if (!this.bounds) return false;
    if (usable(vp)) {
      const resized = vp.w !== this.lastVp.w || vp.h !== this.lastVp.h;
      // A viewport change under active fit intent re-fits so the scene stays
      // centered; an explored pose is preserved and only its fit reference
      // (zoom clamps, isAtFitView) tracks the new viewport.
      if (resized && this.camera.fitIntent) this.needsFit = true;
      if (!this.needsFit && (resized || this.fitStale)) {
        this.camera.refreshFit(this.bounds, vp);
      }
      this.fitStale = false;
      this.apply(vp);
      this.lastVp.w = vp.w;
      this.lastVp.h = vp.h;
    }
    this.camera.tick(now, vp);
    return true;
  }

  /** True while the camera needs another animation frame. */
  isAnimating(): boolean {
    return this.camera.isAnimating();
  }

  /** True when the rendered state is visibly at the last fitted view. */
  isAtFitView(): boolean {
    return this.camera.isAtFitView();
  }

  /** Drop a deferred move or reveal while preserving fits and pose carries. */
  private dropDeferredMove(): void {
    if (this.pending && this.pending.kind !== 'place') this.pending = null;
  }

  /** Apply the canonical fit and any pending command under a sized viewport. */
  private apply(vp: Viewport): void {
    const bounds = this.bounds!;
    if (this.needsFit) {
      this.camera.init(bounds, vp);
      this.needsFit = false;
    }
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (!this.camera.placed) this.camera.init(bounds, vp);
    switch (pending.kind) {
      case 'move':
        this.camera.moveTo(pending.bounds, vp, pending.animate);
        break;
      case 'reveal':
        this.camera.reveal(pending.bounds, vp, pending.animate);
        break;
      case 'place':
        this.camera.place(pending.pose, pending.px, pending.fitIntent, bounds, vp);
        // Let the incoming view ease fields it prefers at rest (tilt's pitch).
        this.projection.setView?.(this.modeValue as PlaneView, this.camera.target);
        break;
    }
  }
}
