/** What a shade's tick sees each frame. */
export interface ShadeFrame {
  /** The frame's timestamp, in milliseconds. */
  readonly timeMs: number;
  /** Latest pointer in canvas-local CSS px, from the canvas or `setPointer`, or null. */
  readonly pointerPx: readonly [number, number] | null;
  /** The frame's viewport in CSS px. */
  readonly viewport: { readonly w: number; readonly h: number };
}

/**
 * A host fragment hook for the block, port, wire, and group passes.
 *
 * @remarks
 * `wgsl` declares `fn shade(f: Fragment) -> vec4f` and may read `u.host` and `u.pointer_px`, the
 * pointer in canvas-local CSS px; the prelude in `webgpu/shaders/shade.wgsl` documents `Fragment`.
 * `tick` writes the 64-float `host` block before a frame and returns true to keep frames coming,
 * so an effect costs the same on any diagram: one small uniform upload per frame and nothing per
 * part.
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
