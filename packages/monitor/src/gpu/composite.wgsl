// The shown image's uv is the screen's uv * scale + offset: a stretch for a resize, and a scale and
// shift for a time or value range it was not drawn over.
struct Composite {
  scale: vec2f,
  offset: vec2f,
  opacity: f32,
};
@group(0) @binding(0) var history: texture_2d<f32>;
@group(0) @binding(1) var focus: texture_2d<f32>;
@group(0) @binding(2) var<uniform> U: Composite;
@group(0) @binding(3) var image_samp: sampler;
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vertex(@builtin(vertex_index) i: u32) -> VSOut {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return VSOut(vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0), vec2f(x, 1.0 - y));
}
@fragment fn fragment(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv * U.scale + U.offset;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.0); }
  let h = textureSampleLevel(history, image_samp, uv, 0.0) * U.opacity;
  let f = textureSampleLevel(focus, image_samp, uv, 0.0);
  return f + h * (1.0 - f.a);
}
