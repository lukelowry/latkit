import type { Projection, CameraState, PanSession, Vec2 } from './projection.js';
import { FIT_PAD, MAX_ZOOM_RATIO } from './projection.js';

/** Default minimum flat scale when no fit state is available. */
const SCALE_MIN_DEFAULT = 0.001;

/** Create the orthographic plane projection. */
export function createFlatProjection(): Projection {
  // State layout: [cx, cy, scale]. Scale is pixels per world unit.

  // Closure-scoped drag session state. A single session is reused across
  // pointer moves; there is never more than one drag in flight per canvas.
  const panSession: PanSession = {
    apply(state, dx, dy) {
      state[0] -= dx / state[2];
      state[1] += dy / state[2];
    },
  };

  return {
    stateSize: 3,

    fit(b, vp): CameraState {
      const bw = b.xMax - b.xMin || 1;
      const bh = b.yMax - b.yMin || 1;
      return new Float64Array([
        (b.xMin + b.xMax) / 2,
        (b.yMin + b.yMax) / 2,
        Math.min((vp.w * FIT_PAD) / bw, (vp.h * FIT_PAD) / bh),
      ]);
    },

    clone(s): CameraState {
      return new Float64Array(s);
    },

    screenToWorld(s, sx, sy, vp): Vec2 {
      return [(sx - vp.w / 2) / s[2] + s[0], -(sy - vp.h / 2) / s[2] + s[1]];
    },

    // Flat's center/scale is already the projection-independent snapshot.
    exportPose(s) {
      return { centerX: s[0], centerY: s[1], pxPerWorld: Math.abs(s[2]) };
    },
    importPose(pose) {
      return Float64Array.of(pose.centerX, pose.centerY, pose.pxPerWorld) as CameraState;
    },

    mix(out, a, b, t) {
      out[0] = a[0] + (b[0] - a[0]) * t;
      out[1] = a[1] + (b[1] - a[1]) * t;
      out[2] = a[2] + (b[2] - a[2]) * t;
    },

    delta(out, a, b, dt) {
      out[0] = (b[0] - a[0]) / dt;
      out[1] = (b[1] - a[1]) / dt;
      out[2] = (b[2] - a[2]) / dt;
    },

    advance(out, s, tangent, scalar) {
      out[0] = s[0] + tangent[0] * scalar;
      out[1] = s[1] + tangent[1] * scalar;
      out[2] = s[2] + tangent[2] * scalar;
    },

    tangentNorm(t) {
      return Math.hypot(t[0], t[1]);
    },

    near(a, b, vp, epsPx) {
      const s = Math.max(Math.abs(a[2]), Math.abs(b[2]), 1e-12);
      if (Math.abs(a[0] - b[0]) * s > epsPx) return false;
      if (Math.abs(a[1] - b[1]) * s > epsPx) return false;
      // A zoom delta shifts edge-of-screen content by the relative scale
      // error times half the larger viewport extent.
      return (Math.abs(a[2] - b[2]) / s) * Math.max(vp.w, vp.h) * 0.5 <= epsPx;
    },

    isAtFit(current, fit): boolean {
      return (
        Math.abs(current[2] / fit[2] - 1) < 0.01 &&
        Math.abs(current[0] - fit[0]) * fit[2] < 1 &&
        Math.abs(current[1] - fit[1]) * fit[2] < 1
      );
    },

    beginPan(_s, _sx, _sy, _vp): PanSession {
      return panSession;
    },

    zoom(s, factor, fitHint) {
      const min = fitHint ? fitHint[2] : SCALE_MIN_DEFAULT;
      const max = fitHint ? fitHint[2] * MAX_ZOOM_RATIO : 1e6;
      s[2] = Math.max(min, Math.min(max, s[2] * factor));
    },

    snapToAnchor(s, worldPt, screenPt, vp) {
      s[0] = worldPt[0] - (screenPt[0] - vp.w / 2) / s[2];
      s[1] = worldPt[1] + (screenPt[1] - vp.h / 2) / s[2];
    },

    pack(s, region, vp) {
      region.flatSx = (2 * s[2]) / vp.w;
      region.flatSy = (2 * s[2]) / vp.h;
      region.flatTx = (-2 * s[2] * s[0]) / vp.w;
      region.flatTy = (-2 * s[2] * s[1]) / vp.h;
      // Zero `fov_scale` so shaders skip the globe horizon cull after
      // switching from globe back to flat.
      region.fovScale = 0;
    },
  };
}
