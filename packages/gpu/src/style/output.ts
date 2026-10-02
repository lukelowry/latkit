/** All renderers use premultiplied attachment output. Color and shade APIs use straight RGBA. */
export const premultipliedBlend: GPUBlendState = Object.freeze({
  color: Object.freeze({ srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }),
  alpha: Object.freeze({ srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }),
});
export function outputShader(): string {
  return `fn outputColor(color: vec4f, coverage: f32) -> vec4f {
    let alpha = color.a * clamp(coverage, 0.0, 1.0);
    return vec4f(color.rgb * alpha, alpha);
  }`;
}
