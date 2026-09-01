import type { Projection, CameraState, PanSession, Vec2, Viewport } from './projection.js';
import {
  advanceViewSlots,
  deltaViewSlots,
  FIT_PAD,
  FOV_SCALE,
  MAX_ZOOM_RATIO,
  mixViewSlots,
  rotateViewSlots,
  statePose,
  viewSlotsAtFit,
} from './projection.js';
import { DEG2RAD, RAD2DEG, turn, wrap, xyzToGeo } from './geo.js';
import { mat4Mul, mat4Perspective } from './mat4.js';
import { createScreenRay } from './raycast.js';
import { VISUAL } from '../visual.js';

/** Perspective near plane in globe camera units. */
const NEAR = 0.005;
/** Perspective far plane in globe camera units. */
const FAR = 100;
/** Rendered globe surface radius, including the visual surface offset. */
const SURFACE_R = 1 + VISUAL.globeSurfaceOffset;
/** Minimum physical camera clearance used to avoid clipping the surface. */
const MIN_CAMERA_CLEARANCE = NEAR * 2;
/** Minimum effective zoom clearance used for math near the surface. */
const MIN_EFFECTIVE_CLEARANCE = 1e-6;
/** Minimum stored camera distance from the globe center. */
const MIN_DIST = SURFACE_R + MIN_EFFECTIVE_CLEARANCE;
/** Maximum stored camera distance from the globe center. */
const MAX_DIST = 5.0;
/** Maximum camera latitude in degrees, keeping the basis stable near poles. */
const MAX_LAT = 89.9;
/** Maximum camera pitch in degrees; higher poses drown the frame in sky. */
const MAX_PITCH = 75;
/** Raycast trust radius in degrees of longitude from the camera meridian;
 *  inside it the grab/anchor fixed-point update provably contracts. */
const TRUST_ARC_DEG = 60;
/** Grab-tracking demotes to screen-speed panning when one event demands more
 *  than this multiple of the screen-speed arc (grazing-incidence blowup). */
const PAN_DEMOTE_RATIO = 4;
/** Per-frame anchor correction cap in degrees of arc; larger demands are
 *  pathological and skipped. */
const SNAP_MAX_ARC_DEG = 5;

/** Wrap longitude to [-180, 180]. */
function wrapLon(lon: number): number {
  return (((lon % 360) + 540) % 360) - 180;
}

/** Return the shortest signed longitude delta from `a` to `b`. */
function lonDelta(a: number, b: number): number {
  return wrapLon(b - a);
}

/** Clamp latitude to the supported camera range. */
function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** Clamp pitch to the supported camera range. */
function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(MAX_PITCH, pitch));
}

/** Clamp a number to an inclusive range. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Return the camera distance required to fit one angular half-extent. */
function fitDistance(halfAngleRad: number, axisFovScale: number): number {
  const a = clamp(Math.abs(halfAngleRad), 1e-6, Math.PI * 0.49);
  return SURFACE_R * (Math.cos(a) + Math.sin(a) / (FIT_PAD * axisFovScale));
}

/** Return zoom clearance above the rendered surface with a numeric floor. */
function effectiveClearance(s: CameraState): number {
  return Math.max(s[2] - SURFACE_R, MIN_EFFECTIVE_CLEARANCE);
}

/**
 * Physical clearance floor for one pitch: solves |anchor + c * backward| =
 * SURFACE_R + MIN_CAMERA_CLEARANCE so the orbiting eye keeps near-plane
 * margin from the sphere at any pitch.
 */
function clearanceFloor(pitchRad: number): number {
  const rc = SURFACE_R * Math.cos(pitchRad);
  const m = MIN_CAMERA_CLEARANCE;
  return Math.sqrt(rc * rc + m * (2 * SURFACE_R + m)) - rc;
}

/** Return the camera-to-anchor distance, respecting the pitch clearance floor. */
function physicalClearance(s: CameraState): number {
  return Math.max(effectiveClearance(s), clearanceFloor(s[3] * DEG2RAD));
}

/**
 * Narrowed FOV scale below the clearance floor. Keeps physicalClearance *
 * effectiveFovScale == FOV_SCALE * effectiveClearance at any pitch, so zoom
 * semantics and screen-space metrics never depend on pitch.
 */
function effectiveFovScale(s: CameraState): number {
  return FOV_SCALE * Math.min(1, effectiveClearance(s) / clearanceFloor(s[3] * DEG2RAD));
}

/** Return the vertical FOV derived from the effective FOV scale. */
function effectiveFovY(s: CameraState): number {
  return 2 * Math.atan(effectiveFovScale(s));
}

/** Return degrees of surface arc that one CSS pixel spans at the view anchor. */
function arcDegPerPx(s: CameraState, vp: Viewport): number {
  const worldPerPx = (2 * physicalClearance(s) * effectiveFovScale(s)) / Math.max(vp.h, 1);
  return (worldPerPx * RAD2DEG) / SURFACE_R;
}

// Zero-alloc scratch shared across all globe projections. Safe to share because
// no function using these arrays yields mid-use.
const _geoOut = new Float64Array(2);

/** Create the perspective globe projection. */
export function createGlobeProjection(): Projection {
  // State layout: [lon (deg), lat (deg), dist, pitch (deg), bearing (deg)].
  // The camera orbits the surface anchor at (lon, lat) and looks at it; pitch
  // tilts it off nadir and bearing turns it clockwise from north. Below the
  // pitch-dependent clearance floor, dist remains the effective zoom distance
  // while the physical camera stays outside the surface and the FOV narrows.

  const vpMatrix = new Float32Array(16);
  const cameraPos = new Float32Array(3);
  const projM = new Float32Array(16);
  const viewM = new Float32Array(16);
  const screenRay = createScreenRay();

  // VP matrix cache, rebuilt on state or viewport change.
  const vpStamp = new Float64Array(7); // [lon, lat, dist, pitch, bearing, vpW, vpH]
  let vpValid = false;

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

    const lonR = s[0] * DEG2RAD;
    const latR = s[1] * DEG2RAD;
    const pitchR = s[3] * DEG2RAD;
    const bearingR = s[4] * DEG2RAD;
    const cl = Math.cos(lonR),
      sl = Math.sin(lonR);
    const cf = Math.cos(latR),
      sf = Math.sin(latR);
    const cp = Math.cos(pitchR),
      sp = Math.sin(pitchR);
    const cb = Math.cos(bearingR),
      sb = Math.sin(bearingR);

    // Local surface triad at the anchor.
    // Convention: +lon maps to -Z (matches xyzToGeo's atan2(-z, x)).
    const rx = cf * cl,
      ry = sf,
      rz = -cf * sl; // radial
    const ex = -sl,
      ez = -cl; // east (ey = 0)
    const nx = -sf * cl,
      ny = cf,
      nz = sf * sl; // north

    // Bearing turns the horizontal frame; pitch orbits the camera off nadir
    // around the bearing-rotated east axis. All closed-form and orthonormal:
    // no cross products, no normalization, no degeneracy at nadir or poles.
    const hx = cb * nx - sb * ex,
      hy = cb * ny,
      hz = cb * nz - sb * ez; // screen-up on the ground
    const bx = cb * ex + sb * nx,
      by = sb * ny,
      bz = cb * ez + sb * nz; // screen-right
    const fx = cp * rx - sp * hx,
      fy = cp * ry - sp * hy,
      fz = cp * rz - sp * hz; // backward (eye minus anchor)
    const ux = sp * rx + cp * hx,
      uy = sp * ry + cp * hy,
      uz = sp * rz + cp * hz; // up

    const c = physicalClearance(s);
    cameraPos[0] = SURFACE_R * rx + c * fx;
    cameraPos[1] = SURFACE_R * ry + c * fy;
    cameraPos[2] = SURFACE_R * rz + c * fz;

    // View matrix (column-major): rows are right, up, backward. The
    // translation collapses analytically: right.eye = 0, up.eye =
    // SURFACE_R*sin(pitch), backward.eye = SURFACE_R*cos(pitch) + c.
    viewM[0] = bx;
    viewM[1] = ux;
    viewM[2] = fx;
    viewM[3] = 0;
    viewM[4] = by;
    viewM[5] = uy;
    viewM[6] = fy;
    viewM[7] = 0;
    viewM[8] = bz;
    viewM[9] = uz;
    viewM[10] = fz;
    viewM[11] = 0;
    viewM[12] = 0;
    viewM[13] = -SURFACE_R * sp;
    viewM[14] = -(SURFACE_R * cp + c);
    viewM[15] = 1;

    mat4Perspective(projM, effectiveFovY(s), vp.w / vp.h, NEAR, FAR);
    mat4Mul(vpMatrix, projM, viewM);

    screenRay.invalidate();
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
    screenRay.invalidate();
  }

  // Cursor-ray hit point, closure-scoped like the VP caches it depends on.
  const _hit = new Float64Array(3);

  /**
   * Intersect a cursor ray with the unit sphere.
   *
   * Writes the hit point into `_hit`. Returns false on miss or a degenerate
   * ray, such as a 0x0 viewport mid-resize.
   */
  function raySphereHit(s: CameraState, sx: number, sy: number, vp: Viewport): boolean {
    buildVP(s, vp);
    if (!screenRay.cast(vpMatrix, sx, sy, vp)) return false;

    const dx = screenRay.dir[0],
      dy = screenRay.dir[1],
      dz = screenRay.dir[2];
    const ox = screenRay.origin[0],
      oy = screenRay.origin[1],
      oz = screenRay.origin[2];

    const a = dx * dx + dy * dy + dz * dz;
    if (a === 0) return false;
    const b = 2 * (ox * dx + oy * dy + oz * dz);
    const c = ox * ox + oy * oy + oz * oz - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) return false;

    _hit[0] = ox + dx * t;
    _hit[1] = oy + dy * t;
    _hit[2] = oz + dz * t;
    return true;
  }

  /** Map a screen pixel to a unit-sphere hit in [lon, lat] degrees. */
  function rayCast(s: CameraState, sx: number, sy: number, vp: Viewport): Vec2 | null {
    if (!raySphereHit(s, sx, sy, vp)) return null;
    xyzToGeo(_geoOut, _hit[0], _hit[1], _hit[2]);
    return [_geoOut[0], _geoOut[1]];
  }

  /** Mutate state orientation by dLon/dLat, wrapping lon and clamping lat. */
  function orbit(s: CameraState, dLon: number, dLat: number): void {
    s[0] = wrapLon(s[0] + dLon);
    s[1] = clampLat(s[1] + dLat);
    invalidate();
  }

  /**
   * Pan by screen speed at the anchor (bearing-rotated, pitch-foreshortened);
   * its ground speed must match grab-tracking or the demotion seam hitches.
   */
  function panFallback(s: CameraState, dx: number, dy: number, vp: Viewport): void {
    const degPerPx = arcDegPerPx(s, vp);
    const bearingR = s[4] * DEG2RAD;
    const cb = Math.cos(bearingR),
      sb = Math.sin(bearingR);
    const gr = -dx * degPerPx;
    const gh = (dy * degPerPx) / Math.max(Math.cos(s[3] * DEG2RAD), 0.25);
    const cosLat = Math.max(Math.cos(s[1] * DEG2RAD), 0.01);
    orbit(s, (gr * cb - gh * sb) / cosLat, gr * sb + gh * cb);
  }

  return {
    stateSize: 5,

    fit(b, vp): CameraState {
      const centerLon = wrapLon((b.xMin + b.xMax) / 2);
      const centerLat = clampLat((b.yMin + b.yMax) / 2);
      const halfLon = Math.abs(b.xMax - b.xMin) * 0.5 * DEG2RAD;
      const halfLat = Math.abs(b.yMax - b.yMin) * 0.5 * DEG2RAD;
      const latScale = Math.max(0.05, Math.cos(centerLat * DEG2RAD));
      const aspect = Math.max(vp.w / Math.max(vp.h, 1), 1e-6);
      const dist = clamp(
        Math.max(
          fitDistance(halfLon * latScale, FOV_SCALE * aspect),
          fitDistance(halfLat, FOV_SCALE),
        ),
        MIN_DIST,
        MAX_DIST,
      );
      return Float64Array.of(centerLon, centerLat, dist, 0, 0) as CameraState;
    },

    clone(s): CameraState {
      return new Float64Array(s) as CameraState;
    },

    screenToWorld(s, sx, sy, vp) {
      return rayCast(s, sx, sy, vp);
    },

    mix(out, a, b, t) {
      out[0] = a[0] + lonDelta(a[0], b[0]) * t;
      out[1] = a[1] + (b[1] - a[1]) * t;
      mixViewSlots(out, a, b, t);
      invalidate();
    },

    delta(out, a, b, dt) {
      // Lon tangent stores arc-rate, scaled by cosLat of destination lat, so
      // `tangentNorm` treats pan-near-pole and pan-near-equator equally.
      const cosLat = Math.cos(b[1] * DEG2RAD);
      out[0] = (lonDelta(a[0], b[0]) * cosLat) / dt;
      out[1] = (b[1] - a[1]) / dt;
      deltaViewSlots(out, a, b, dt);
    },

    advance(out, s, tangent, scalar) {
      // Inverse of delta(): divide lon-tangent by cosLat to restore deg/s.
      const cosLat = Math.cos(s[1] * DEG2RAD);
      out[0] = wrapLon(s[0] + (cosLat > 0.01 ? tangent[0] / cosLat : 0) * scalar);
      out[1] = clampLat(s[1] + tangent[1] * scalar);
      advanceViewSlots(out, s, tangent, scalar, MAX_PITCH);
      invalidate();
    },

    tangentNorm(t) {
      return Math.hypot(t[0], t[1]);
    },

    near(a, b, vp, epsPx) {
      // Screen pixels per radian of surface arc at the view anchor, using the
      // pitch-invariant clearance/FOV product pack() and fit() rely on.
      const pxPerRad = (vp.h * 0.5) / (physicalClearance(a) * effectiveFovScale(a));
      const cosLat = Math.cos(a[1] * DEG2RAD);
      if (Math.abs(lonDelta(a[0], b[0])) * cosLat * DEG2RAD * pxPerRad > epsPx) return false;
      if (Math.abs(a[1] - b[1]) * DEG2RAD * pxPerRad > epsPx) return false;
      // View rotations move content at pixel radius rho by rho*delta radians;
      // bound with the viewport extent, independent of zoom.
      const extent = Math.max(vp.w, vp.h) * 0.5;
      if (Math.abs(a[3] - b[3]) * DEG2RAD * extent > epsPx) return false;
      if (Math.abs(turn(a[4], b[4])) * DEG2RAD * extent > epsPx) return false;
      // A dist delta shifts edge-of-screen content by the relative clearance
      // change times half the viewport height.
      const clearance = Math.max(effectiveClearance(a), MIN_EFFECTIVE_CLEARANCE);
      return (Math.abs(a[2] - b[2]) / clearance) * vp.h * 0.5 <= epsPx;
    },

    isAtFit(current, fit): boolean {
      return (
        viewSlotsAtFit(current, fit) &&
        Math.abs(lonDelta(current[0], fit[0])) < 0.1 &&
        Math.abs(current[1] - fit[1]) < 0.1
      );
    },

    beginPan(state, startSx, startSy, startVp): PanSession {
      // Orbit so the grabbed world point tracks the cursor. Trusted only
      // inside TRUST_ARC_DEG; one demotion latches screen-speed panning for
      // the rest of the gesture (re-trusting would snap the stale grab point
      // back under the cursor).
      const grab = rayCast(state, startSx, startSy, startVp);
      let trusted = grab !== null && Math.abs(lonDelta(state[0], grab[0])) <= TRUST_ARC_DEG;
      return {
        apply(s, dx, dy, sx, sy, vp) {
          if (trusted && grab) {
            const cur = rayCast(s, sx, sy, vp);
            if (cur && Math.abs(lonDelta(s[0], cur[0])) <= TRUST_ARC_DEG) {
              const dLon = lonDelta(cur[0], grab[0]);
              const dLat = grab[1] - cur[1];
              const stepArc = Math.hypot(dLat, dLon * Math.cos(s[1] * DEG2RAD));
              const eventArc = arcDegPerPx(s, vp) * Math.hypot(dx, dy);
              if (stepArc <= Math.max(PAN_DEMOTE_RATIO * eventArc, 1)) {
                orbit(s, dLon, dLat);
                return;
              }
            }
            trusted = false;
          }
          panFallback(s, dx, dy, vp);
        },
      };
    },

    zoom(s, factor, fitHint) {
      if (!Number.isFinite(factor) || factor <= 0) return;

      // Caller factor > 1 means "zoom in", so scale clearance above the
      // globe instead of center-to-camera distance.
      const fitClearance = fitHint ? effectiveClearance(fitHint) : MIN_CAMERA_CLEARANCE;
      const minClearance = Math.max(fitClearance / MAX_ZOOM_RATIO, MIN_EFFECTIVE_CLEARANCE);
      const maxClearance = MAX_DIST - SURFACE_R;
      s[2] = SURFACE_R + clamp(effectiveClearance(s) / factor, minClearance, maxClearance);
      invalidate();
    },

    snapToAnchor(s, worldPt, screenPt, vp) {
      const cur = rayCast(s, screenPt[0], screenPt[1], vp);
      if (!cur || Math.abs(lonDelta(s[0], cur[0])) > TRUST_ARC_DEG) return;
      const dLon = lonDelta(cur[0], worldPt[0]);
      const dLat = worldPt[1] - cur[1];
      if (Math.hypot(dLat, dLon * Math.cos(s[1] * DEG2RAD)) > SNAP_MAX_ARC_DEG) return;
      orbit(s, dLon, dLat);
    },

    rotate(s, dx, dy) {
      rotateViewSlots(s, dx, dy, MAX_PITCH);
      invalidate();
    },

    pose: statePose,

    applyPose(s, pose) {
      if (pose.centerX !== undefined) s[0] = wrapLon(pose.centerX);
      if (pose.centerY !== undefined) s[1] = clampLat(pose.centerY);
      if (pose.pitch !== undefined) s[3] = clampPitch(pose.pitch);
      if (pose.bearing !== undefined) s[4] = wrap(pose.bearing);
      invalidate();
    },

    pxPerWorld(s, vp) {
      // Pixels per degree of surface arc at the anchor - pitch-invariant, and
      // directly transferable to the planar family, whose world unit is the
      // degree whenever a topology can host the globe at all.
      return 1 / arcDegPerPx(s, vp);
    },

    pack(s, region, vp) {
      buildVP(s, vp);
      region.setVP(vpMatrix);
      region.setCameraPos(cameraPos[0], cameraPos[1], cameraPos[2]);
      region.setViewBasis(viewM);
      region.fovScale = effectiveFovScale(s);
      region.depthMix = 1;
    },
  };
}
