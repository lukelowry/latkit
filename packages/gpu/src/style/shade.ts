import { failure } from '@latkit/model';
import { integer } from '../error.js';
import { validateRgba, type RGBA } from '../colors/color.js';
import type { FrameInfo, Viewport } from '../frame/render.js';
export interface Shade {
  /** Defines the WGSL shade function from ShadeFragment to vec4f. Inputs/outputs are straight sRGB RGBA. */
  readonly wgsl: string;
  /** Sixteen vec4 parameters. Return true to request another animation frame. */
  tick?(parameters: Float32Array, frame: Shade.Frame): boolean;
}
export declare namespace Shade {
  interface Frame {
    readonly timeMs: number;
    readonly pointerPx: readonly [number, number] | null;
    readonly viewport: Viewport;
  }
  interface Request {
    /** Optional fixed effect time for progressive composition. */
    readonly timeMs?: number;
    readonly parameters?: Float32Array;
    readonly pointerPx?: readonly [number, number] | null;
  }
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
export function shadeUniforms(request: Shade.Request, frame: FrameInfo): Float32Array {
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
 * from 0 to 1, times the color's alpha: alarms that draw the eye while the rest holds still.
 */
export function pulse(options: { readonly periodMs?: number; readonly color?: RGBA } = {}): Shade {
  const { periodMs = 1200, color = [1, 1, 1, 0.6] } = options;
  if (!Number.isFinite(periodMs) || periodMs <= 0) throw failure('invalid-input', 'Invalid pulse');
  validateRgba(color, 'pulse color');
  return {
    wgsl: `fn shade(f: ShadeFragment) -> vec4f {
      let p = shadeContext.parameters[0];
      let c = shadeContext.parameters[1];
      let wave = 0.5 - 0.5 * cos(shadeContext.pointer.w / p.x * 6.283185307);
      return vec4f(mix(f.color.rgb, c.rgb, wave * c.a * clamp(f.value, 0.0, 1.0)), f.color.a);
    }`,
    tick(parameters) {
      parameters.set([periodMs, 0, 0, 0, ...color]);
      // A pulse moves every frame.
      return true;
    },
  };
}
/** Fragments within `radiusPx` of the pointer tint toward `color`, nearest most, as far as its alpha. */
export function spotlight(
  options: { readonly radiusPx?: number; readonly color?: RGBA } = {},
): Shade {
  const { radiusPx = 200, color = [1, 0.75, 0.35, 0.65] } = options;
  if (!Number.isFinite(radiusPx) || radiusPx <= 0)
    throw failure('invalid-input', 'Invalid spotlight');
  validateRgba(color, 'spotlight color');
  return {
    wgsl: `fn shade(f: ShadeFragment) -> vec4f {
      let p = shadeContext.parameters[0];
      let c = shadeContext.parameters[1];
      let a = (1.0 - smoothstep(0.0, p.x, distance(f.px, shadeContext.pointer.xy))) * c.a * shadeContext.pointer.z;
      return vec4f(mix(f.color.rgb, c.rgb, a), f.color.a);
    }`,
    tick(parameters) {
      parameters.set([radiusPx, 0, 0, 0, ...color]);
      return false;
    },
  };
}
