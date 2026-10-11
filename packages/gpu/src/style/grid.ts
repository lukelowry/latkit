import type { ProjectedCamera } from '../view/projection.js';

/**
 * Where a grid's lines fall this frame, as `grid_lines` reads them: the nicest step at least
 * `minSpacingPx` apart at the camera's center, then how many steps past a line the center lies, in
 * x and y. Steps are 1, 2, or 5 times a power of ten; in `degrees`, past 10 they are 15 and 30.
 */
export function gridLines(
  camera: ProjectedCamera,
  minSpacingPx: number,
  degrees: boolean,
): readonly [step: number, x: number, y: number, unused: number] {
  const step = gridStep(minSpacingPx / camera.scale, degrees),
    past = (value: number) => {
      const steps = value / step;
      return steps - Math.floor(steps);
    };
  return [step, past(camera.center[0]), past(camera.center[1]), 0];
}
function gridStep(least: number, degrees: boolean): number {
  if (degrees && least > 10) return least <= 15 ? 15 : 30;
  const decade = 10 ** Math.floor(Math.log10(least)),
    times = least / decade;
  return decade * (times <= 1 ? 1 : times <= 2 ? 2 : times <= 5 ? 5 : 10);
}

/** WGSL for a grid over the ground: how much of a pixel its lines cover. */
export function gridShader(): string {
  return `
/**
 * How much of a pixel a grid's lines cover at a point \`relative\` to the camera's center, \`grid\` as
 * \`gridLines\` writes it. Lines closer than a few pixels, as toward a tilted plane's horizon, fade
 * rather than fill.
 */
fn grid_lines(relative: vec2f, grid: vec4f) -> f32 {
  let at = relative / grid.x + grid.yz;
  let width = max(fwidth(at), vec2f(0.000001));
  let near = abs(fract(at - 0.5) - 0.5) / width;
  let fade = 1.0 - smoothstep(0.2, 0.5, max(width.x, width.y));
  return (1.0 - min(min(near.x, near.y), 1.0)) * fade;
}
`;
}
