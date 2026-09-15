@group(0) @binding(0) var history: texture_2d<f32>;
@group(0) @binding(1) var focus: texture_2d<f32>;
@group(0) @binding(2) var<uniform> opacity: f32;
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let h = textureLoad(history, vec2i(p.xy), 0) * opacity;
  let f = textureLoad(focus, vec2i(p.xy), 0);
  return f + h * (1.0 - f.a);
}
