import { failure } from '@latkit/model';
import { integer } from '../error.js';
import type { FrameInfo, Viewport } from '../frame/render.js';
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
  /** Optional fixed effect time for progressive composition. */
  readonly timeMs?: number;
  readonly parameters?: Float32Array;
  readonly pointerPx?: readonly [number, number] | null;
}
/** The shade that keeps every fragment's color. */
export const defaultShade: Shade = Object.freeze({
  wgsl: 'fn shade(f: ShadeFragment) -> vec4f { return f.color; }',
});
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
    throw failure('invalid-input', 'Shade parameters require sixteen vec4 values');
  const values = new Float32Array(72);
  values.set(
    [...(request.pointerPx ?? [0, 0]), request.pointerPx ? 1 : 0, request.timeMs ?? frame.timeMs],
    0,
  );
  values.set([frame.viewport.width, frame.viewport.height, frame.viewport.pixelRatio, 0], 4);
  if (request.parameters) values.set(request.parameters, 8);
  return values;
}
/**
 * Rows whose `shade` is positive pulse toward `color` once every `periodMs`, as far as their value,
 * from 0 to 1, times `strength`: alarms that draw the eye while the rest holds still.
 */
export function pulse(
  options: {
    readonly periodMs?: number;
    readonly strength?: number;
    readonly color?: readonly [number, number, number];
  } = {},
): Shade {
  const { periodMs = 1200, strength = 0.6, color = [1, 1, 1] } = options;
  if (
    !Number.isFinite(periodMs) ||
    periodMs <= 0 ||
    !Number.isFinite(strength) ||
    strength < 0 ||
    strength > 1 ||
    color.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
  )
    throw failure('invalid-input', 'Invalid pulse');
  return {
    wgsl: `fn shade(f: ShadeFragment) -> vec4f {
      let p = shadeContext.parameters[0];
      let wave = 0.5 - 0.5 * cos(shadeContext.pointer.w / p.x * 6.283185307);
      let k = wave * p.y * clamp(f.value, 0.0, 1.0);
      return vec4f(mix(f.color.rgb, shadeContext.parameters[1].rgb, k), f.color.a);
    }`,
    tick(parameters) {
      parameters.set([periodMs, strength, 0, 0, ...color, 1]);
      // A pulse moves every frame.
      return true;
    },
  };
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
    throw failure('invalid-input', 'Invalid spotlight');
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
