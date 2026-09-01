struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
};

struct ColorOut {
  @location(0) color: vec4f,
}

// The border tint tracks the app theme (u.border_color, host-sourced from a quiet neutral token) so
// the coastlines/admin lines stay legible in both light and dark instead of the former hardcoded
// blue-gray (which also broke DESIGN.md's warm-neutral rule). The per-tier ALPHA is the visual
// hierarchy - major boundary strongest, minor faintest, coastline between - so it stays fixed here.
fn border_alpha(layer: u32) -> f32 {
  if (layer == 0u) { return 0.42; }
  if (layer == 1u) { return 0.24; }
  return 0.34;
}

fn border_color(layer: u32) -> vec4f {
  return vec4f(u.border_color.rgb, border_alpha(layer));
}

@vertex
fn vs(
  @location(0) lonlat: vec2f,
  @location(1) ecef: vec3f,
  @location(2) layer: u32,
) -> VOut {
  // border_world returns the FINAL world position, anti-z-fight lift
  // included - each projection's def owns its lift direction (radial on
  // the globe, +z on planes).
  let world = border_world(lonlat, ecef);
  let clip = project_world(world);

  var out: VOut;
  out.pos = clip;

  let c = border_color(layer);
  out.color = vec4f(c.rgb * daylight(world), c.a);
  return out;
}

@fragment
fn fs_color(v: VOut) -> ColorOut {
  return ColorOut(v.color);
}
