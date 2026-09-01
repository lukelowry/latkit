import { mat4Invert, mat4Unproject } from './mat4.js';
import type { Viewport } from './projection.js';

/**
 * Cached inverse view-projection unprojector shared by the CPU cameras.
 *
 * Mirrors shaders/common/camera-ray.wgsl: one place turns a screen pixel into
 * an eye ray, and the projections differ only in the surface intersection they
 * run on the result (ground plane vs. unit sphere).
 */
export interface ScreenRay {
  /** Ray origin: the near-plane unprojection. Valid after a true `cast`. */
  readonly origin: Float64Array;
  /** Ray direction toward the far plane, not normalized. */
  readonly dir: Float64Array;
  /** Drop the cached inverse. Call whenever the VP matrix is rebuilt. */
  invalidate(): void;
  /** Unproject a screen pixel through `vpMatrix`. False on a singular matrix. */
  cast(vpMatrix: Float32Array, sx: number, sy: number, vp: Viewport): boolean;
}

/** Create a zero-alloc screen-ray caster with its own inverse-matrix cache. */
export function createScreenRay(): ScreenRay {
  const inv = new Float32Array(16);
  const origin = new Float64Array(3);
  const far = new Float64Array(3);
  const dir = new Float64Array(3);
  let valid = false;
  return {
    origin,
    dir,
    invalidate() {
      valid = false;
    },
    cast(vpMatrix, sx, sy, vp) {
      if (!valid) {
        if (!mat4Invert(inv, vpMatrix)) return false;
        valid = true;
      }
      const nx = (sx / vp.w) * 2 - 1;
      const ny = 1 - (sy / vp.h) * 2;
      mat4Unproject(origin, nx, ny, 0, inv);
      mat4Unproject(far, nx, ny, 1, inv);
      dir[0] = far[0] - origin[0];
      dir[1] = far[1] - origin[1];
      dir[2] = far[2] - origin[2];
      return true;
    },
  };
}
