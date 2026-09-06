import type { Viewport } from './camera/projection.js';

/** What a shade's tick sees each frame. */
export interface ShadeFrame {
  /** The frame's timestamp, in milliseconds. */
  readonly timeMs: number;
  /** Latest pointer in canvas-local CSS px, from the canvas or `setPointer`, or null. */
  readonly pointerPx: readonly [number, number] | null;
  /** The frame's viewport in CSS px. */
  readonly viewport: Viewport;
}

/**
 * A host fragment hook for the vertex and edge passes.
 *
 * @remarks
 * `wgsl` declares `fn shade(f: Fragment) -> vec4f` and may read `host` and `u.pointer_px`; the
 * prelude in `shaders/common/shade.wgsl` documents `Fragment`. `tick` writes the 64-float `host`
 * block before a frame and returns true to keep frames coming, so an effect costs the same on any
 * graph: one small uniform upload per frame and nothing per item.
 */
export interface Shade {
  readonly wgsl: string;
  tick?(host: Float32Array, frame: ShadeFrame): boolean;
}

/** Floats in the host block: `array<vec4f, 16>`. */
export const SHADE_HOST_WORDS = 64;

/** Where `u.pointer_px` sits when no pointer is present: far enough that any falloff is zero. */
export const POINTER_NONE = -1e6;

/** The identity shade every renderer starts with. */
export const DEFAULT_SHADE_WGSL = 'fn shade(f: Fragment) -> vec4f { return f.color; }\n';
