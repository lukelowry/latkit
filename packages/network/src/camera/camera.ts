import type {
  Projection,
  CameraState,
  Tangent,
  PanSession,
  PlaneView,
  PoseSnapshot,
  Vec2,
  Viewport,
  GraphBounds,
} from './projection.js';
import type { ProjectionRegion } from '../webgpu/uniforms.js';
import { createTangent, ZOOM_SLOT } from './projection.js';

/** Cubic smoothstep: C1 at both ends, zero derivative at t=0 and t=1. */
const smoothStep = (t: number): number => t * t * (3 - 2 * t);

/** Duration of the fit-to-bounds transition in ms. */
const FIT_MS = 500;

/** Coast decay rate per ms; 0.008 approximates exp(-1) in ~125ms. */
const COAST_K = 0.008;

/** Below this tangent norm times decay, coast has died and stops integrating. */
const COAST_MIN_V = 0.01;

/** Time constant for exponential chase from current to target, in ms. */
const CHASE_TAU = 87;

/** Ignore velocity samples from drag deltas shorter than this, in ms. */
const VEL_MIN_DT = 0.5;

/** EMA blend factor for drag velocity sampling. */
const VEL_ALPHA = 0.3;

/** Below this tangent norm at drag-end, no coast is emitted. */
const COAST_THRESHOLD = 0.05;

/** Anchored zoom releases when relative zoom error falls below this value. */
const ZOOM_EPSILON = 0.001;

/**
 * Chase termination threshold in CSS pixels.
 *
 * When the remaining current-to-target motion would shift no on-screen
 * content by more than this, `current` snaps onto `target` and the loop stops.
 */
const SNAP_PX = 0.25;

/** Camera math requires a finite, non-empty CSS-pixel viewport. */
function validViewport(vp: Viewport): boolean {
  return Number.isFinite(vp.w) && Number.isFinite(vp.h) && vp.w > 0 && vp.h > 0;
}

/** Camera fits require finite, ordered coordinate bounds. */
function validBounds(bounds: GraphBounds): boolean {
  return (
    Number.isFinite(bounds.xMin) &&
    Number.isFinite(bounds.xMax) &&
    Number.isFinite(bounds.yMin) &&
    Number.isFinite(bounds.yMax) &&
    bounds.xMin <= bounds.xMax &&
    bounds.yMin <= bounds.yMax
  );
}

/** Exact state equality; projection mutators clamp deterministically. */
function sameState(a: CameraState, b: CameraState): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Motion driver for the target state.
 *
 * `idle` means the target is static. `dragging` tracks pointer deltas.
 * `coasting` drifts along a decaying tangent after drag release. `fitting`
 * drives `current` directly and keeps `target` slaved to it.
 */
type Motion =
  | { kind: 'idle' }
  | { kind: 'dragging'; session: PanSession }
  | { kind: 'coasting'; tangent: Tangent; t0: number; from: CameraState }
  | { kind: 'fitting'; from: CameraState; to: CameraState; t0: number };

/** Outcome of a projection-preserving reveal command. */
export type RevealResult = 'unavailable' | 'unchanged' | 'claimed' | 'moved';

/** Cursor anchor captured during a wheel or pinch zoom. */
interface Anchor {
  /** World point that should remain under the cursor. */
  world: Vec2;
  /** Screen point, in CSS pixels, that owns the anchor. */
  screen: Vec2;
}

/** Projection-agnostic camera controller for gestures, fitting, and animation. */
export class Camera {
  /** The state actually rendered each frame. */
  readonly current: CameraState;
  /** The state user input wants to reach; `current` chases this exponentially. */
  readonly target: CameraState;
  /** Latest computed fit view, used as the zoom clamp reference. */
  private fit: CameraState | null = null;

  /**
   * Whether the user currently intends to stay at the fitted view.
   *
   * This is distinct from the current pose. It becomes true on `init` and
   * `fitView`, and false on pan, rotate, or zoom. The render loop uses it to
   * decide whether viewport changes should auto-refit.
   */
  fitIntent = true;

  private motion: Motion = { kind: 'idle' };
  private anchor: Anchor | null = null;
  private lastT = 0;

  /** Drag velocity EMA, retained across drag samples until the next begin. */
  private readonly vel: Tangent;
  /** Scratch tangent reused for per-sample delta during drag. */
  private readonly scratchTangent: Tangent;
  /** Scratch state reused to validate target-space input before interruption. */
  private readonly scratchState: CameraState;
  private lastDragT = 0;
  /** Camera state at `lastDragT`, retained across too-dense spatial samples. */
  private readonly velocityState: CameraState;

  /** Create a camera bound to a projection and its GPU uniform region. */
  constructor(
    private readonly proj: Projection,
    private readonly region: ProjectionRegion,
  ) {
    // All state/tangent buffers are sized by the projection, so the chase,
    // coast, and snap machinery below is dimension-blind.
    this.current = new Float64Array(proj.stateSize) as CameraState;
    this.target = new Float64Array(proj.stateSize) as CameraState;
    this.velocityState = new Float64Array(proj.stateSize) as CameraState;
    this.vel = createTangent(proj.stateSize);
    this.scratchTangent = createTangent(proj.stateSize);
    this.scratchState = new Float64Array(proj.stateSize) as CameraState;
  }

  /** Place current, target, and fit state from graph bounds. */
  init(bounds: GraphBounds, vp: Viewport): void {
    const s = this.proj.fit(bounds, vp);
    this.current.set(s);
    this.target.set(s);
    // Own a separate copy: mutations to `current`/`target` must not leak
    // into the fit reference used by zoom clamps and isAtFitView().
    this.fit = this.proj.clone(s);
    this.lastT = performance.now();
    this.motion = { kind: 'idle' };
    this.anchor = null;
    // init is the canonical "place the camera at fit". Both first-load and
    // RenderLoop's auto-refit-on-resize path enter through here, so this is
    // the right place to assert the intent.
    this.fitIntent = true;
  }

  /**
   * Place the camera from an imported pose when supported, else from bounds.
   *
   * The fit reference always derives from the bounds; a pose import restores
   * carried `fitIntent` instead of resetting it. Returns false when the
   * viewport has no area and the caller should defer placement.
   */
  initFrom(
    pose: PoseSnapshot | null,
    fitIntent: boolean,
    bounds: GraphBounds,
    vp: Viewport,
  ): boolean {
    if (vp.w <= 0 || vp.h <= 0) return false;
    const imported = pose ? this.proj.importPose?.(pose, vp) : undefined;
    this.init(bounds, vp);
    if (imported) {
      this.current.set(imported);
      this.target.set(imported);
      this.fitIntent = fitIntent;
      // The projection may prefer to settle elsewhere; the chase animates it.
      this.proj.settleImportedPose?.(this.target);
    }
    return true;
  }

  /** Retarget one view of the current camera family without replacing state. */
  setView(view: PlaneView, bounds: GraphBounds | null, vp: Viewport): boolean {
    if (!this.proj.setView) return false;
    const intent = this.fitIntent;
    this.interrupt();
    this.proj.setView(view, this.target);
    this.fitIntent = intent;
    if (!bounds || !validBounds(bounds) || !validViewport(vp)) return false;
    this.fit = this.proj.fit(bounds, vp);
    return true;
  }

  /** Apply a rotation gesture through the target chase. */
  rotateBy(dxPx: number, dyPx: number, vp: Viewport): boolean {
    if (
      !this.proj.rotate ||
      !Number.isFinite(dxPx) ||
      !Number.isFinite(dyPx) ||
      (dxPx === 0 && dyPx === 0) ||
      !validViewport(vp)
    ) {
      return false;
    }
    const driven = this.motion.kind === 'coasting' || this.motion.kind === 'fitting';
    const base = driven ? this.current : this.target;
    this.scratchState.set(base);
    this.proj.rotate(this.scratchState, dxPx, dyPx, vp);
    if (sameState(this.scratchState, base)) return false;
    if (driven) this.interrupt();
    this.target.set(this.scratchState);
    this.fitIntent = false;
    return true;
  }

  /**
   * Give new input ownership of the currently rendered pose.
   *
   * This is the gesture-boundary cancellation primitive: pending fit, coast,
   * chase, and cursor anchoring cannot leak into a newly started interaction.
   */
  private interrupt(time = performance.now()): void {
    this.target.set(this.current);
    this.motion = { kind: 'idle' };
    this.anchor = null;
    this.vel.fill(0);
    this.lastT = Number.isFinite(time) ? time : performance.now();
  }

  /** Start a drag gesture and capture the projection-specific pan session. */
  beginDrag(sx: number, sy: number, vp: Viewport, time = performance.now()): boolean {
    if (
      !Number.isFinite(sx) ||
      !Number.isFinite(sy) ||
      !validViewport(vp) ||
      !Number.isFinite(time)
    ) {
      return false;
    }
    this.interrupt(time);
    const session = this.proj.beginPan(this.current, sx, sy, vp);
    this.motion = { kind: 'dragging', session };
    this.anchor = null;
    this.vel.fill(0);
    this.lastDragT = time;
    this.velocityState.set(this.current);
    // Pan is a deliberate move off fit. `panBy` routes through here too.
    this.fitIntent = false;
    return true;
  }

  /** Apply one drag sample to current state and update drag velocity. */
  drag(
    dx: number,
    dy: number,
    sx: number,
    sy: number,
    vp: Viewport,
    time = performance.now(),
  ): boolean {
    if (this.motion.kind !== 'dragging') return false;
    if (
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      !Number.isFinite(sx) ||
      !Number.isFinite(sy) ||
      !Number.isFinite(time) ||
      !validViewport(vp) ||
      (dx === 0 && dy === 0)
    ) {
      return false;
    }

    this.scratchState.set(this.current);
    this.motion.session.apply(this.current, dx, dy, sx, sy, vp);
    const changed = !sameState(this.scratchState, this.current);

    // Mirror every non-zoom slot into target so chase is a no-op during the
    // drag. ZOOM_SLOT stays owned by anchored zoom, allowing wheel zoom during
    // a drag.
    for (let i = 0; i < this.current.length; i++) {
      if (i !== ZOOM_SLOT) this.target[i] = this.current[i];
    }

    // Velocity EMA over drag deltas, for coast-after-release. Length-generic
    // so extra slots contribute zero unless a projection chooses otherwise.
    const dt = time - this.lastDragT;
    if (dt > VEL_MIN_DT) {
      const inst = this.scratchTangent;
      this.proj.delta(inst, this.velocityState, this.current, dt);
      for (let i = 0; i < this.vel.length; i++) {
        this.vel[i] = this.vel[i] * (1 - VEL_ALPHA) + inst[i] * VEL_ALPHA;
      }
      this.velocityState.set(this.current);
      this.lastDragT = time;
    }

    // Wheel-zoom-during-drag coexistence: re-derive anchor.world from the
    // current screen point so the anchored-zoom constraint tracks the cursor.
    if (this.anchor) {
      const w = this.proj.screenToWorld(
        this.current,
        this.anchor.screen[0],
        this.anchor.screen[1],
        vp,
      );
      if (w) this.anchor.world = w;
    }
    return changed;
  }

  /** Perform a one-shot center pan, used by keyboard nudges. */
  panBy(dx: number, dy: number, vp: Viewport): boolean {
    if (
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      (dx === 0 && dy === 0) ||
      !validViewport(vp)
    ) {
      return false;
    }
    const sx = vp.w / 2;
    const sy = vp.h / 2;
    const time = performance.now();
    if (!this.beginDrag(sx, sy, vp, time)) return false;
    const changed = this.drag(dx, dy, sx + dx, sy + dy, vp, time);
    this.endDrag(false, time);
    return changed;
  }

  /** End the active drag and start coast when sampled velocity is high enough. */
  endDrag(coast = true, time = performance.now()): boolean {
    if (this.motion.kind !== 'dragging') return false;
    if (!coast) {
      this.target.set(this.current);
      this.motion = { kind: 'idle' };
      this.anchor = null;
      this.vel.fill(0);
      return true;
    }
    const releaseTime = Number.isFinite(time) ? Math.max(time, this.lastDragT) : performance.now();
    const idleMs = releaseTime - this.lastDragT;
    const releaseDecay = Math.exp(-idleMs * COAST_K);
    if (this.proj.tangentNorm(this.vel) * releaseDecay < COAST_THRESHOLD) {
      this.motion = { kind: 'idle' };
      return true;
    }
    const from = this.proj.clone(this.target);
    const tangent = new Float64Array(this.vel.length) as Tangent;
    for (let i = 0; i < tangent.length; i++) tangent[i] = this.vel[i] * releaseDecay;
    this.motion = {
      kind: 'coasting',
      tangent,
      from,
      t0: releaseTime,
    };
    return true;
  }

  /** Zoom toward `factor` while keeping the screen point anchored when possible. */
  zoomAt(factor: number, sx: number, sy: number, vp: Viewport): boolean {
    if (
      !Number.isFinite(factor) ||
      factor <= 0 ||
      factor === 1 ||
      !Number.isFinite(sx) ||
      !Number.isFinite(sy) ||
      !validViewport(vp)
    ) {
      return false;
    }
    const driven = this.motion.kind === 'coasting' || this.motion.kind === 'fitting';
    const base = driven ? this.current : this.target;
    this.scratchState.set(base);
    this.proj.zoom(this.scratchState, factor, this.fit);
    if (sameState(this.scratchState, base)) return false;
    // Fit/coast own target independently. Preserve the visible pose only once
    // this input has been proven to change the projection state.
    if (driven) this.interrupt();
    // Capture the world point under the cursor so chase can hold it there.
    const world = this.proj.screenToWorld(this.current, sx, sy, vp);
    this.anchor = world ? { world, screen: [sx, sy] } : null;
    this.target.set(this.scratchState);
    this.fitIntent = false;
    return true;
  }

  /** Animate from the current pose to a fresh fitted view. */
  fitView(bounds: GraphBounds, vp: Viewport): void {
    const to = this.proj.fit(bounds, vp);
    const from = this.proj.clone(this.current);
    this.fit = to;
    this.motion = { kind: 'fitting', from, to, t0: performance.now() };
    this.anchor = null;
    this.fitIntent = true;
  }

  /**
   * Move to arbitrary bounds without redefining the canonical fitted view.
   *
   * A unit projection zoom normalizes the candidate through the same
   * projection-specific clamp used by gestures. The canonical `fit` state is
   * deliberately retained for future zoom limits and `isAtFitView()` checks.
   * An already-satisfied move still takes camera ownership and clears fit
   * intent, matching an explicit subset-fit request.
   */
  moveTo(bounds: GraphBounds, vp: Viewport, animate: boolean): boolean {
    const fit = this.fit;
    if (!fit || !validBounds(bounds) || !validViewport(vp)) return false;

    const to = this.proj.fit(bounds, vp);
    this.proj.zoom(to, 1, fit);
    const from = this.proj.clone(this.current);
    const changed = !sameState(from, to);
    this.interrupt();
    this.fitIntent = false;
    if (!changed) return true;

    if (animate) {
      this.motion = { kind: 'fitting', from, to, t0: performance.now() };
    } else {
      this.current.set(to);
      this.target.set(to);
    }
    return true;
  }

  /**
   * Center arbitrary bounds while preserving projection, zoom, and orientation.
   *
   * `Projection.fit` owns coordinate normalization (notably longitude
   * wrapping and latitude clamping), but only its center slots are adopted.
   * The current zoom and projection-specific extras remain untouched.
   */
  reveal(bounds: GraphBounds, vp: Viewport, animate: boolean): RevealResult {
    if (!this.fit || !validBounds(bounds) || !validViewport(vp)) return 'unavailable';

    const to = this.proj.fit(bounds, vp);
    for (let i = ZOOM_SLOT; i < to.length; i++) to[i] = this.current[i]!;
    const changed = to[0] !== this.current[0] || to[1] !== this.current[1];
    if (!changed) return this.claimCurrent() ? 'claimed' : 'unchanged';

    let from: CameraState | undefined;
    if (animate) from = this.proj.clone(this.current);
    this.interrupt();
    this.fitIntent = false;

    if (from) {
      this.motion = { kind: 'fitting', from, to, t0: performance.now() };
    } else {
      this.current.set(to);
      this.target.set(to);
    }
    return 'moved';
  }

  /**
   * Let a no-op reveal supersede older motion without disturbing an idle view.
   *
   * Returns false when the camera already has no driver or residual chase.
   */
  claimCurrent(): boolean {
    let driven = this.motion.kind !== 'idle' || this.anchor !== null;
    if (!driven) {
      for (let i = 0; i < this.current.length; i++) {
        if (this.current[i] !== this.target[i]) {
          driven = true;
          break;
        }
      }
    }
    if (!driven) return false;
    this.interrupt();
    this.fitIntent = false;
    return true;
  }

  /** Advance animation state and pack the current projection uniforms. */
  tick(now: number, vp: Viewport): void {
    if (this.motion.kind === 'fitting') {
      // Fit drives `current` directly; chase is paused.
      const t = Math.min(1, (now - this.motion.t0) / FIT_MS);
      this.proj.mix(this.current, this.motion.from, this.motion.to, smoothStep(t));
      if (t >= 1) {
        this.target.set(this.current);
        this.motion = { kind: 'idle' };
      }
    } else {
      // Chase: exponential approach to target.
      const dt = now - this.lastT;
      if (dt > 0) {
        const alpha = 1 - Math.exp(-dt / CHASE_TAU);
        this.proj.mix(this.current, this.current, this.target, alpha);
        // Terminate deterministically once residual motion is sub-perceptual.
        if (this.anchor === null && this.proj.near(this.current, this.target, vp, SNAP_PX)) {
          this.current.set(this.target);
        }
      }

      // Anchored zoom: pull current so the grabbed world point stays under
      // the cursor. Slots 0/1/ZOOM_SLOT are the zoom-slot ownership boundary.
      if (this.anchor) {
        this.proj.snapToAnchor(this.current, this.anchor.world, this.anchor.screen, vp);
        this.target[0] = this.current[0];
        this.target[1] = this.current[1];
        const zoomErr =
          Math.abs(this.current[2] - this.target[2]) / Math.max(Math.abs(this.target[2]), 1e-9);
        if (zoomErr < ZOOM_EPSILON) {
          this.target[2] = this.current[2];
          this.anchor = null;
        }
      }
    }

    // Coast runs alongside chase: it updates `target`, chase pulls `current`
    // toward it on the next frame.
    if (this.motion.kind === 'coasting') {
      const elapsed = now - this.motion.t0;
      const decay = Math.exp(-elapsed * COAST_K);
      if (this.proj.tangentNorm(this.motion.tangent) * decay < COAST_MIN_V) {
        this.motion = { kind: 'idle' };
      } else {
        // Integral of exp(-K*s) from 0 to t = (1 - decay) / K.
        const integral = (1 - decay) / COAST_K;
        this.proj.advance(this.target, this.motion.from, this.motion.tangent, integral);
      }
    }

    this.lastT = now;
    this.proj.pack(this.current, this.region, vp);
  }

  /** Return true while the camera needs another animation frame. */
  isAnimating(): boolean {
    // A held-still drag is not "animating"; the gesture layer wakes us on
    // each delta. Only self-driven motion plus anchored zoom need rAF.
    if (this.motion.kind === 'coasting' || this.motion.kind === 'fitting') return true;
    if (this.anchor !== null) return true;
    // tick() snaps current onto target once the chase residual is
    // sub-perceptual, so exact equality over every slot is the convergence
    // signal.
    for (let i = 0; i < this.current.length; i++) {
      if (this.current[i] !== this.target[i]) return true;
    }
    return false;
  }

  /** Return true when current state is visibly at the last fitted view. */
  isAtFitView(): boolean {
    return this.fit !== null && this.proj.isAtFit(this.current, this.fit);
  }

  /** Map a screen point through the current projection state. */
  screenToWorld(sx: number, sy: number, vp: Viewport): Vec2 | null {
    return this.proj.screenToWorld(this.current, sx, sy, vp);
  }
}
