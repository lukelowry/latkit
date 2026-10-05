import { integer } from '../error.js';

/** Six vertices per instance. The renderer maps textVertex().position into its own coordinates. */
export function textShader(options: { readonly group: number }): string {
  const group = integer(options.group, 'text bind group', 0, 3);
  return /* wgsl */ `
struct LatkitText { rect: vec4f, uv: vec4f, color: vec4f, anchor: u32, p0: u32, p1: u32, p2: u32 }
struct TextVertex { position: vec2f, uv: vec2f, color: vec4f, anchor: u32 }
@group(${group}) @binding(0) var<storage, read> latkitText: array<LatkitText>;
@group(${group}) @binding(1) var latkitAtlas: texture_2d<f32>;
@group(${group}) @binding(2) var latkitTextSampler: sampler;
fn textVertex(vertex: u32, instance: u32) -> TextVertex {
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let corner = corners[vertex]; let item = latkitText[instance];
  return TextVertex(item.rect.xy + corner * item.rect.zw, mix(item.uv.xy, item.uv.zw, corner), item.color, item.anchor);
}
/** A text bank's anchor: where its text's origin sits, its depth, and the slot it names. */
struct LatkitAnchor { position: vec2f, depth: f32, slot: u32, shown: bool }
fn latkitAnchor(anchor: vec4f) -> LatkitAnchor {
  return LatkitAnchor(anchor.xy, anchor.z, u32(max(anchor.w - 1.0, 0.0)), anchor.w > 0.5);
}
/**
 * Premultiplied text over a halo of \`halo\` color \`haloPx\` screen pixels wide, which keeps lines
 * from cutting through it; a clear halo draws the text alone.
 */
fn textColor(uv: vec2f, color: vec4f, halo: vec4f, haloPx: f32) -> vec4f {
  let distance = textureSample(latkitAtlas, latkitTextSampler, uv).r;
  // Distance-field units per screen pixel.
  let width = max(fwidth(distance), 1.0 / 255.0);
  let ink = color.a * smoothstep(0.5 - width * 0.5, 0.5 + width * 0.5, distance);
  let edge = max(0.5 - haloPx * width, 0.02);
  let ring = halo.a * smoothstep(edge - width * 0.5, edge + width * 0.5, distance) * step(0.001, haloPx);
  return vec4f(color.rgb * ink + halo.rgb * ring * (1.0 - ink), ink + ring * (1.0 - ink));
}
`;
}
