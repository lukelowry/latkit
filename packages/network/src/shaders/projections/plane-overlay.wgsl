fn to_world(pos: vec2f) -> vec3f { return vec3f(pos, 0.0); }

fn height_rank(h: f32) -> f32 {
  if (u.v_height_mode == 0u) { return 0.0; }
  return clamp((h - u.height_out_min) / max(abs(u.height_out_scale), 1e-6), 0.0, 1.0);
}

fn displace_world(w: vec3f, h: f32) -> vec3f {
  let z = TILT_SURFACE_LIFT * u.vertex_size + h * u.height_world_scale;
  return vec3f(w.xy, w.z + z * u.depth_mix);
}

fn project_world(p: vec3f) -> vec4f {
  if (u.depth_mix == 0.0) {
    return vec4f(p.x * u.flat_sx + u.flat_tx, p.y * u.flat_sy + u.flat_ty, 0.5, 1.0);
  }
  return u.vp * vec4f(p, 1.0);
}

fn project_overlay(p: vec3f, h: f32) -> vec4f {
  var clip = project_world(p);
  clip.z -= height_rank(h) * FLAT_HEIGHT_DEPTH_SPAN * (1.0 - u.depth_mix) * clip.w;
  return clip;
}

fn screen_radius(clip: vec4f) -> f32 {
  if (u.depth_mix == 0.0) {
    return min(
      u.vertex_size * abs(u.flat_sx) * u.viewport.x * 0.5,
      css_px(MAX_VERTEX_RADIUS_PX),
    );
  }
  let px = u.vertex_size / (clip.w * u.fov_scale) * u.viewport.y * 0.5;
  return min(px, css_px(MAX_VERTEX_RADIUS_PX));
}

fn screen_half_width(clip: vec4f, width: f32) -> f32 {
  var px = width * abs(u.flat_sx) * u.viewport.x * 0.5;
  if (u.depth_mix > 0.0) {
    px = width / (clip.w * u.fov_scale) * u.viewport.y * 0.5;
  }
  return clamp(px, css_px(MIN_EDGE_HALF_WIDTH_PX), css_px(MAX_EDGE_HALF_WIDTH_PX));
}

fn screen_pole_half_width(clip: vec4f) -> f32 {
  return max(screen_radius(clip) * 0.15, css_px(1.5));
}

fn daylight(_world: vec3f) -> f32 { return 1.0; }
