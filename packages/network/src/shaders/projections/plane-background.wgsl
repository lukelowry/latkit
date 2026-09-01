const HORIZON_START = 8.0;
const HORIZON_END = 40.0;

struct PlaneSample {
  color: vec4f,
  depth: f32,
}

struct ColorOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
  let x = f32(vid % 2u) * 4.0 - 1.0;
  let y = f32(vid / 2u) * 4.0 - 1.0;
  return vec4f(x, y, 0.5, 1.0);
}

fn flat_sample(frag_pos: vec4f) -> PlaneSample {
  if (!grid_enabled()) { discard; }
  let ndc = vec2f(
    frag_pos.x / u.viewport.x * 2.0 - 1.0,
    1.0 - frag_pos.y / u.viewport.y * 2.0,
  );
  let p = vec2f(
    (ndc.x - u.flat_tx) / u.flat_sx,
    (ndc.y - u.flat_ty) / u.flat_sy,
  );
  let grid = cartesian_grid(p);
  if (grid < 0.001) { discard; }
  return PlaneSample(vec4f(u.grid_color.rgb, grid), 0.5);
}

fn plane_sample(frag_pos: vec4f) -> PlaneSample {
  if (u.depth_mix == 0.0) { return flat_sample(frag_pos); }
  let rd = camera_ray(frag_pos.xy);
  let descending = rd.z < -1e-6;
  let t = select(1.0, -u.camera_pos.z / rd.z, descending);
  let p = u.camera_pos + rd * t;
  var grid = 0.0;
  if (grid_enabled()) { grid = cartesian_grid(p.xy); }
  if (!descending) { discard; }

  let heights = t / max(u.camera_pos.z, 1e-9);
  let fade = 1.0 - smoothstep(HORIZON_START, HORIZON_END, heights);
  let surface = u.depth_mix;
  let alpha = grid + surface * (1.0 - grid);
  let premul =
    u.grid_color.rgb * grid +
    u.surface_color.rgb * surface * (1.0 - grid);
  let rgb = select(vec3f(0.0), premul / max(alpha, 1e-6), alpha > 1e-6);

  let sin_e = max(-rd.z, 1e-3);
  let world_per_px = t * u.fov_scale * 2.0 / u.viewport.y;
  let slack = css_px(SURFACE_DEPTH_SLACK_PX) * world_per_px / sin_e;
  let clip = u.vp * vec4f(p + rd * slack, 1.0);
  return PlaneSample(vec4f(rgb, alpha * fade), clamp(clip.z / clip.w, 0.0, 1.0));
}

@fragment
fn fs_color(@builtin(position) frag_pos: vec4f) -> ColorOut {
  let sample = plane_sample(frag_pos);
  return ColorOut(sample.color, sample.depth);
}
