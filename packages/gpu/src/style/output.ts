/** All renderers use premultiplied attachment output. Color and shade APIs use straight RGBA. */
export const premultipliedBlend: GPUBlendState = Object.freeze({
  color: Object.freeze({ srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }),
  alpha: Object.freeze({ srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }),
});
/**
 * `outputColor`, a straight color under coverage, premultiplied; and `glowAlpha`, the glow hovered
 * and selected items cast `outside` pixels past their outline: whole at it, gone `reach` pixels out,
 * and nothing a pixel inside, which the item covers.
 */
export function outputShader(): string {
  return `fn outputColor(color: vec4f, coverage: f32) -> vec4f {
    let alpha = color.a * clamp(coverage, 0.0, 1.0);
    return vec4f(color.rgb * alpha, alpha);
  }
  fn glowAlpha(outside: f32, reach: f32) -> f32 {
    if (reach <= 0.0) { return 0.0; }
    return (1.0 - smoothstep(0.0, reach, outside)) * smoothstep(-1.0, 0.0, outside);
  }`;
}
