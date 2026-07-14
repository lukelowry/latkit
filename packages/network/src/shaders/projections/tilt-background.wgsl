// Tilt background: ray-traced ground plane with the shared Cartesian grid.
// Prepended at pipeline creation: VISUAL_WGSL + uniforms.wgsl +
// graticule.wgsl + tilt-ray.wgsl. Writes plane depth via frag_depth: the
// depth test against it is the only overlay occlusion mechanism. The written
// depth carries a conservative per-fragment slack (SURFACE_DEPTH_SLACK_PX)
// so surface-anchored billboards never lose their lower half to foreground
// floor at grazing pitch; sunk (negative-height) geometry still hides once
// it drops below the slack.
//
// NOTE (bg module composition): no overlay prelude is in scope here.

/** Horizon fade in multiples of camera height along the ray. */
const HORIZON_FADE_START_HEIGHTS = 8.0;
const HORIZON_FADE_END_HEIGHTS = 40.0;

const NADIR_SURFACE_FADE_START_SIN = 0.017452406; // sin(1 deg)
const NADIR_SURFACE_FADE_END_SIN = 0.17364818;    // sin(10 deg)

struct TiltBgSample {
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

fn horizon_alpha(t: f32) -> f32 {
  let heights = t / max(u.camera_pos.z, 1e-9);
  return 1.0 - smoothstep(HORIZON_FADE_START_HEIGHTS, HORIZON_FADE_END_HEIGHTS, heights);
}

fn tilt_surface_alpha() -> f32 {
  let look = vec3f(u.tilt_params.xy, 0.0);
  let to_eye = u.camera_pos - look;
  let dist = max(length(to_eye), 1e-9);
  let sin_pitch = clamp(length(to_eye.xy) / dist, 0.0, 1.0);
  return smoothstep(NADIR_SURFACE_FADE_START_SIN, NADIR_SURFACE_FADE_END_SIN, sin_pitch);
}

fn tilt_bg_sample(frag_pos: vec4f) -> TiltBgSample {
  let rd = tilt_ray_dir(frag_pos.xy);
  // cartesian_grid takes derivatives; compute the hit before any divergent
  // exit so each derivative quad stays well-defined at the horizon.
  let descending = rd.z < -1e-6;
  let t = select(1.0, -u.camera_pos.z / rd.z, descending);
  let p = u.camera_pos + rd * t;
  var grid = 0.0;
  if (grid_enabled()) {
    grid = cartesian_grid(p.xy);
  }

  if (!descending) { discard; }   // at/above the horizon

  // Fade the plane out toward the horizon in camera-height multiples: at
  // nadir t is approximately height (no fade); grazing rays grow t unboundedly.
  let fade_alpha = horizon_alpha(t);

  let grid_alpha = grid;
  let surface_alpha = tilt_surface_alpha();
  let layer_alpha = grid_alpha + surface_alpha * (1.0 - grid_alpha);
  let layer_rgb_premul =
    u.grid_color.rgb * grid_alpha +
    u.surface_color.rgb * surface_alpha * (1.0 - grid_alpha);
  let layer_rgb = select(
    vec3f(0.0),
    layer_rgb_premul / max(layer_alpha, 1e-6),
    layer_alpha > 1e-6
  );

  // Push the written depth back along the ray by the worst-case screen
  // overhang of a surface-anchored billboard whose anchor sits at this
  // fragment: overhang px converted to world at this depth, divided by the
  // grazing angle. Billboards carry their anchor's depth across the quad, so
  // without slack the nearer floor under their lower half wins the test.
  let sin_e = max(-rd.z, 1e-3);
  let world_per_px = t * u.fov_scale * 2.0 / u.viewport.y;
  let slack = css_px(SURFACE_DEPTH_SLACK_PX) * world_per_px / sin_e;

  let clip = u.vp * vec4f(p + rd * slack, 1.0);
  var out: TiltBgSample;
  out.color = vec4f(layer_rgb, layer_alpha * fade_alpha);
  out.depth = clamp(clip.z / clip.w, 0.0, 1.0);
  return out;
}

@fragment
fn fs_color(@builtin(position) frag_pos: vec4f) -> ColorOut {
  let sample = tilt_bg_sample(frag_pos);
  return ColorOut(sample.color, sample.depth);
}
