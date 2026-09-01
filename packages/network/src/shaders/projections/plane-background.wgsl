// Plane background: the ground plane, drawn identically in flat and tilt so
// the palette never shifts with the camera - u.depth_mix selects only the
// inverse projection (orthographic vs perspective ray), never the look.
// Prepended at pipeline creation:
// uniforms.wgsl + graticule.wgsl + camera-ray.wgsl + daylight.wgsl + sun_normal.
// The bg writes surface depth via frag_depth; overlays depth-test against it.

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

// Shared surface tone: themed ground lit by the solar terminator, graticule
// lines mixed on top - the exact composition globe-background uses.
fn ground_color(p: vec3f, grid: f32) -> vec3f {
  let surface = u.surface_color.rgb * surface_daylight(p);
  let grid_rgb = u.grid_color.rgb * daylight(p);
  return mix(surface, grid_rgb, grid);
}

fn flat_sample(frag_pos: vec4f) -> PlaneSample {
  let ndc = vec2f(
    frag_pos.x / u.viewport.x * 2.0 - 1.0,
    1.0 - frag_pos.y / u.viewport.y * 2.0,
  );
  let p = vec2f(
    (ndc.x - u.flat_tx) / u.flat_sx,
    (ndc.y - u.flat_ty) / u.flat_sy,
  );
  let grid = cartesian_grid(p);
  return PlaneSample(vec4f(ground_color(vec3f(p, 0.0), grid), 1.0), 0.5);
}

fn plane_sample(frag_pos: vec4f) -> PlaneSample {
  if (u.depth_mix == 0.0) { return flat_sample(frag_pos); }
  let rd = camera_ray(frag_pos.xy);
  let descending = rd.z < -1e-6;
  let t = select(1.0, -u.camera_pos.z / rd.z, descending);
  let p = u.camera_pos + rd * t;
  // cartesian_grid takes derivatives: evaluate before the horizon discard so
  // each derivative quad is well-defined at the horizon line.
  let grid = cartesian_grid(p.xy);
  if (!descending) { discard; }

  let heights = t / max(u.camera_pos.z, 1e-9);
  let fade = 1.0 - smoothstep(HORIZON_START, HORIZON_END, heights);

  let sin_e = max(-rd.z, 1e-3);
  let world_per_px = t * u.fov_scale * 2.0 / u.viewport.y;
  let slack = css_px(SURFACE_DEPTH_SLACK_PX) * world_per_px / sin_e;
  let clip = u.vp * vec4f(p + rd * slack, 1.0);
  return PlaneSample(vec4f(ground_color(p, grid), fade), clamp(clip.z / clip.w, 0.0, 1.0));
}

@fragment
fn fs_color(@builtin(position) frag_pos: vec4f) -> ColorOut {
  let sample = plane_sample(frag_pos);
  return ColorOut(sample.color, sample.depth);
}
