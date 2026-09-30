import type { Viewport } from '@latkit/gpu';

export interface ShadeFrame {
  readonly timeMs: number;
  readonly pointerPx: readonly [number, number] | null;
  readonly viewport: Viewport;
}
export interface Shade {
  /** Defines the WGSL shade function. The host uniform contains sixteen four-component vectors. */
  readonly wgsl: string;
  tick?(host: Float32Array, frame: ShadeFrame): boolean;
}
export const DEFAULT_SHADE = 'fn shade(f: Fragment) -> vec4f { return f.color; }';
export function spotlight(
  options: { radiusPx?: number; strength?: number; color?: readonly [number, number, number] } = {},
): Shade {
  const { radiusPx = 200, strength = 0.65, color = [1, 0.75, 0.35] } = options;
  if (
    !Number.isFinite(radiusPx) ||
    radiusPx <= 0 ||
    !Number.isFinite(strength) ||
    strength < 0 ||
    strength > 1 ||
    color.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
  )
    throw new RangeError('Invalid spotlight');
  return {
    wgsl: 'fn shade(f: Fragment) -> vec4f { let a = (1.0 - smoothstep(0.0, host[0].x, distance(f.px, u.pointer.xy))) * host[0].y; return vec4f(mix(f.color.rgb, host[1].rgb, a), f.color.a); }',
    tick(host) {
      host.set([radiusPx, strength, 0, 0, ...color, 1]);
      return false;
    },
  };
}
