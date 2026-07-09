// Channel-direct helpers for edge-scoped values.

fn edge_color_val(ei: u32) -> f32 {
  return rf(u.e_color_offset + ei);
}

fn edge_dash_val(ei: u32) -> f32 {
  return rf(u.e_dash_offset + ei);
}

fn edge_channel_color_from_vertices(ei: u32, ep: vec2u) -> vec4f {
  if (u.e_color_mode == 1u) {
    let t = (edge_color_val(ei) - u.e_color_min) * u.e_color_scale;
    return vec4f(colormap(t), 1.0);
  }
  // Mode 0: average the endpoint colors.
  return (vertex_channel_color(ep.x) + vertex_channel_color(ep.y)) * 0.5;
}
