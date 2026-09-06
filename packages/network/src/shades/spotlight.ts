import { validateRgba, type RGBA } from '@latkit/model';

import { POINTER_NONE, type Shade } from '../shade.js';

/** How the spotlight looks and moves. */
export interface SpotlightOptions {
  /** Radius in CSS pixels. @defaultValue `200` */
  readonly radiusPx?: number;
  /** How far item colors mix toward `color` at the center, 0 to 1. @defaultValue `0.6` */
  readonly strength?: number;
  /** Accent color; alpha is ignored. @defaultValue a warm white */
  readonly color?: RGBA;
  /** Chase time constant in milliseconds; `0` snaps to the pointer. @defaultValue `90` */
  readonly followMs?: number;
}

/** Below this the light has landed: a fraction of the way, and a fraction of a CSS pixel. */
const SETTLE_AMOUNT = 1e-3;
const SETTLE_PX = 0.05;

/** The spotlight's WGSL: `host[0]` is xy, radius squared, and amount; `host[1]` the color. */
const WGSL = `
fn shade(f: Fragment) -> vec4f {
  let d = f.px - host[0].xy;
  let q = max(0.0, 1.0 - dot(d, d) / host[0].z);
  return vec4f(mix(f.color.rgb, host[1].rgb, q * q * host[0].w), f.color.a);
}
`;

/**
 * A soft light that follows the pointer and fades once it leaves.
 *
 * The light chases the pointer exponentially and its strength eases in and out, so it costs
 * nothing per item: one 64-float upload per frame while it moves, none once it has landed.
 *
 * @throws TypeError or RangeError when an option is invalid.
 */
export function spotlight(options: SpotlightOptions = {}): Shade {
  const radiusPx = options.radiusPx ?? 200;
  const strength = options.strength ?? 0.6;
  const color = options.color ?? [1, 0.85, 0.6, 1];
  const followMs = options.followMs ?? 90;
  nonnegative('radiusPx', radiusPx);
  nonnegative('strength', strength);
  nonnegative('followMs', followMs);
  validateRgba(color, 'spotlight color');

  let x = POINTER_NONE;
  let y = POINTER_NONE;
  let amount = 0;
  let lastMs = Number.NaN;

  return {
    wgsl: WGSL,
    tick(host, { timeMs, pointerPx }) {
      const dt = Number.isFinite(lastMs) ? Math.max(0, timeMs - lastMs) : 0;
      lastMs = timeMs;
      const k = followMs > 0 ? 1 - Math.exp(-dt / followMs) : 1;
      const target = pointerPx ? 1 : 0;
      if (pointerPx) {
        if (x === POINTER_NONE) {
          x = pointerPx[0];
          y = pointerPx[1];
        }
        x += (pointerPx[0] - x) * k;
        y += (pointerPx[1] - y) * k;
      }
      amount += (target - amount) * k;
      const settled =
        Math.abs(target - amount) < SETTLE_AMOUNT &&
        (!pointerPx ||
          (Math.abs(pointerPx[0] - x) < SETTLE_PX && Math.abs(pointerPx[1] - y) < SETTLE_PX));
      if (settled) {
        amount = target;
        if (pointerPx) {
          x = pointerPx[0];
          y = pointerPx[1];
        } else {
          x = POINTER_NONE;
          y = POINTER_NONE;
        }
      }
      host[0] = x;
      host[1] = y;
      host[2] = radiusPx * radiusPx;
      host[3] = strength * amount;
      host[4] = color[0];
      host[5] = color[1];
      host[6] = color[2];
      host[7] = 1;
      return !settled;
    },
  };
}

function nonnegative(name: string, value: number): void {
  if (typeof value !== 'number') throw new TypeError(`spotlight ${name} must be a number`);
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`spotlight ${name} must be finite and nonnegative`);
  }
}
