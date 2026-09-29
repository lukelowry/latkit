struct Uniforms { viewport: vec2f, atlas: vec2f };
struct Quad { rect: vec4f, uv: vec4f, color: vec4f };
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> quads: array<Quad>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var linear_sampler: sampler;
struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) glyph: u32,
};
@vertex fn vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Vertex {
  let q = quads[i];
  let corner = vec2f(f32(v & 1u), f32(v >> 1u));
  let point = q.rect.xy + corner * q.rect.zw;
  return Vertex(vec4f(point / U.viewport * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0),
    (q.uv.xy + corner * max(q.uv.zw, vec2f(0.0))) / U.atlas, q.color, select(0u, 1u, q.uv.z > 0.0));
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let distance = textureSampleLevel(atlas, linear_sampler, v.uv, 0.0).r;
  let coverage = glyph_coverage(distance);
  let alpha = v.color.a * select(1.0, coverage, v.glyph != 0u);
  return vec4f(v.color.rgb * alpha, alpha);
}
