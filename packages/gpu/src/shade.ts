import { integer } from './error.js';
import type { FrameInfo, Viewport } from './render.js';
export interface ShadeFrame {
  readonly timeMs: number;
  readonly pointerPx: readonly [number, number] | null;
  readonly viewport: Viewport;
}
export interface Shade {
  /** Defines the WGSL shade function from ShadeFragment to vec4f. Inputs/outputs are straight sRGB RGBA. */
  readonly wgsl: string;
  /** Sixteen vec4 parameters. Return true to request another animation frame. */
  tick?(parameters: Float32Array, frame: ShadeFrame): boolean;
}
export interface ShadeRequest {
  readonly parameters?: Float32Array;
  readonly pointerPx?: readonly [number, number] | null;
}
export const defaultShade = 'fn shade(f: ShadeFragment) -> vec4f { return f.color; }';
/** Shared effect uniform layout. Custom geometry remains in renderer-specific shader functions. */
export function shadeShader(
  options: { readonly group?: number; readonly binding?: number } = {},
): string {
  return `struct ShadeFragment { color: vec4f, px: vec2f, value: f32 }
struct ShadeContext { pointer: vec4f, viewport: vec4f, parameters: array<vec4f,16> }
@group(${integer(options.group ?? 0, 'shade group', 0, 3)}) @binding(${integer(options.binding ?? 0, 'shade binding', 0, 999)}) var<uniform> shadeContext: ShadeContext;`;
}
export function shadeUniforms(request: ShadeRequest, frame: FrameInfo): Float32Array {
  if (request.parameters && request.parameters.length !== 64)
    throw new RangeError('Shade parameters require sixteen vec4 values');
  const values = new Float32Array(72);
  values.set([...(request.pointerPx ?? [0, 0]), request.pointerPx ? 1 : 0, frame.timeMs], 0);
  values.set([frame.viewport.width, frame.viewport.height, frame.viewport.pixelRatio, 0], 4);
  if (request.parameters) values.set(request.parameters, 8);
  return values;
}
export function spotlight(
  options: {
    readonly radiusPx?: number;
    readonly strength?: number;
    readonly color?: readonly [number, number, number];
  } = {},
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
    wgsl: `fn shade(f: ShadeFragment) -> vec4f {
      let p = shadeContext.parameters[0];
      let a = (1.0 - smoothstep(0.0, p.x, distance(f.px, shadeContext.pointer.xy))) * p.y * shadeContext.pointer.z;
      return vec4f(mix(f.color.rgb, shadeContext.parameters[1].rgb, a), f.color.a);
    }`,
    tick(parameters) {
      parameters.set([radiusPx, strength, 0, 0, ...color, 1]);
      return false;
    },
  };
}
