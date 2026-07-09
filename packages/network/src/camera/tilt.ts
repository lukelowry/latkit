import type { Projection, CameraState, PanSession, Vec2, Viewport } from './projection.js';
import { FIT_PAD, MAX_ZOOM_RATIO, ZOOM_SLOT } from './projection.js';
import { DEG2RAD } from './geo.js';
import { mat4Mul, mat4Perspective, mat4Invert, mat4Unproject } from './mat4.js';

// Perspective over the ground plane z = 0. The camera orbits a look-at point
// on the plane. State layout: [lookX, lookY, dist, pitchDeg, bearingDeg].
// Pitch 0 is nadir, pixel-identical to flat for zero-height scenes. Bearing
// wraps, and pitch is clamped below MAX_PITCH.
//
// Camera basis must match tilt_ray_dir in shaders/projections/tilt-ray.wgsl,
// pinned by parity tests. With p = pitch and b = bearing:
//   eye = look + dist * (sin b * sin p, -cos b * sin p, cos p)
//   right = (cos b, sin b, 0)
//   up = backward x right, where backward = normalize(eye - look)

/** Vertical field of view used by the tilt perspective camera. */
const FOV_Y = 2 * Math.atan(1 / 3);
/** Tangent of half the tilt field of view. */
const FOV_SCALE = Math.tan(FOV_Y / 2);
/** Maximum pitch in degrees before horizon interactions become unstable. */
const MAX_PITCH = 85;
/** Default resting pitch for imported flat-continuous poses. */
const DEFAULT_PITCH = 55;
/** Bearing rotation speed in degrees per horizontal screen pixel. */
const BEARING_DEG_PER_PX = 0.4;
/** Pitch rotation speed in degrees per vertical screen pixel. */
const PITCH_DEG_PER_PX = 0.25;
/**
 * Near plane as a fraction of camera height above the plane.
 *
 * Derived from height, not look distance, so grazing pitch does not clip the
 * foreground plane.
 */
const NEAR_HEIGHT_FACTOR = 0.1;
/** Far plane in look distances, covering the horizon-faded grid reach. */
const FAR_DIST_FACTOR = 50;
/** Default minimum look distance when no fit state is available. */
const DIST_MIN_DEFAULT = 1e-6;
/** Default maximum look distance when no fit state is available. */
const DIST_MAX_DEFAULT = 1e9;

/** Wrap an angle in degrees to [0, 360). */
function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Return the shortest signed bearing delta from `a` to `b`. */
function bearingDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Clamp a number to an inclusive range. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Clamp a pitch angle to the supported tilt range. */
function clampPitch(pitch: number): number {
  return clamp(pitch, 0, MAX_PITCH);
}

/** Return screen pixels per world unit at the look point. */
function pxPerWorldAt(s: CameraState, vp: Viewport): number {
  return vp.h / 2 / (s[2] * FOV_SCALE);
}

// Zero-alloc scratch shared across all tilt projections. Safe to share because
// no function using these arrays yields mid-use.
const _unprojNear = new Float64Array(3);
const _unprojFar = new Float64Array(3);

/** Create the tilted perspective plane projection. */
export function createTiltProjection(): Projection {
  const vpMatrix = new Float32Array(16);
  const eye = new Float32Array(3);
  const projM = new Float32Array(16);
  const viewM = new Float32Array(16);
  const invVP = new Float32Array(16);

  // VP matrix cache, rebuilt on state or viewport change.
  const vpStamp = new Float64Array(7); // [lookX, lookY, dist, pitch, bearing, vpW, vpH]
  let vpValid = false;
  let invVpValid = false;

  /** Return true when the cached view-projection matrix no longer matches. */
  function vpDirty(s: CameraState, vp: Viewport): boolean {
    return (
      s[0] !== vpStamp[0] ||
      s[1] !== vpStamp[1] ||
      s[2] !== vpStamp[2] ||
      s[3] !== vpStamp[3] ||
      s[4] !== vpStamp[4] ||
      vp.w !== vpStamp[5] ||
      vp.h !== vpStamp[6]
    );
  }

  /** Rebuild cached view/projection matrices for `s` and `vp` when needed. */
  function buildVP(s: CameraState, vp: Viewport): void {
    if (vpValid && !vpDirty(s, vp)) return;

    const p = s[3] * DEG2RAD;
    const b = s[4] * DEG2RAD;
    const sp = Math.sin(p),
      cp = Math.cos(p);
    const sb = Math.sin(b),
      cb = Math.cos(b);
    const dist = s[2];

    // backward = normalize(eye - look) = (sb*sp, -cb*sp, cp)
    const bx = sb * sp,
      by = -cb * sp,
      bz = cp;
    eye[0] = s[0] + bx * dist;
    eye[1] = s[1] + by * dist;
    eye[2] = bz * dist;

    // right = (cb, sb, 0); up = backward x right. These are the same rows the
    // background shader's tilt_ray_dir reconstructs from tilt_params.
    const rx = cb,
      ry = sb;
    const ux = by * 0 - bz * ry; // backward x right, expanded
    const uy = bz * rx - bx * 0;
    const uz = bx * ry - by * rx;

    // View matrix (column-major): rows are right, up, backward.
    viewM[0] = rx;
    viewM[1] = ux;
    viewM[2] = bx;
    viewM[3] = 0;
    viewM[4] = ry;
    viewM[5] = uy;
    viewM[6] = by;
    viewM[7] = 0;
    viewM[8] = 0;
    viewM[9] = uz;
    viewM[10] = bz;
    viewM[11] = 0;
    viewM[12] = -(rx * eye[0] + ry * eye[1]);
    viewM[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    viewM[14] = -(bx * eye[0] + by * eye[1] + bz * eye[2]);
    viewM[15] = 1;

    // Near derives from camera height above the plane, so grazing pitch never
    // clips the foreground; far spans the faded grid.
    const near = Math.max(eye[2] * NEAR_HEIGHT_FACTOR, dist * 1e-5);
    mat4Perspective(projM, FOV_Y, vp.w / vp.h, near, dist * FAR_DIST_FACTOR);
    mat4Mul(vpMatrix, projM, viewM);

    invVpValid = false;
    vpStamp[0] = s[0];
    vpStamp[1] = s[1];
    vpStamp[2] = s[2];
    vpStamp[3] = s[3];
    vpStamp[4] = s[4];
    vpStamp[5] = vp.w;
    vpStamp[6] = vp.h;
    vpValid = true;
  }

  /** Mark cached view-projection matrices as stale. */
  function invalidate(): void {
    vpValid = false;
    invVpValid = false;
  }

  // Cursor-ray plane hit, closure-scoped like the VP caches it depends on.
  const _hit = new Float64Array(3);

  /**
   * Intersect a cursor ray with the ground plane z = 0.
   *
   * Writes the hit into `_hit`. Returns false at/above the horizon or on a
   * degenerate ray.
   */
  function rayPlaneHit(s: CameraState, sx: number, sy: number, vp: Viewport): boolean {
    buildVP(s, vp);
    if (!invVpValid) {
      mat4Invert(invVP, vpMatrix);
      invVpValid = true;
    }

    const nx = (sx / vp.w) * 2 - 1;
    const ny = 1 - (sy / vp.h) * 2;
    mat4Unproject(_unprojNear, nx, ny, 0, invVP);
    mat4Unproject(_unprojFar, nx, ny, 1, invVP);

    const dz = _unprojFar[2] - _unprojNear[2];
    if (!(dz < -1e-12)) return false;
    const t = -_unprojNear[2] / dz;
    if (t < 0 || !Number.isFinite(t)) return false;

    _hit[0] = _unprojNear[0] + (_unprojFar[0] - _unprojNear[0]) * t;
    _hit[1] = _unprojNear[1] + (_unprojFar[1] - _unprojNear[1]) * t;
    _hit[2] = 0;
    return true;
  }

  return {
    stateSize: 5,

    fit(b, vp): CameraState {
      // Flat framing converted to look distance. Fit returns the resting view,
      // so it uses DEFAULT_PITCH; pitch 0 is only the flat-continuity anchor
      // inside importPose.
      const bw = b.xMax - b.xMin || 1;
      const bh = b.yMax - b.yMin || 1;
      const scale = Math.min((vp.w * FIT_PAD) / bw, (vp.h * FIT_PAD) / bh);
      const dist = vp.h / 2 / (scale * FOV_SCALE);
      return Float64Array.of(
        (b.xMin + b.xMax) / 2,
        (b.yMin + b.yMax) / 2,
        dist,
        DEFAULT_PITCH,
        0,
      ) as CameraState;
    },

    clone(s): CameraState {
      return new Float64Array(s) as CameraState;
    },

    screenToWorld(s, sx, sy, vp): Vec2 | null {
      if (!rayPlaneHit(s, sx, sy, vp)) return null;
      return [_hit[0], _hit[1]];
    },

    // Manifold algebra: linear in look/dist/pitch, circular in bearing.
    mix(out, a, b, t) {
      out[0] = a[0] + (b[0] - a[0]) * t;
      out[1] = a[1] + (b[1] - a[1]) * t;
      out[2] = a[2] + (b[2] - a[2]) * t;
      out[3] = a[3] + (b[3] - a[3]) * t;
      out[4] = a[4] + bearingDelta(a[4], b[4]) * t;
    },

    delta(out, a, b, dt) {
      out[0] = (b[0] - a[0]) / dt;
      out[1] = (b[1] - a[1]) / dt;
      out[2] = (b[2] - a[2]) / dt;
      out[3] = (b[3] - a[3]) / dt;
      out[4] = bearingDelta(a[4], b[4]) / dt;
    },

    advance(out, s, tangent, scalar) {
      out[0] = s[0] + tangent[0] * scalar;
      out[1] = s[1] + tangent[1] * scalar;
      out[2] = s[2] + tangent[2] * scalar;
      out[3] = clampPitch(s[3] + tangent[3] * scalar);
      out[4] = wrap360(s[4] + tangent[4] * scalar);
    },

    tangentNorm(t) {
      return Math.hypot(t[0], t[1]);
    },

    near(a, b, vp, epsPx) {
      const ppw = pxPerWorldAt(a, vp);
      if (Math.abs(a[0] - b[0]) * ppw > epsPx) return false;
      if (Math.abs(a[1] - b[1]) * ppw > epsPx) return false;
      // A dist delta shifts edge-of-screen content by the relative change
      // times half the viewport extent; pitch/bearing by edge-of-screen arc.
      const ext = Math.max(vp.w, vp.h) * 0.5;
      if ((Math.abs(a[2] - b[2]) / Math.max(a[2], 1e-12)) * ext > epsPx) return false;
      if (Math.abs(a[3] - b[3]) * DEG2RAD * ext > epsPx) return false;
      return Math.abs(bearingDelta(a[4], b[4])) * DEG2RAD * ext <= epsPx;
    },

    isAtFit(current, fit): boolean {
      // Look tolerance is a fraction of the fit view's world half-height.
      const halfExtent = fit[2] * FOV_SCALE;
      return (
        Math.abs(current[2] / fit[2] - 1) < 0.01 &&
        Math.abs(current[0] - fit[0]) / halfExtent < 0.005 &&
        Math.abs(current[1] - fit[1]) / halfExtent < 0.005 &&
        Math.abs(current[3] - fit[3]) < 0.1 &&
        Math.abs(bearingDelta(current[4], fit[4])) < 0.1
      );
    },

    beginPan(state, startSx, startSy, startVp): PanSession {
      // Grab-pan on the plane: remember the world point under the cursor, then
      // each apply re-raycasts and translates look by (grab - hit). Fall back
      // to bearing-aware linear pan when the cursor leaves the plane.
      const grabbed = rayPlaneHit(state, startSx, startSy, startVp);
      const grabX = _hit[0],
        grabY = _hit[1];
      return {
        apply(s, dx, dy, sx, sy, vp) {
          if (grabbed && rayPlaneHit(s, sx, sy, vp)) {
            s[0] += grabX - _hit[0];
            s[1] += grabY - _hit[1];
            invalidate();
            return;
          }
          // Screen axes in world terms: right = (cos b, sin b), screen-up on
          // the plane = (-sin b, cos b); flat's -dx/+dy rule, rotated.
          const wpp = 1 / pxPerWorldAt(s, vp);
          const b = s[4] * DEG2RAD;
          const cb = Math.cos(b),
            sb = Math.sin(b);
          s[0] += (-dx * cb - dy * sb) * wpp;
          s[1] += (-dx * sb + dy * cb) * wpp;
          invalidate();
        },
      };
    },

    zoom(s, factor, fitHint) {
      if (!Number.isFinite(factor) || factor <= 0) return;
      const min = fitHint ? fitHint[ZOOM_SLOT] / MAX_ZOOM_RATIO : DIST_MIN_DEFAULT;
      const max = fitHint ? fitHint[ZOOM_SLOT] : DIST_MAX_DEFAULT;
      // factor > 1 means "zoom in", so use a smaller look distance.
      s[ZOOM_SLOT] = clamp(s[ZOOM_SLOT] / factor, min, max);
      invalidate();
    },

    snapToAnchor(s, worldPt, screenPt, vp) {
      // Closed form on a plane: hit = raycast(screenPt); look += world - hit.
      if (!rayPlaneHit(s, screenPt[0], screenPt[1], vp)) return;
      s[0] += worldPt[0] - _hit[0];
      s[1] += worldPt[1] - _hit[1];
      invalidate();
    },

    rotate(state, dxPx, dyPx) {
      state[4] = wrap360(state[4] + dxPx * BEARING_DEG_PER_PX);
      // Drag up (negative dy) tilts toward the horizon.
      state[3] = clampPitch(state[3] - dyPx * PITCH_DEG_PER_PX);
      invalidate();
    },

    // Import lands at pitch 0 for flat-continuity, then settle tips the scene
    // to DEFAULT_PITCH through the camera chase.
    exportPose(s, vp) {
      return { centerX: s[0], centerY: s[1], pxPerWorld: pxPerWorldAt(s, vp) };
    },
    importPose(pose, vp) {
      const dist = vp.h / 2 / (pose.pxPerWorld * FOV_SCALE);
      return Float64Array.of(pose.centerX, pose.centerY, dist, 0, 0) as CameraState;
    },
    settleImportedPose(target) {
      target[3] = DEFAULT_PITCH;
    },

    pack(s, region, vp) {
      buildVP(s, vp);
      region.setVP(vpMatrix);
      region.setCameraPos(eye[0], eye[1], eye[2]);
      region.fovScale = FOV_SCALE; // matrix path: real depth, sort-bias off
      const b = s[4] * DEG2RAD;
      region.setTiltParams(s[0], s[1], Math.sin(b), Math.cos(b));
    },
  };
}
