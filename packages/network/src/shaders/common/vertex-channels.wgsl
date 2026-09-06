// Channel-direct helpers for vertex-scoped values.
// Group 0 is shared by every render pipeline.

@group(0) @binding(1) var<storage, read> channels: array<u32>;
@group(0) @binding(2) var cm_lut:  texture_2d<f32>;
@group(0) @binding(3) var cm_samp: sampler;

fn rf(i: u32) -> f32 { return bitcast<f32>(channels[i]); }

fn vertex_visible(vi: u32) -> bool {
  if ((u.item_flags & ITEM_VERTEX_VISIBLE) == 0u) { return true; }
  return rf(u.v_visible_offset + vi) > 0.0;
}

fn colormap(t: f32) -> vec3f {
  // Vertex-stage sampling needs an explicit LOD; textureSample is fragment-only.
  return textureSampleLevel(cm_lut, cm_samp, vec2f(clamp(t, 0.0, 1.0), 0.5), 0.0).rgb;
}

fn vertex_norm_height(vi: u32) -> f32 {
  if (u.v_height_mode == 0u) { return 0.0; }
  let t = clamp((rf(u.v_height_offset + vi) - u.v_height_min) * u.v_height_scale, 0.0, 1.0);
  return u.v_height_out_min + t * u.v_height_out_span;
}

fn vertex_size_scale(vi: u32) -> f32 {
  if (u.v_size_mode == 0u) { return 1.0; }
  let t = clamp((rf(u.v_size_offset + vi) - u.v_size_min) * u.v_size_scale, 0.0, 1.0);
  return u.v_size_out_min + t * u.v_size_out_span;
}

fn vertex_channel_color(vi: u32) -> vec4f {
  if (u.v_color_mode == 0u) { return u.v_base_color; }
  let t = (rf(u.v_color_offset + vi) - u.v_color_min) * u.v_color_scale;
  return vec4f(colormap(t), 1.0);
}
