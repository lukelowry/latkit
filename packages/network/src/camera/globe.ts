import type { Projection, CameraState, PanSession, Vec2, Viewport } from './projection.js';
import { FIT_PAD, MAX_ZOOM_RATIO } from './projection.js';
import { DEG2RAD, RAD2DEG, xyzToGeo } from './geo.js';
import { sunDirection } from './solar.js';
import { mat4Mul, mat4Perspective, mat4Invert, mat4Unproject } from './mat4.js';
import { VISUAL } from '../visual.js';

/** Vertical field of view used by the perspective globe camera. */
const FOV_Y = 2 * Math.atan(1 / 3);
/** Tangent of half the globe field of view. */
const FOV_SCALE = Math.tan(FOV_Y / 2);
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

/** Return the physical camera distance, respecting minimum near-plane clearance. */
function cameraDistance(s: CameraState): number {
  return SURFACE_R + Math.max(effectiveClearance(s), MIN_CAMERA_CLEARANCE);
}

/** Return the narrowed FOV scale used when effective clearance is very small. */
function effectiveFovScale(s: CameraState): number {
  return FOV_SCALE * Math.min(1, effectiveClearance(s) / MIN_CAMERA_CLEARANCE);
}

/** Return the vertical FOV derived from the effective FOV scale. */
function effectiveFovY(s: CameraState): number {
  return 2 * Math.atan(effectiveFovScale(s));
}

// Zero-alloc scratch shared across all globe projections. Safe to share because
// no function using these arrays yields mid-use.
const _unprojNear = new Float64Array(3);
const _unprojFar = new Float64Array(3);
const _geoOut = new Float64Array(2);

/** Create the perspective globe projection. */
export function createGlobeProjection(): Projection {
  // State layout: [lon (deg), lat (deg), dist]. Below the safe camera
  // clearance, dist remains the effective zoom distance while the physical
  // camera stays outside the surface and the FOV narrows.

  const vpMatrix = new Float32Array(16);
  const cameraPos = new Float32Array(3);
  const projM = new Float32Array(16);
  const viewM = new Float32Array(16);
  const invVP = new Float32Array(16);

  // Solar light direction is cached and refreshed at most every 30s via
  // pack(). A canvas-level timer wakes the render loop on the same cadence so
  // the terminator stays live while idle.
  let lightDir: [number, number, number] = sunDirection(new Date());
  let lightStamp = Date.now();

  // VP matrix cache, rebuilt on state or viewport change.
  const vpStamp = new Float64Array(5); // [lon, lat, dist, vpW, vpH]
  let vpValid = false;
  let invVpValid = false;

  /** Return true when the cached view-projection matrix no longer matches. */
  function vpDirty(s: CameraState, vp: Viewport): boolean {
    return (
      s[0] !== vpStamp[0] ||
      s[1] !== vpStamp[1] ||
      s[2] !== vpStamp[2] ||
      vp.w !== vpStamp[3] ||
      vp.h !== vpStamp[4]
    );
  }

  /** Rebuild cached view/projection matrices for `s` and `vp` when needed. */
  function buildVP(s: CameraState, vp: Viewport): void {
    if (vpValid && !vpDirty(s, vp)) return;

    const lonR = s[0] * DEG2RAD;
    const latR = s[1] * DEG2RAD;
    const dist = cameraDistance(s);
    const clat = Math.cos(latR),
      slat = Math.sin(latR);
    const clon = Math.cos(lonR),
      slon = Math.sin(lonR);

    // Camera position on sphere of radius `dist`.
    // Convention: +lon maps to -Z (matches xyzToGeo's atan2(-z, x)).
    const fx = clat * clon,
      fy = slat,
      fz = -clat * slon;
    cameraPos[0] = fx * dist;
    cameraPos[1] = fy * dist;
    cameraPos[2] = fz * dist;

    // Camera basis: right = -normalize(forward x worldY), up = forward x right.
    const rx = -slon,
      rz = -clon;
    const ux = -slat * clon,
      uy = clat,
      uz = slat * slon;

    // View matrix (column-major): rows are right, up, forward.
    viewM[0] = rx;
    viewM[1] = ux;
    viewM[2] = fx;
    viewM[3] = 0;
    viewM[4] = 0;
    viewM[5] = uy;
    viewM[6] = fy;
    viewM[7] = 0;
    viewM[8] = rz;
    viewM[9] = uz;
    viewM[10] = fz;
    viewM[11] = 0;
    viewM[12] = -(rx * cameraPos[0] + rz * cameraPos[2]);
    viewM[13] = -(ux * cameraPos[0] + uy * cameraPos[1] + uz * cameraPos[2]);
    viewM[14] = -(fx * cameraPos[0] + fy * cameraPos[1] + fz * cameraPos[2]);
    viewM[15] = 1;

    mat4Perspective(projM, effectiveFovY(s), vp.w / vp.h, NEAR, FAR);
    mat4Mul(vpMatrix, projM, viewM);

    invVpValid = false;
    vpStamp[0] = s[0];
    vpStamp[1] = s[1];
    vpStamp[2] = s[2];
    vpStamp[3] = vp.w;
    vpStamp[4] = vp.h;
    vpValid = true;
  }

  /** Mark cached view-projection matrices as stale. */
  function invalidate(): void {
    vpValid = false;
    invVpValid = false;
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
    if (!invVpValid) {
      mat4Invert(invVP, vpMatrix);
      invVpValid = true;
    }

    const nx = (sx / vp.w) * 2 - 1;
    const ny = 1 - (sy / vp.h) * 2;
    mat4Unproject(_unprojNear, nx, ny, 0, invVP);
    mat4Unproject(_unprojFar, nx, ny, 1, invVP);

    const dx = _unprojFar[0] - _unprojNear[0];
    const dy = _unprojFar[1] - _unprojNear[1];
    const dz = _unprojFar[2] - _unprojNear[2];
    const ox = _unprojNear[0],
      oy = _unprojNear[1],
      oz = _unprojNear[2];

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

  return {
    stateSize: 3,

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
      return new Float64Array([centerLon, centerLat, dist]);
    },

    clone(s): CameraState {
      return new Float64Array(s);
    },

    screenToWorld(s, sx, sy, vp) {
      return rayCast(s, sx, sy, vp);
    },

    mix(out, a, b, t) {
      out[0] = a[0] + lonDelta(a[0], b[0]) * t;
      out[1] = a[1] + (b[1] - a[1]) * t;
      out[2] = a[2] + (b[2] - a[2]) * t;
      invalidate();
    },

    delta(out, a, b, dt) {
      // Lon tangent stores arc-rate, scaled by cosLat of destination lat, so
      // `tangentNorm` treats pan-near-pole and pan-near-equator equally.
      const cosLat = Math.cos(b[1] * DEG2RAD);
      out[0] = (lonDelta(a[0], b[0]) * cosLat) / dt;
      out[1] = (b[1] - a[1]) / dt;
      out[2] = (b[2] - a[2]) / dt;
    },

    advance(out, s, tangent, scalar) {
      // Inverse of delta(): divide lon-tangent by cosLat to restore deg/s.
      const cosLat = Math.cos(s[1] * DEG2RAD);
      out[0] = wrapLon(s[0] + (cosLat > 0.01 ? tangent[0] / cosLat : 0) * scalar);
      out[1] = clampLat(s[1] + tangent[1] * scalar);
      out[2] = s[2] + tangent[2] * scalar;
      invalidate();
    },

    tangentNorm(t) {
      return Math.hypot(t[0], t[1]);
    },

    near(a, b, vp, epsPx) {
      // Screen pixels per radian of surface arc at the view center, using the
      // same clearance/FOV quantities pack() and fit() use.
      const clearance = Math.max(effectiveClearance(a), MIN_EFFECTIVE_CLEARANCE);
      const pxPerRad = (vp.h * 0.5) / (clearance * effectiveFovScale(a));
      const cosLat = Math.cos(a[1] * DEG2RAD);
      if (Math.abs(lonDelta(a[0], b[0])) * cosLat * DEG2RAD * pxPerRad > epsPx) return false;
      if (Math.abs(a[1] - b[1]) * DEG2RAD * pxPerRad > epsPx) return false;
      // A dist delta shifts edge-of-screen content by the relative clearance
      // change times half the viewport height.
      return (Math.abs(a[2] - b[2]) / clearance) * vp.h * 0.5 <= epsPx;
    },

    isAtFit(current, fit): boolean {
      return (
        Math.abs(current[2] / fit[2] - 1) < 0.01 &&
        Math.abs(lonDelta(current[0], fit[0])) < 0.1 &&
        Math.abs(current[1] - fit[1]) < 0.1
      );
    },

    beginPan(state, startSx, startSy, startVp): PanSession {
      // Capture the world point under the cursor when the drag began. On each
      // apply, re-raycast the cursor and orbit so the original world point
      // tracks back to the current screen point.
      const grab = rayCast(state, startSx, startSy, startVp);
      return {
        apply(s, dx, dy, sx, sy, vp) {
          if (grab) {
            const cur = rayCast(s, sx, sy, vp);
            if (cur) {
              orbit(s, grab[0] - cur[0], grab[1] - cur[1]);
              return;
            }
          }
          const spd =
            ((2 * Math.atan(effectiveFovScale(s)) * RAD2DEG) / Math.max(vp.h, 1)) *
            cameraDistance(s);
          orbit(s, -dx * spd, dy * spd);
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
      if (!cur) return;
      orbit(s, worldPt[0] - cur[0], worldPt[1] - cur[1]);
    },

    pack(s, region, vp) {
      buildVP(s, vp);
      region.setVP(vpMatrix);
      region.setCameraPos(cameraPos[0], cameraPos[1], cameraPos[2]);
      region.fovScale = effectiveFovScale(s);

      const now = Date.now();
      if (now - lightStamp > 30_000) {
        lightDir = sunDirection(new Date(now));
        lightStamp = now;
      }
      region.setLightDir(lightDir[0], lightDir[1], lightDir[2]);
    },
  };
}
