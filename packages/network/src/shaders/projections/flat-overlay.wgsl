// Projection strategy: 2D affine (scale + translate).

fn to_world(pos: vec2f) -> vec3f { return vec3f(pos, 0.0); }

// Orthographic top-down: height never displaces flat geometry - it drives
// color only. Poles are degenerate under this projection and the renderer
// skips their pass entirely in flat mode.
fn displace_world(w: vec3f, h: f32) -> vec3f {
  return w;
}

fn project_world(p: vec3f) -> vec4f {
  return vec4f(p.x * u.flat_sx + u.flat_tx, p.y * u.flat_sy + u.flat_ty, 0.5, 1.0);
}

fn daylight(world: vec3f) -> f32 { return 1.0; }

fn screen_radius(clip: vec4f) -> f32 {
  let px = u.vertex_size * abs(u.flat_sx) * u.viewport.x * 0.5;
  return min(px, css_px(MAX_VERTEX_RADIUS_PX));
}

fn screen_half_width(clip: vec4f, base_width: f32) -> f32 {
  let px = base_width * abs(u.flat_sx) * u.viewport.x * 0.5;
  return clamp(px, css_px(MIN_EDGE_HALF_WIDTH_PX), css_px(MAX_EDGE_HALF_WIDTH_PX));
}

fn screen_pole_half_width(clip: vec4f) -> f32 {
  return max(screen_radius(clip) * 0.15, css_px(1.5));
}
