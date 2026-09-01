// Direct-draw vertex billboard shader. Instance index is the vertex id.

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) focus: u32,
  @location(3) @interpolate(flat) core_ratio: f32,
  // Vertex id, carried for focus and diagnostic shader paths.
  @location(4) @interpolate(flat) vertex_id: u32,
}

struct ColorOut {
  @location(0) color: vec4f,
}

fn culled_vertex() -> VOut {
  var out: VOut;
  out.pos = vec4f(0.0, 0.0, 2.0, 1.0);
  out.color = vec4f(0.0);
  out.uv = vec2f(0.0);
  out.focus = 0u;
  out.core_ratio = 1.0;
  out.vertex_id = 0u;
  return out;
}

fn vertex_underlay_px(state: u32) -> f32 {
  if (state == 1u) { return u.focus_vertex_hover_underlay_px; }
  if (state == 2u) { return u.focus_vertex_selected_underlay_px; }
  return 0.0;
}

fn vs_vertex(quad: vec2f, inst: u32, role: u32) -> VOut {
  var out = culled_vertex();
  out.vertex_id = inst;
  if (!vertex_visible(inst)) { return out; }
  let resolved_state = vertex_focus_state_for(i32(inst));
  if ((role == ROLE_FOCUS || role == ROLE_HALO) && resolved_state == 0u) { return out; }
  var state = resolved_state;
  if (role == ROLE_BASE) { state = 0u; }

  let pos = vertex_coord(inst);
  let h = vertex_norm_height(inst);
  let world = displace_world(vertex_surface_world(inst, pos), h);
  let clip = project_overlay(world, h);

  let r = screen_radius(clip) * vertex_size_scale(inst);
  if (r < css_px(u.vertex_lod)) {
    return out;
  }

  var underlay_px = 0.0;
  if (role == ROLE_HALO) {
    underlay_px = css_px(vertex_underlay_px(state));
    if (underlay_px <= 0.0) { return out; }
  }

  let outer = r + underlay_px;
  let ndc_offset = quad * (outer + 1.0) * 2.0 / u.viewport * clip.w;
  var z = clip.z;
  let flat_bias = select(
    Z_BIAS_VERTEX_BAND_OFFSET + jitter(inst),
    Z_BIAS_VERTEX_BAND_OFFSET - Z_BIAS_SELECTION_LIFT,
    state != 0u,
  );
  let depth_bias = mix(
    flat_bias,
    select(0.0, -Z_BIAS_SELECTION_LIFT, state != 0u),
    u.depth_mix,
  );
  z += depth_bias * clip.w;
  out.pos = vec4f(clip.xy + ndc_offset, z, clip.w);

  let base_color = vertex_channel_color(inst);
  out.color = vec4f(base_color.rgb * daylight(world), base_color.a);
  out.uv = quad;
  out.focus = state;
  out.core_ratio = r / max(outer, 0.001);
  return out;
}

@vertex
fn vs(@location(0) quad: vec2f, @builtin(instance_index) inst: u32) -> VOut {
  return vs_vertex(quad, inst, ROLE_BASE);
}

@vertex
fn vs_focus(@location(0) quad: vec2f, @builtin(instance_index) inst: u32) -> VOut {
  return vs_vertex(quad, inst, ROLE_FOCUS);
}

@vertex
fn vs_halo(@location(0) quad: vec2f, @builtin(instance_index) inst: u32) -> VOut {
  return vs_vertex(quad, inst, ROLE_HALO);
}

fn vertex_fragment_alpha(uv: vec2f) -> f32 {
  let d = length(uv);
  // fwidth must run in uniform control flow, so compute the AA width up front
  // before any conditional branch can return or discard.
  let aa = fwidth(d);

  // 1-pixel AA edge on top of MSAA. aa is approximately 1 / screen_radius, so
  // the smoothstep window is exactly one pixel wide regardless of vertex size.
  return 1.0 - smoothstep(1.0 - aa, 1.0, d);
}

fn vertex_fragment_color(v: VOut) -> vec4f {
  let alpha = vertex_fragment_alpha(v.uv);
  if (alpha < FRAGMENT_ALPHA_DISCARD) { discard; }
  return vec4f(v.color.rgb, v.color.a * alpha);
}

@fragment
fn fs_color(v: VOut) -> ColorOut {
  return ColorOut(vertex_fragment_color(v));
}

fn vertex_underlay_fragment_color(v: VOut) -> vec4f {
  let d = length(v.uv);
  let aa = fwidth(d);
  if (d > 1.0) { discard; }

  let radial = 1.0 - smoothstep(v.core_ratio, 1.0, d);
  let outer = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  let selected = v.focus == 2u;
  let alpha = radial * outer *
    select(u.focus_hover_alpha, u.focus_selected_alpha, selected);
  if (alpha < FRAGMENT_ALPHA_DISCARD) { discard; }

  let packed = select(u.focus_hover_color, u.focus_selected_color, selected);
  return vec4f(unpack4x8unorm(packed).rgb, alpha);
}

@fragment
fn fs_underlay_color(v: VOut) -> ColorOut {
  return ColorOut(vertex_underlay_fragment_color(v));
}
