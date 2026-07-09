// Projection strategy: perspective over the ground plane z = 0.

fn to_world(pos: vec2f) -> vec3f { return vec3f(pos, 0.0); }

// Base lift keeps zero-height overlays off the bg plane's depth: overlay
// depth is vertex-interpolated clip z while the bg recomputes plane depth
// per fragment from a ray - different arithmetic, no bit-equality, so
// less-equal alone cannot prevent flicker at lift 0 (the globe learned
// this first; same pattern as GLOBE_SURFACE_OFFSET). Height rises on top
// with the shared plane visual budget, but as true geometry - negative
// heights sink below the plane and the bg's depth culls them once they
// drop past its billboard slack (see tilt-bg.wgsl).
fn displace_world(w: vec3f, h: f32) -> vec3f {
  return vec3f(w.xy, w.z + TILT_SURFACE_LIFT * u.vertex_size + h * u.height_world_scale);
}

fn project_world(p: vec3f) -> vec4f { return u.vp * vec4f(p, 1.0); }

// Perspective sizing: the globe's form minus the degree->arc conversion -
// plane units are world units already. Matches camera/tilt.ts
// projectVertexShape / projectSegmentShape exactly.
fn screen_radius(clip: vec4f) -> f32 {
  let px = u.vertex_size / (clip.w * u.fov_scale) * u.viewport.y * 0.5;
  return min(px, MAX_VERTEX_RADIUS_PX);
}

fn screen_half_width(clip: vec4f, base_width: f32) -> f32 {
  let px = base_width / (clip.w * u.fov_scale) * u.viewport.y * 0.5;
  return clamp(px, MIN_EDGE_HALF_WIDTH_PX, MAX_EDGE_HALF_WIDTH_PX);
}

fn screen_pole_half_width(clip: vec4f) -> f32 {
  return max(screen_radius(clip) * 0.15, 1.5);
}

fn daylight(world: vec3f) -> f32 { return 1.0; }
