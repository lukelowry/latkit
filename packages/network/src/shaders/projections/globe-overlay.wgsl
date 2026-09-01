// Projection strategy: 3D sphere (lon/lat -> unit sphere -> VP matrix).
// geo_to_xyz lives in common/daylight.wgsl, shared with the plane family's
// sun_normal.

fn to_world(pos: vec2f) -> vec3f { return geo_to_xyz(pos.x, pos.y); }

// Surface overlays are lifted slightly above the opaque sphere. Height then
// visualizes radially from that lifted base: positive sticks out, negative
// sinks in.
fn displace_world(w: vec3f, h: f32) -> vec3f {
  return w * (1.0 + GLOBE_SURFACE_OFFSET + h * u.height_world_scale);
}

fn project_world(p: vec3f) -> vec4f { return u.vp * vec4f(p, 1.0); }

fn project_overlay(p: vec3f, _h: f32) -> vec4f { return project_world(p); }

// `vertex_size` is in coordinate degrees; convert through surface radians and
// cap in screen space so zoom reveals topology instead of inflating glyphs.
fn screen_radius(clip: vec4f) -> f32 {
  let px = u.vertex_size * GLOBE_VERTEX_SCALE / (clip.w * u.fov_scale) * u.viewport.y * 0.5;
  return min(px, css_px(MAX_VERTEX_RADIUS_PX));
}

fn screen_half_width(clip: vec4f, base_width: f32) -> f32 {
  let px = base_width * GLOBE_EDGE_SCALE / (clip.w * u.fov_scale) * u.viewport.y * 0.5;
  return clamp(px, css_px(MIN_EDGE_HALF_WIDTH_PX), css_px(MAX_EDGE_HALF_WIDTH_PX));
}

fn screen_pole_half_width(clip: vec4f) -> f32 {
  return max(screen_radius(clip) * 0.15, css_px(1.5));
}
