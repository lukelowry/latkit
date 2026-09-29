// Retained history is remapped into the displayed domain before the shade hook.
struct Composite {
  scale: vec2f,
  offset: vec2f,
  opacity: f32,
  time: f32,
  _padding: vec2f,
  viewport: vec2f,
  pointer_px: vec2f,
  plot_origin: vec2f,
  plot_size: vec2f,
  host: array<vec4f, 16>,
};
@group(0) @binding(0) var history: texture_2d<f32>;
@group(0) @binding(1) var focus: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: Composite;
@group(0) @binding(3) var image_samp: sampler;
struct Fragment {
  color: vec4f,
  point: vec2f,
  pixel: vec2f,
  time: f32,
};
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
  let uv = in.uv * u.scale + u.offset;
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  let h = textureSampleLevel(history, image_samp, uv, 0.0) * u.opacity;
  let f = textureSampleLevel(focus, image_samp, uv, 0.0);
  let image = select(vec4f(0.0), f + h * (1.0 - f.a), inside);
  let straight = vec4f(image.rgb / max(image.a, 1e-8), image.a);
  // Call in uniform control flow so host shaders may use derivatives.
  let color = shade(Fragment(straight, vec2f(in.uv.x, 1.0 - in.uv.y),
    u.plot_origin + in.uv * u.plot_size, u.time));
  return vec4f(color.rgb * color.a, color.a);
}
