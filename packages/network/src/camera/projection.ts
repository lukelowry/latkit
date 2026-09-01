import type { ProjectionRegion } from '../webgpu/uniforms.js';
import type { Bounds } from '../topology/types.js';
import { turn, wrap } from './geo.js';

/** Fraction of the viewport used when fitting graph bounds. */
export const FIT_PAD = 0.85;

/** Vertical field of view shared by every perspective camera. */
export const FOV_Y = 2 * Math.atan(1 / 3);

/** Tangent of half the shared vertical field of view. */
export const FOV_SCALE = 1 / 3;

/** Maximum zoom-in ratio relative to the fitted view. */
export const MAX_ZOOM_RATIO = 512;

/** Bearing change per horizontal rotation-gesture pixel, in degrees. */
export const BEARING_RATE = 0.4;

/** Pitch change per vertical rotation-gesture pixel, in degrees. */
export const PITCH_RATE = 0.25;

/**
 * State slot reserved for the projection's zoom scalar.
 *
 * The anchored-zoom machinery owns this slot and the drag mirror skips it.
 */
export const ZOOM_SLOT = 2;

/** A 2D point in projection world coordinates. */
export type Vec2 = [number, number];

/** Render viewport size in CSS pixels. */
export type Viewport = {
  /** Width in CSS pixels. */
  w: number;
  /** Height in CSS pixels. */
  h: number;
};

/** Camera families that share a state manifold and GPU pipeline. */
export type ProjectionFamily = 'plane' | 'globe';

/** Named views of the shared planar camera. */
export type PlaneView = 'flat' | 'tilt';

/**
 * A point on the camera's 5-D state manifold.
 *
 * Plane: [cx, cy, scale, pitch, bearing].
 * Globe: [lon, lat, dist, pitch, bearing], spherical in lon/lat and linear
 * in dist.
 *
 * The underlying storage is a Float64Array for zero-alloc math. Construct
 * via `Projection.fit()` or `Projection.clone()`; callers should not index
 * the array directly because slot semantics are projection-private.
 */
export type CameraState = Float64Array;

/**
 * A tangent vector at a camera state.
 *
 * This is the quantity produced by `delta()` and consumed by `advance()`.
 * Stored per-axis like state, but the units are normalized (e.g. globe
 * lon-tangent is an arc-rate, not deg/s) so `tangentNorm` can compare pan
 * speed fairly across latitudes.
 *
 * Slots:
 *   [0]: horizontal orientation tangent (flat: dx/dt; globe: arc-rate)
 *   [1]: vertical orientation tangent (flat: dy/dt; globe: dlat/dt deg/s)
 *   [2]: zoom tangent (flat: d(scale)/dt; globe: d(dist)/dt)
 *   [3]: pitch tangent, deg/s
 *   [4]: bearing tangent, deg/s
 */
export type Tangent = Float64Array;

/**
 * Projection-independent camera pose.
 *
 * Center is world units on the plane family and lon/lat degrees on the
 * globe; pitch is degrees off nadir (0 looks straight down) and bearing is
 * degrees clockwise from north. Zoom is deliberately absent: its units are
 * projection-specific and it stays behind `Network.zoomBy`.
 */
export interface CameraPose {
  /** World x coordinate or longitude at the view anchor. */
  readonly centerX: number;
  /** World y coordinate or latitude at the view anchor. */
  readonly centerY: number;
  /** Camera tilt off nadir in degrees. */
  readonly pitch: number;
  /** Camera heading in degrees clockwise from north. */
  readonly bearing: number;
}

/**
 * Live drag handle for a single drag gesture.
 *
 * Encapsulates the projection-specific grab point so the controller does not
 * need to know whether panning uses a flat-plane delta or a globe raycast.
 */
export interface PanSession {
  /** Apply one drag delta to `state`. Called per pointer move. */
  apply(state: CameraState, dx: number, dy: number, sx: number, sy: number, vp: Viewport): void;
}

/**
 * Pure geometry and manifold algebra for one camera coordinate system.
 *
 * A projection constructs camera states, maps screen pixels to world points,
 * provides interpolation/integration primitives for the controller, and packs
 * the current state into GPU uniforms. Animation state and renderer-only flags
 * live outside this interface.
 */
export interface Projection {
  /** State/pipeline family. Views in one family can transition in place. */
  readonly family: ProjectionFamily;
  /**
   * State/tangent dimensionality.
   *
   * Convention: slots 0 and 1 are the primary surface orientation, ZOOM_SLOT
   * is the zoom scalar, and slots 3+ are projection extras. The Camera's
   * chase/coast/snap machinery is dimension-blind; only allocations and the
   * two slot conventions read this.
   */
  readonly stateSize: number;

  /** Retarget a view without replacing the camera state. */
  setView?(view: PlaneView, target: CameraState): void;

  /**
   * Return the state that frames `bounds` in `vp`.
   *
   * Bounds are graph coordinates (flat: [x, y]; globe: [lon, lat] degrees).
   */
  fit(bounds: Bounds, vp: Viewport): CameraState;

  /** Return a detached copy of `state` with projection-owned storage. */
  clone(state: CameraState): CameraState;

  /**
   * Map a screen pixel to projection world coordinates.
   *
   * This backs cursor-anchored pan and zoom. Picking is GPU-side, so no CPU
   * projection of primitives lives on the projection.
   */
  screenToWorld(state: CameraState, sx: number, sy: number, vp: Viewport): Vec2 | null;

  /** Interpolate along the manifold: out = lerp/slerp-equivalent(a, b, t). */
  mix(out: CameraState, a: CameraState, b: CameraState, t: number): void;

  /** Pure difference: out = (b - a) / dt, in normalized tangent units. */
  delta(out: Tangent, a: CameraState, b: CameraState, dt: number): void;

  /** Integrate a tangent: out = state walked by (tangent * scalar). */
  advance(out: CameraState, state: CameraState, tangent: Tangent, scalar: number): void;

  /** L2 norm of the orientation component (ignores zoom). For coast threshold. */
  tangentNorm(tangent: Tangent): number;

  /**
   * Convergence predicate in screen space.
   *
   * Returns true when moving from `a` to `b` would shift no on-screen content
   * by more than `epsPx` CSS pixels at viewport `vp`.
   */
  near(a: CameraState, b: CameraState, vp: Viewport, epsPx: number): boolean;

  /** UI predicate: true when `current` is visibly at the `fit` view. */
  isAtFit(current: CameraState, fit: CameraState): boolean;

  /** Start a projection-specific pan gesture at a screen point. */
  beginPan(state: CameraState, sx: number, sy: number, vp: Viewport): PanSession;

  /** Mutate zoom in place. `fitHint` provides projection-specific zoom bounds. */
  zoom(state: CameraState, factor: number, fitHint: CameraState | null): void;

  /** Adjust orientation so `worldPt` projects back to `screenPt`. */
  snapToAnchor(state: CameraState, worldPt: Vec2, screenPt: Vec2, vp: Viewport): void;

  /**
   * Apply a rotation gesture to `state`.
   *
   * A view without rotational freedom (the flat plane) mutates nothing.
   */
  rotate(state: CameraState, dxPx: number, dyPx: number, vp: Viewport): void;

  /** Read the public pose from `state`. */
  pose(state: CameraState): CameraPose;

  /**
   * Merge a partial public pose into `state`.
   *
   * Owns wrapping and clamping for the active view; fields a view cannot
   * host (flat pitch/bearing) clamp to their resting value.
   */
  applyPose(state: CameraState, pose: Partial<CameraPose>): void;

  /**
   * Screen pixels per graph-coordinate y unit at the view anchor.
   *
   * Pitch-invariant by construction in every projection, so together with
   * `pose`/`applyPose` this scalar transfers a view across projection
   * switches: apply the pose, then `zoom` by `wanted / pxPerWorld(state)`.
   */
  pxPerWorld(state: CameraState, vp: Viewport): number;

  /** Pack the current state into GPU uniforms for the active projection. */
  pack(state: CameraState, region: ProjectionRegion, vp: Viewport): void;
}

/** Allocate a zero-filled tangent buffer of the projection's dimension. */
export function createTangent(size: number): Tangent {
  return new Float64Array(size);
}

// Shared implementations for the zoom/pitch/bearing slot tail (slots 2..4).
// Slots 0/1 stay per-projection: that is where the globe's spherical wrap and
// cosLat coupling live. Callers own their matrix invalidation.

/** Apply a rotation gesture to the pitch/bearing slots, clamped to `maxPitch`. */
export function rotateViewSlots(
  s: CameraState,
  dxPx: number,
  dyPx: number,
  maxPitch: number,
): void {
  s[4] = wrap(s[4]! + dxPx * BEARING_RATE);
  s[3] = Math.max(0, Math.min(maxPitch, s[3]! - dyPx * PITCH_RATE));
}

/** Read the public pose out of the shared state slot convention. */
export function statePose(s: CameraState): CameraPose {
  return { centerX: s[0]!, centerY: s[1]!, pitch: s[3]!, bearing: s[4]! };
}

/** Interpolate the slot tail: linear zoom and pitch, shortest-turn bearing. */
export function mixViewSlots(out: CameraState, a: CameraState, b: CameraState, t: number): void {
  out[2] = a[2]! + (b[2]! - a[2]!) * t;
  out[3] = a[3]! + (b[3]! - a[3]!) * t;
  out[4] = a[4]! + turn(a[4]!, b[4]!) * t;
}

/** Differentiate the slot tail into tangent rates. */
export function deltaViewSlots(out: Tangent, a: CameraState, b: CameraState, dt: number): void {
  out[2] = (b[2]! - a[2]!) / dt;
  out[3] = (b[3]! - a[3]!) / dt;
  out[4] = turn(a[4]!, b[4]!) / dt;
}

/** Integrate the slot tail, clamping pitch to `maxPitch` and wrapping bearing. */
export function advanceViewSlots(
  out: CameraState,
  s: CameraState,
  tangent: Tangent,
  amount: number,
  maxPitch: number,
): void {
  out[2] = s[2]! + tangent[2]! * amount;
  out[3] = Math.max(0, Math.min(maxPitch, s[3]! + tangent[3]! * amount));
  out[4] = wrap(s[4]! + tangent[4]! * amount);
}

/** Slot-tail agreement terms of `isAtFit`: relative zoom, pitch, bearing. */
export function viewSlotsAtFit(current: CameraState, fit: CameraState): boolean {
  return (
    Math.abs(current[2]! / fit[2]! - 1) < 0.01 &&
    Math.abs(current[3]! - fit[3]!) < 0.1 &&
    Math.abs(turn(current[4]!, fit[4]!)) < 0.1
  );
}
