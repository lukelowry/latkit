// Globe background: ray-traced lit sphere with shared graticule.
// Prepended at pipeline creation:
// uniforms.wgsl + graticule.wgsl + globe-ray.wgsl + daylight.wgsl.
// Renders a full-screen triangle with ray-sphere math.

// Sphere base tone tracks the theme (u.surface_color); a subtle pole darkening keeps the
// equator/pole gradient the fixed constants used to give. See uniforms.wgsl.
const POLE_DARKEN = 0.88;

// Depth-slack ceiling in world units (sphere radius 1): keeps the limb's
// occlusion cut crisp where the grazing term would otherwise diverge.
const GLOBE_DEPTH_SLACK_MAX: f32 = 0.02;

struct GlobeBgSample {
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

fn globe_bg_sample(frag_pos: vec4f) -> GlobeBgSample {
  let rd = globe_ray_dir_for_fragment(frag_pos.xy);
  let t = globe_ray_unit_sphere_t(u.camera_pos, rd);
  let p_safe = u.camera_pos + rd * max(t, 0.0);

  // geographic_graticule() takes derivatives. Run it before discard so each
  // derivative quad is well-defined even at the sphere edge. Guard at the
  // call site too, so graticule=false skips the lon/lat conversion work.
  var grid = 0.0;
  if (grid_enabled()) {
    let lat = asin(clamp(p_safe.y, -1.0, 1.0));
    let lon = atan2(-p_safe.z, p_safe.x);
    grid = geographic_graticule(lon, lat);
  }

  if (t < 0.0) { discard; }

  let normal = normalize(p_safe);

  // Same slack as the tilt floor (SURFACE_DEPTH_SLACK_PX): billboards
  // anchored on the near face must not lose their sphere-side half to the
  // closer surface bulge. Clamped so the horizon cut stays crisp - geometry
  // meaningfully behind the limb still hides.
  let sin_e = max(-dot(rd, normal), 1e-3);
  let world_per_px = t * u.fov_scale * 2.0 / u.viewport.y;
  let slack = min(css_px(SURFACE_DEPTH_SLACK_PX) * world_per_px / sin_e, GLOBE_DEPTH_SLACK_MAX);
  let clip = u.vp * vec4f(p_safe + rd * slack, 1.0);

  let pole_mix = abs(normal.y);
  let base = mix(u.surface_color.rgb, u.surface_color.rgb * POLE_DARKEN, pole_mix);

  let surface_color = base * surface_daylight(normal);
  let grid_color = u.grid_color.rgb * daylight(normal);
  let color = mix(surface_color, grid_color, grid);

  var out: GlobeBgSample;
  out.color = vec4f(color, 1.0);
  out.depth = clamp(clip.z / clip.w, 0.0, 1.0);
  return out;
}

@fragment
fn fs_color(@builtin(position) frag_pos: vec4f) -> ColorOut {
  let sample = globe_bg_sample(frag_pos);
  return ColorOut(sample.color, sample.depth);
}
