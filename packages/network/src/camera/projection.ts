import type { ProjectionRegion } from '../webgpu/uniforms.js';

/** Fraction of the viewport used when fitting graph bounds. */
export const FIT_PAD = 0.85;

/** Maximum zoom-in ratio relative to the fitted view. */
export const MAX_ZOOM_RATIO = 512;

/**
 * State slot reserved for the projection's zoom scalar.
 *
 * The anchored-zoom machinery owns this slot and the drag mirror skips it.
 */
export const ZOOM_SLOT = 2;

/** Graph bounds in world space (flat: [cx, cy]; globe: [lon, lat]). */
export interface GraphBounds {
  /** Minimum horizontal coordinate or longitude. */
  xMin: number;
  /** Maximum horizontal coordinate or longitude. */
  xMax: number;
  /** Minimum vertical coordinate or latitude. */
  yMin: number;
  /** Maximum vertical coordinate or latitude. */
  yMax: number;
}

/** A 2D point in projection world coordinates. */
export type Vec2 = [number, number];

/** Render viewport size in CSS pixels. */
export type Viewport = {
  /** Width in CSS pixels. */
  w: number;
  /** Height in CSS pixels. */
  h: number;
};

/**
 * A point on the camera's 3-D state manifold.
 *
 * Flat: [cx, cy, scale], Euclidean and linear in all axes.
 * Globe: [lon, lat, dist], spherical in lon/lat and linear in dist.
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
 */
export type Tangent = Float64Array;

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
 * A lossy, projection-independent view snapshot for continuity across
 * projection switches.
 *
 * The snapshot carries the world point at the view center and the screen
 * scale there. Geometry only; user intent (`fitIntent`) is a Camera property
 * and travels with the rig, not the snapshot.
 */
export interface PoseSnapshot {
  /** World x coordinate or longitude at the view center. */
  centerX: number;
  /** World y coordinate or latitude at the view center. */
  centerY: number;
  /** Screen pixels per world unit at the view center. */
  pxPerWorld: number;
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
  /**
   * State/tangent dimensionality.
   *
   * Convention: slots 0 and 1 are the primary surface orientation, ZOOM_SLOT
   * is the zoom scalar, and slots 3+ are projection extras. The Camera's
   * chase/coast/snap machinery is dimension-blind; only allocations and the
   * two slot conventions read this.
   */
  readonly stateSize: number;

  /** Return the state that frames `bounds` in `vp`. */
  fit(bounds: GraphBounds, vp: Viewport): CameraState;

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
   * Omitted by projections without a rotational degree of freedom.
   */
  rotate?(state: CameraState, dxPx: number, dyPx: number, vp: Viewport): void;

  /** Export a projection-independent pose, or null when continuity is unavailable. */
  exportPose?(state: CameraState, vp: Viewport): PoseSnapshot | null;

  /**
   * Return the state that is visually continuous with `pose`.
   *
   * Tilt returns pitch 0, which is pixel-identical to the flat view it came
   * from.
   */
  importPose?(pose: PoseSnapshot, vp: Viewport): CameraState;

  /**
   * Mutate `target` to the state where an imported pose should settle.
   *
   * Called once by `Camera.initFrom` after a successful import.
   */
  settleImportedPose?(target: CameraState): void;

  /** Pack the current state into GPU uniforms for the active projection. */
  pack(state: CameraState, region: ProjectionRegion, vp: Viewport): void;
}

/** Allocate a zero-filled tangent buffer of the projection's dimension. */
export function createTangent(size = 3): Tangent {
  return new Float64Array(size);
}
