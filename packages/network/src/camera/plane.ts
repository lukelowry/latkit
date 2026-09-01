import type {
  CameraPose,
  CameraState,
  PanSession,
  PlaneView,
  Projection,
  Vec2,
  Viewport,
} from './projection.js';
import { BEARING_RATE, FIT_PAD, MAX_ZOOM_RATIO, PITCH_RATE } from './projection.js';
import { DEG2RAD, turn, wrap } from './geo.js';
import { mat4Invert, mat4Mul, mat4Perspective, mat4Unproject } from './mat4.js';

const FOV_Y = 2 * Math.atan(1 / 3);
const FOV_SCALE = 1 / 3;
const MAX_PITCH = 85;
export const TILT_PITCH = 55;
const NEAR_HEIGHT = 0.1;
const FAR_DIST = 50;
const SCALE_MIN = 0.001;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const mix = (v: number): number => {
  const t = clamp(v / TILT_PITCH, 0, 1);
  return t * t * (3 - 2 * t);
};

const nearHit = new Float64Array(3);
const farHit = new Float64Array(3);

/** One planar camera: flat is pitch zero, tilt is its oblique target. */
export function createPlaneProjection(initial: PlaneView): Projection {
  let view = initial;
  const vpM = new Float32Array(16);
  const invM = new Float32Array(16);
  const eye = new Float32Array(3);
  const projM = new Float32Array(16);
  const viewM = new Float32Array(16);
  const stamp = new Float64Array(7);
  const hit = new Float64Array(3);
  let valid = false;
  let invValid = false;

  const dirty = (s: CameraState, vp: Viewport): boolean =>
    s[0] !== stamp[0] ||
    s[1] !== stamp[1] ||
    s[2] !== stamp[2] ||
    s[3] !== stamp[3] ||
    s[4] !== stamp[4] ||
    vp.w !== stamp[5] ||
    vp.h !== stamp[6];

  function build(s: CameraState, vp: Viewport): void {
    if (valid && !dirty(s, vp)) return;
    const p = s[3] * DEG2RAD;
    const b = s[4] * DEG2RAD;
    const sp = Math.sin(p);
    const cp = Math.cos(p);
    const sb = Math.sin(b);
    const cb = Math.cos(b);
    const dist = vp.h / (2 * s[2] * FOV_SCALE);
    const bx = sb * sp;
    const by = -cb * sp;
    const bz = cp;
    eye[0] = s[0] + bx * dist;
    eye[1] = s[1] + by * dist;
    eye[2] = bz * dist;

    const ux = -bz * sb;
    const uy = bz * cb;
    const uz = bx * sb - by * cb;
    viewM.set([
      cb,
      ux,
      bx,
      0,
      sb,
      uy,
      by,
      0,
      0,
      uz,
      bz,
      0,
      -(cb * eye[0] + sb * eye[1]),
      -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
      -(bx * eye[0] + by * eye[1] + bz * eye[2]),
      1,
    ]);
    const near = Math.max(eye[2] * NEAR_HEIGHT, dist * 1e-5);
    mat4Perspective(projM, FOV_Y, vp.w / vp.h, near, dist * FAR_DIST);
    mat4Mul(vpM, projM, viewM);
    stamp.set([s[0], s[1], s[2], s[3], s[4], vp.w, vp.h]);
    valid = true;
    invValid = false;
  }

  function ray(s: CameraState, sx: number, sy: number, vp: Viewport): boolean {
    build(s, vp);
    if (!invValid) {
      if (!mat4Invert(invM, vpM)) return false;
      invValid = true;
    }
    const nx = (sx / vp.w) * 2 - 1;
    const ny = 1 - (sy / vp.h) * 2;
    mat4Unproject(nearHit, nx, ny, 0, invM);
    mat4Unproject(farHit, nx, ny, 1, invM);
    const dz = farHit[2] - nearHit[2];
    if (!(dz < -1e-12)) return false;
    const t = -nearHit[2] / dz;
    if (t < 0 || !Number.isFinite(t)) return false;
    hit[0] = nearHit[0] + (farHit[0] - nearHit[0]) * t;
    hit[1] = nearHit[1] + (farHit[1] - nearHit[1]) * t;
    return true;
  }

  return {
    family: 'plane',
    stateSize: 5,

    setView(next, target) {
      view = next;
      target[3] = next === 'flat' ? 0 : TILT_PITCH;
      if (next === 'flat') target[4] = 0;
      valid = false;
    },

    fit(bounds, vp): CameraState {
      const bw = bounds.xMax - bounds.xMin || 1;
      const bh = bounds.yMax - bounds.yMin || 1;
      return Float64Array.of(
        (bounds.xMin + bounds.xMax) / 2,
        (bounds.yMin + bounds.yMax) / 2,
        Math.min((vp.w * FIT_PAD) / bw, (vp.h * FIT_PAD) / bh),
        view === 'flat' ? 0 : TILT_PITCH,
        0,
      ) as CameraState;
    },

    clone(s): CameraState {
      return new Float64Array(s) as CameraState;
    },

    screenToWorld(s, sx, sy, vp): Vec2 | null {
      if (s[3] === 0) {
        return [(sx - vp.w / 2) / s[2] + s[0], -(sy - vp.h / 2) / s[2] + s[1]];
      }
      return ray(s, sx, sy, vp) ? [hit[0], hit[1]] : null;
    },

    mix(out, a, b, t) {
      out[0] = a[0] + (b[0] - a[0]) * t;
      out[1] = a[1] + (b[1] - a[1]) * t;
      out[2] = a[2] + (b[2] - a[2]) * t;
      out[3] = a[3] + (b[3] - a[3]) * t;
      out[4] = a[4] + turn(a[4], b[4]) * t;
      valid = false;
    },

    delta(out, a, b, dt) {
      out[0] = (b[0] - a[0]) / dt;
      out[1] = (b[1] - a[1]) / dt;
      out[2] = (b[2] - a[2]) / dt;
      out[3] = (b[3] - a[3]) / dt;
      out[4] = turn(a[4], b[4]) / dt;
    },

    advance(out, s, tangent, amount) {
      out[0] = s[0] + tangent[0] * amount;
      out[1] = s[1] + tangent[1] * amount;
      out[2] = s[2] + tangent[2] * amount;
      out[3] = clamp(s[3] + tangent[3] * amount, 0, MAX_PITCH);
      out[4] = wrap(s[4] + tangent[4] * amount);
      valid = false;
    },

    tangentNorm(tangent) {
      return Math.hypot(tangent[0], tangent[1]);
    },

    near(a, b, vp, eps) {
      const scale = Math.max(Math.abs(a[2]), Math.abs(b[2]), 1e-12);
      if (Math.abs(a[0] - b[0]) * scale > eps) return false;
      if (Math.abs(a[1] - b[1]) * scale > eps) return false;
      const extent = Math.max(vp.w, vp.h) * 0.5;
      if ((Math.abs(a[2] - b[2]) / scale) * extent > eps) return false;
      if (Math.abs(a[3] - b[3]) * DEG2RAD * extent > eps) return false;
      return Math.abs(turn(a[4], b[4])) * DEG2RAD * extent <= eps;
    },

    isAtFit(current, fit) {
      return (
        Math.abs(current[2] / fit[2] - 1) < 0.01 &&
        Math.abs(current[0] - fit[0]) * fit[2] < 1 &&
        Math.abs(current[1] - fit[1]) * fit[2] < 1 &&
        Math.abs(current[3] - fit[3]) < 0.1 &&
        Math.abs(turn(current[4], fit[4])) < 0.1
      );
    },

    beginPan(state, sx, sy, vp): PanSession {
      if (state[3] === 0) {
        return {
          apply(s, dx, dy) {
            s[0] -= dx / s[2];
            s[1] += dy / s[2];
            valid = false;
          },
        };
      }
      const grabbed = ray(state, sx, sy, vp);
      const gx = hit[0];
      const gy = hit[1];
      return {
        apply(s, dx, dy, x, y, nextVp) {
          if (grabbed && ray(s, x, y, nextVp)) {
            s[0] += gx - hit[0];
            s[1] += gy - hit[1];
          } else {
            const wpp = 1 / s[2];
            const b = s[4] * DEG2RAD;
            const cb = Math.cos(b);
            const sb = Math.sin(b);
            s[0] += (-dx * cb - dy * sb) * wpp;
            s[1] += (-dx * sb + dy * cb) * wpp;
          }
          valid = false;
        },
      };
    },

    zoom(s, factor, fit) {
      if (!Number.isFinite(factor) || factor <= 0) return;
      const min = fit ? fit[2] : SCALE_MIN;
      const max = fit ? fit[2] * MAX_ZOOM_RATIO : 1e6;
      s[2] = clamp(s[2] * factor, min, max);
      valid = false;
    },

    snapToAnchor(s, world, screen, vp) {
      if (s[3] === 0) {
        s[0] = world[0] - (screen[0] - vp.w / 2) / s[2];
        s[1] = world[1] + (screen[1] - vp.h / 2) / s[2];
      } else if (ray(s, screen[0], screen[1], vp)) {
        s[0] += world[0] - hit[0];
        s[1] += world[1] - hit[1];
      }
      valid = false;
    },

    rotate(s, dx, dy) {
      if (view === 'flat') return;
      s[4] = wrap(s[4] + dx * BEARING_RATE);
      s[3] = clamp(s[3] - dy * PITCH_RATE, 0, MAX_PITCH);
      valid = false;
    },

    pose(s): CameraPose {
      return { centerX: s[0]!, centerY: s[1]!, pitch: s[3]!, bearing: s[4]! };
    },

    applyPose(s, pose) {
      if (pose.centerX !== undefined) s[0] = pose.centerX;
      if (pose.centerY !== undefined) s[1] = pose.centerY;
      if (pose.pitch !== undefined) s[3] = view === 'flat' ? 0 : clamp(pose.pitch, 0, MAX_PITCH);
      if (pose.bearing !== undefined) s[4] = view === 'flat' ? 0 : wrap(pose.bearing);
      valid = false;
    },

    exportPose(s) {
      return { centerX: s[0], centerY: s[1], pxPerWorld: Math.abs(s[2]) };
    },

    importPose(pose) {
      return Float64Array.of(pose.centerX, pose.centerY, pose.pxPerWorld, 0, 0) as CameraState;
    },

    settleImportedPose(target) {
      target[3] = view === 'flat' ? 0 : TILT_PITCH;
    },

    pack(s, region, vp) {
      const amount = mix(s[3]);
      region.flatSx = (2 * s[2]) / vp.w;
      region.flatSy = (2 * s[2]) / vp.h;
      region.flatTx = (-2 * s[2] * s[0]) / vp.w;
      region.flatTy = (-2 * s[2] * s[1]) / vp.h;
      region.fovScale = FOV_SCALE;
      region.planeMix = amount;
      if (amount === 0) return;
      build(s, vp);
      region.setVP(vpM);
      region.setCameraPos(eye[0], eye[1], eye[2]);
      region.setViewBasis(viewM);
    },
  };
}

export const createFlatProjection = (): Projection => createPlaneProjection('flat');
export const createTiltProjection = (): Projection => createPlaneProjection('tilt');
