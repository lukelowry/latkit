import type { ProjectionMode } from '../projections.js';
import type { Uniforms } from '../webgpu/uniforms.js';
import {
  W_CAMERA_X,
  W_CAMERA_Y,
  W_CAMERA_Z,
  W_FLAT_SX,
  W_FLAT_SY,
  W_FLAT_TX,
  W_FLAT_TY,
  W_FOV_SCALE,
  W_HEIGHT_WORLD_SCALE,
  W_VERTEX_SIZE,
  W_VIEWPORT_X,
  W_VIEWPORT_Y,
} from '../webgpu/uniforms.js';
import { VISUAL } from '../visual.js';

/**
 * Positive-w clip floor for segment endpoints.
 *
 * This matches the old compute picker's PICK_MIN_CLIP_W constant; segments
 * straddling the camera plane clip against this floor before screen tests.
 */
export const MIN_CLIP_W = 1e-4;

/** Degrees-to-radians multiplier used by longitude/latitude globe projection. */
const DEG2RAD = Math.PI / 180;

/**
 * One projected candidate point: displaced world position, clip position,
 * and device-px screen position. Reused as scratch; `toScreen` is a
 * separate step so callers keep the WGSL order (project, visibility/clip,
 * then screen conversion).
 */
export interface ProjectedPoint {
  /** World x after projection-specific displacement. */
  wx: number;
  /** World y after projection-specific displacement. */
  wy: number;
  /** World z after projection-specific displacement. */
  wz: number;
  /** Clip-space x before perspective divide. */
  cx: number;
  /** Clip-space y before perspective divide. */
  cy: number;
  /** Clip-space z before perspective divide. */
  cz: number;
  /** Clip-space w used for visibility and perspective divide. */
  cw: number;
  /** Device-pixel x within the current GPU viewport. */
  sx: number;
  /** Device-pixel y within the current GPU viewport. */
  sy: number;
}

/** Create a zeroed projected-point scratch object for allocation-free tests. */
export function createPoint(): ProjectedPoint {
  return { wx: 0, wy: 0, wz: 0, cx: 0, cy: 0, cz: 0, cw: 0, sx: 0, sy: 0 };
}

/**
 * Lerp world and clip coordinates between projected points.
 *
 * Screen coordinates are left stale; callers must rerun `toScreen` when they
 * need device-pixel coordinates for the mixed point.
 */
export function mixPoint(
  out: ProjectedPoint,
  a: ProjectedPoint,
  b: ProjectedPoint,
  t: number,
): void {
  out.wx = a.wx + (b.wx - a.wx) * t;
  out.wy = a.wy + (b.wy - a.wy) * t;
  out.wz = a.wz + (b.wz - a.wz) * t;
  out.cx = a.cx + (b.cx - a.cx) * t;
  out.cy = a.cy + (b.cy - a.cy) * t;
  out.cz = a.cz + (b.cz - a.cz) * t;
  out.cw = a.cw + (b.cw - a.cw) * t;
}

/**
 * CPU mirror of one projection's WGSL symbol contract: `to_world`,
 * `displace_world`, `project_world`, `pick_visible`, `screen_radius`,
 * `screen_half_width`, `screen_pole_half_width`. It reads the same packed
 * uniform words the shaders read, so the picked pose can never drift from
 * the rendered one. `h` is the normalized height (`vertex_norm_height`
 * output); the projector owns the world-scale conversion like the WGSL does.
 */
export interface Projector {
  /** Fill world + clip for topology coord (x, y) at normalized height h. */
  project(out: ProjectedPoint, x: number, y: number, h: number): void;
  /** Device-px screen position from clip; requires cw above the clip floor. */
  toScreen(p: ProjectedPoint): void;
  /** Mirror of pick_visible: horizon / behind-camera rejection. */
  visible(p: ProjectedPoint): boolean;
  /** Vertex px radius before per-vertex size scaling and the LOD floor. */
  screenRadius(p: ProjectedPoint): number;
  /** Edge half-width in device px after projection scaling and clamping. */
  screenHalfWidth(p: ProjectedPoint, baseWidth: number): number;
  /** Pole hit half-width in device px at the projected anchor. */
  poleHalfWidth(p: ProjectedPoint): number;
}

/** Create the projection-specific CPU mirror for the active render mode. */
export function projectorFor(mode: ProjectionMode, uniforms: Uniforms): Projector {
  const f = new Float32Array(uniforms.raw);
  switch (mode) {
    case 'flat':
      return flatProjector(f);
    case 'tilt':
      return tiltProjector(f);
    case 'globe':
      return globeProjector(f);
    default:
      /* v8 ignore next -- compile-time exhaustive projection mode guard. */
      return mode satisfies never;
  }
}

/** Convert clip coordinates to device-pixel screen coordinates. */
function toScreen(f: Float32Array, p: ProjectedPoint): void {
  const invW = 1 / p.cw;
  p.sx = (p.cx * invW * 0.5 + 0.5) * f[W_VIEWPORT_X]!;
  p.sy = (0.5 - p.cy * invW * 0.5) * f[W_VIEWPORT_Y]!;
}

/** Apply `clip = u.vp * vec4(world, 1)` using the column-major matrix at words 0-15. */
function projectVP(f: Float32Array, p: ProjectedPoint): void {
  const { wx, wy, wz } = p;
  p.cx = f[0]! * wx + f[4]! * wy + f[8]! * wz + f[12]!;
  p.cy = f[1]! * wx + f[5]! * wy + f[9]! * wz + f[13]!;
  p.cz = f[2]! * wx + f[6]! * wy + f[10]! * wz + f[14]!;
  p.cw = f[3]! * wx + f[7]! * wy + f[11]! * wz + f[15]!;
}

/**
 * Convert a world-space size to device px for perspective projections.
 *
 * Shared by tilt and globe: `worldSize / (w * fovScale)` converted through
 * half the viewport height.
 */
function perspectivePx(f: Float32Array, w: number, worldSize: number): number {
  return (worldSize / (w * f[W_FOV_SCALE]!)) * f[W_VIEWPORT_Y]! * 0.5;
}

/** Clamp an edge half-width to the visual shader's supported px range. */
function clampHalfWidth(px: number): number {
  return Math.min(Math.max(px, VISUAL.minEdgeHalfWidthPx), VISUAL.maxEdgeHalfWidthPx);
}

/** Derive pole capsule half-width from the vertex radius with a readable floor. */
function polePx(radius: number): number {
  return Math.max(radius * 0.15, 1.5);
}

/** Project topology xy as flat orthographic world coordinates. */
function flatProjector(f: Float32Array): Projector {
  return {
    // Orthographic top-down: height never displaces flat geometry.
    project(out, x, y, _h) {
      out.wx = x;
      out.wy = y;
      out.wz = 0;
      out.cx = x * f[W_FLAT_SX]! + f[W_FLAT_TX]!;
      out.cy = y * f[W_FLAT_SY]! + f[W_FLAT_TY]!;
      out.cz = 0.5;
      out.cw = 1;
    },
    toScreen(p) {
      toScreen(f, p);
    },
    visible(p) {
      return p.cw > 0;
    },
    screenRadius() {
      const px = f[W_VERTEX_SIZE]! * Math.abs(f[W_FLAT_SX]!) * f[W_VIEWPORT_X]! * 0.5;
      return Math.min(px, VISUAL.maxVertexRadiusPx);
    },
    screenHalfWidth(_p, baseWidth) {
      return clampHalfWidth(baseWidth * Math.abs(f[W_FLAT_SX]!) * f[W_VIEWPORT_X]! * 0.5);
    },
    poleHalfWidth(p) {
      return polePx(this.screenRadius(p));
    },
  };
}

/** Project topology xy onto the tilted plane with height as world z lift. */
function tiltProjector(f: Float32Array): Projector {
  return {
    project(out, x, y, h) {
      out.wx = x;
      out.wy = y;
      out.wz = VISUAL.tiltSurfaceLift * f[W_VERTEX_SIZE]! + h * f[W_HEIGHT_WORLD_SCALE]!;
      projectVP(f, out);
    },
    toScreen(p) {
      toScreen(f, p);
    },
    visible(p) {
      return p.cw > 0 && p.wz >= -0.0005;
    },
    screenRadius(p) {
      return Math.min(perspectivePx(f, p.cw, f[W_VERTEX_SIZE]!), VISUAL.maxVertexRadiusPx);
    },
    screenHalfWidth(p, baseWidth) {
      return clampHalfWidth(perspectivePx(f, p.cw, baseWidth));
    },
    poleHalfWidth(p) {
      return polePx(this.screenRadius(p));
    },
  };
}

/** Project topology lon-lat degrees onto the unit globe with radial height. */
function globeProjector(f: Float32Array): Projector {
  return {
    project(out, x, y, h) {
      const la = y * DEG2RAD;
      const lo = x * DEG2RAD;
      const c = Math.cos(la);
      const lift = 1 + VISUAL.globeSurfaceOffset + h * f[W_HEIGHT_WORLD_SCALE]!;
      out.wx = c * Math.cos(lo) * lift;
      out.wy = Math.sin(la) * lift;
      out.wz = -c * Math.sin(lo) * lift;
      projectVP(f, out);
    },
    toScreen(p) {
      toScreen(f, p);
    },
    visible(p) {
      if (p.cw <= 0) return false;
      // Ray from the eye to the point vs the unit sphere: an intersection
      // meaningfully before the point means it sits behind the horizon.
      const ex = f[W_CAMERA_X]!;
      const ey = f[W_CAMERA_Y]!;
      const ez = f[W_CAMERA_Z]!;
      const rx = p.wx - ex;
      const ry = p.wy - ey;
      const rz = p.wz - ez;
      const a = rx * rx + ry * ry + rz * rz;
      const b = 2 * (ex * rx + ey * ry + ez * rz);
      const c = ex * ex + ey * ey + ez * ez - 1;
      const disc = b * b - 4 * a * c;
      if (disc <= 0) return true;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      return t >= 0.999;
    },
    screenRadius(p) {
      const px = perspectivePx(f, p.cw, f[W_VERTEX_SIZE]! * VISUAL.globeVertexScale);
      return Math.min(px, VISUAL.maxVertexRadiusPx);
    },
    screenHalfWidth(p, baseWidth) {
      return clampHalfWidth(perspectivePx(f, p.cw, baseWidth * VISUAL.globeEdgeScale));
    },
    poleHalfWidth(p) {
      return polePx(this.screenRadius(p));
    },
  };
}
