// Channel-direct helpers for edge-scoped values.

fn edge_visible(ei: u32) -> bool {
  if ((u.item_flags & ITEM_EDGE_VISIBLE) == 0u) { return true; }
  let v = rf(u.e_visible_offset + ei);
  return !no_value(v) && v > 0.0;
}

fn edge_color_val(ei: u32) -> f32 {
  return rf(u.e_color_offset + ei);
}

fn edge_dash_val(ei: u32) -> f32 {
  return rf(u.e_dash_offset + ei);
}

fn edge_shade_val(ei: u32) -> f32 {
  if ((u.item_flags & ITEM_EDGE_SHADE) == 0u) { return 0.0; }
  return rf(u.e_shade_offset + ei);
}

fn edge_channel_color_from_vertices(ei: u32, ep: vec2u) -> vec4f {
  if (u.e_color_mode == 1u) {
    let v = edge_color_val(ei);
    if (!no_value(v)) { return vec4f(colormap((v - u.e_color_min) * u.e_color_scale), 1.0); }
  }
  // Unbound or no value: the base edge color when one is set, else the endpoint average.
  if ((u.display_flags & DISPLAY_EDGE_BASE_COLOR) != 0u) { return u.e_base_color; }
  return (vertex_channel_color(ep.x) + vertex_channel_color(ep.y)) * 0.5;
}
