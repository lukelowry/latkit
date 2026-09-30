import { integer } from './error.js';

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
fn textColor(uv: vec2f, color: vec4f) -> vec4f {
  let distance = textureSample(latkitAtlas, latkitTextSampler, uv).r;
  let width = max(fwidth(distance), 1.0 / 255.0);
  let alpha = color.a * smoothstep(0.5 - width * 0.5, 0.5 + width * 0.5, distance);
  return vec4f(color.rgb * alpha, alpha);
}
`;
}
