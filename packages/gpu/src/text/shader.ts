/** Shared WGSL SDF coverage. Call in uniform fragment control flow. */
export const glyphShader = `
fn glyph_coverage(distance: f32) -> f32 {
  let width = max(fwidth(distance) * 0.7, 1e-4);
  return smoothstep(0.5 - width, 0.5 + width, distance);
}
`;
