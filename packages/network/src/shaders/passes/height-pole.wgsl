// Direct-draw height pole shader. Instance index is the vertex id.

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  // Perpendicular axis across the pole's screen width: -1 (left edge) to +1
  // (right edge). The fragment shader uses fwidth(uv_x) to draw soft edges.
  @location(1) uv_x: f32,
  @location(2) @interpolate(flat) vertex_id: u32,
}

struct ColorOut {
  @location(0) color: vec4f,
}

fn culled_pole(inst: u32) -> VOut {
  var out: VOut;
  out.pos = vec4f(0.0, 0.0, 2.0, 1.0);
  out.color = vec4f(0.0);
  out.uv_x = 0.0;
  out.vertex_id = inst;
  return out;
}

fn vs_pole(quad: vec2f, inst: u32) -> VOut {
  let pos = vertex_coord(inst);
  let surface = vertex_surface_world(inst, pos);
  let base = displace_world(surface, 0.0);

  let h = vertex_norm_height(inst);
  if (abs(h) < 1e-6) {
    return culled_pole(inst);
  }

  let base_clip = project_overlay(base, 0.0);
  let tip_clip = project_overlay(displace_world(surface, h), h);
  let at_tip = quad.y > 0.0;
  let clip = select(base_clip, tip_clip, at_tip);

  let sw_base = (base_clip.xy / base_clip.w * 0.5 + vec2f(0.5)) * u.viewport;
  let sw_tip  = (tip_clip.xy / tip_clip.w * 0.5 + vec2f(0.5)) * u.viewport;
  let dir = sw_tip - sw_base;
  let len = length(dir);
  if (len < 0.5) {
    return culled_pole(inst);
  }

  let normal = vec2f(-dir.y, dir.x) / len;
  let hw = screen_pole_half_width(base_clip);
  let offset = normal * quad.x * hw * 2.0 / u.viewport * clip.w;

  var out: VOut;
  let z_bias = pole_sort_z_bias(inst) * (1.0 - u.plane_mix);
  out.pos = vec4f(clip.xy + offset, clip.z + z_bias * clip.w, clip.w);
  let base_color = vertex_channel_color(inst);
  out.color = vec4f(base_color.rgb * daylight(surface), base_color.a);
  out.uv_x = quad.x;
  out.vertex_id = inst;
  return out;
}

@vertex
fn vs(@location(0) quad: vec2f, @builtin(instance_index) inst: u32) -> VOut {
  return vs_pole(quad, inst);
}

fn pole_fragment_alpha(uv_x: f32) -> f32 {
  // 1-pixel fwidth-driven AA on the pole's left/right edges. Sphere
  // occlusion is the depth test against the bg-written surface depth.
  let aa = fwidth(uv_x);
  return 1.0 - smoothstep(1.0 - aa, 1.0, abs(uv_x));
}

fn pole_fragment_color(v: VOut) -> vec4f {
  let alpha = pole_fragment_alpha(v.uv_x);
  if (alpha < FRAGMENT_ALPHA_DISCARD) { discard; }
  return vec4f(v.color.rgb, v.color.a * alpha);
}

@fragment
fn fs_color(v: VOut) -> ColorOut {
  return ColorOut(pole_fragment_color(v));
}
