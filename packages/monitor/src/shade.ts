/** What a shade's tick sees each frame. */
export interface ShadeFrame {
  /** The frame timestamp in milliseconds. */
  readonly timeMs: number;
  /** Latest pointer in canvas-local CSS pixels, or null. */
  readonly pointerPx: readonly [number, number] | null;
  /** The full canvas viewport in CSS pixels. */
  readonly viewport: { readonly w: number; readonly h: number };
}

/**
 * A fragment hook over the composed traces. Axes and the playhead remain outside the hook.
 *
 * @remarks
 * Declare `fn shade(f: Fragment) -> vec4f`. `f.color` is straight RGBA; `f.point` is the
 * normalized displayed plot (time right, value up), `f.pixel` is canvas-local CSS pixels,
 * and `f.time` is seconds wrapping hourly. Read `u.host` (16 vec4s) and `u.pointer_px`.
 * `tick` writes the 64-float host block and returns true to request another frame.
 * Shading does not read samples or rebuild history. Composed pixels have no element identity.
 */
export interface Shade {
  readonly wgsl: string;
  tick?(host: Float32Array, frame: ShadeFrame): boolean;
}

export const SHADE_HOST_WORDS = 64;
export const POINTER_NONE = -1e6;
export const DEFAULT_SHADE_WGSL = 'fn shade(f: Fragment) -> vec4f { return f.color; }\n';
