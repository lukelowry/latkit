// Direct-draw edge shader. One instance per topology segment, four vertices per capsule quad.

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) seg_aspect: f32,
  @location(2) @interpolate(flat) edge_id: u32,
  // Daylight at this vertex's endpoint, interpolated across the edge so long
  // segments fade naturally across the terminator instead of getting a flat
  // midpoint shade.
  @location(3) light: f32,
  @location(4) @interpolate(flat) core_ratio: f32,
  @location(5) @interpolate(flat) focus: u32,
  // Screen length for segment-local dash phase.
  @location(6) @interpolate(flat) seg_len_px: f32,
  @location(7) @interpolate(flat) edge_color: vec4f,
  @location(8) @interpolate(flat) dashed: u32,
}

struct ColorOut {
  @location(0) color: vec4f,
}

// Mirrors pick/project.ts MIN_CLIP_W. Segments crossing the camera plane are
// clipped before perspective division so their screen capsule stays finite.
const MIN_EDGE_CLIP_W: f32 = 1e-4;

fn culled_edge() -> VOut {
  var out: VOut;
  out.pos = vec4f(0.0, 0.0, 2.0, 1.0);
  out.uv = vec2f(0.0);
  out.seg_aspect = 1.0;
  out.edge_id = 0u;
  out.light = 1.0;
  out.core_ratio = 1.0;
  out.focus = 0u;
  out.seg_len_px = 0.0;
  out.edge_color = vec4f(0.0);
  out.dashed = 0u;
  return out;
}

fn edge_underlay_px(state: u32) -> f32 {
  if (state == 1u) { return u.focus_edge_hover_underlay_px; }
  if (state == 2u) { return u.focus_edge_selected_underlay_px; }
  return 0.0;
}

fn edge_underlay_alpha(d: f32, core_ratio: f32, aa: f32) -> f32 {
  let radial = 1.0 - smoothstep(core_ratio, 1.0, d);
  let outer = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  return radial * outer;
}

fn edge_capsule_distance(v: VOut) -> f32 {
  let cx = clamp(v.uv.x, 0.0, v.seg_aspect);
  return length(vec2f(v.uv.x - cx, v.uv.y));
}

fn edge_dash_discard(v: VOut) -> bool {
  if (u.dash_period <= 0.0 || v.dashed == 0u) {
    return false;
  }
  let along = clamp(v.uv.x, 0.0, v.seg_aspect) / max(v.seg_aspect, 1e-6);
  let px = along * v.seg_len_px;
  return fract(px / css_px(u.dash_period)) > 0.5;
}

fn edge_fragment_alpha(d: f32) -> f32 {
  return 1.0 - smoothstep(0.85, 1.0, d);
}

// Screen-space capsule construction. `wa`/`wb` are the final world-space
// endpoints with base lift and height already applied.
fn build_edge_capsule(
  strip: vec2f,
  edge_id: u32,
  wa: vec3f,
  wb: vec3f,
  ha: f32,
  hb: f32,
  halo: bool,
  focus_state: u32,
) -> VOut {
  var out = culled_edge();
  out.edge_id = edge_id;

  // Per-endpoint daylight; the rasterizer interpolates across the edge.
  // Globe overlays are lifted off the surface, so lighting uses their unit
  // direction. Flat daylight is a no-op and can consume the raw world point.
  var light_world = select(wa, wb, strip.x > 0.5);
  if (u.plane_mix > 0.0) { light_world = normalize(light_world); }
  out.light = daylight(light_world);

  var clip_a = project_overlay(wa, ha);
  var clip_b = project_overlay(wb, hb);
  let aw = clip_a.w;
  let bw = clip_b.w;
  if (aw <= MIN_EDGE_CLIP_W && bw <= MIN_EDGE_CLIP_W) {
    return out;
  }
  if (aw <= MIN_EDGE_CLIP_W) {
    let t = clamp((MIN_EDGE_CLIP_W - aw) / max(bw - aw, 1e-6), 0.0, 1.0);
    clip_a = mix(clip_a, clip_b, t);
  } else if (bw <= MIN_EDGE_CLIP_W) {
    let t = clamp((MIN_EDGE_CLIP_W - aw) / min(bw - aw, -1e-6), 0.0, 1.0);
    clip_b = mix(clip_a, clip_b, t);
  }

  let screen_a = (clip_a.xy / clip_a.w * 0.5 + vec2f(0.5)) * u.viewport;
  let screen_b = (clip_b.xy / clip_b.w * 0.5 + vec2f(0.5)) * u.viewport;
  let dir = screen_b - screen_a;
  let screen_len = length(dir);
  if (screen_len < 0.001) {
    return out;
  }

  let tangent = dir / screen_len;
  let normal = vec2f(-tangent.y, tangent.x);
  let mid_clip = mix(clip_a, clip_b, 0.5);
  let base_hw = screen_half_width(mid_clip, u.base_edge_width);

  var underlay_px = 0.0;
  if (halo) {
    underlay_px = css_px(edge_underlay_px(focus_state));
    if (underlay_px <= 0.0) { return out; }
  }
  let hw = base_hw + underlay_px;

  let seg_aspect = screen_len / max(hw, 0.001);
  out.seg_aspect = seg_aspect;
  out.core_ratio = base_hw / max(hw, 0.001);
  out.focus = focus_state;
  out.seg_len_px = screen_len;

  let t = strip.x;
  let side = strip.y;
  let ext_t = t * (seg_aspect + 2.0) - 1.0;
  let screen_pos = screen_a + tangent * (ext_t * hw) + normal * (side * hw);

  let clip_t = clamp(t, 0.0, 1.0);
  let interp_clip = mix(clip_a, clip_b, clip_t);
  let ndc = screen_pos * 2.0 / u.viewport - vec2f(1.0);
  var z = interp_clip.z;
  let flat_bias = select(
    Z_BIAS_EDGE_BAND_OFFSET + jitter(edge_id),
    Z_BIAS_EDGE_BAND_OFFSET - Z_BIAS_SELECTION_LIFT,
    focus_state != 0u,
  );
  let depth_bias = mix(
    flat_bias,
    select(0.0, -Z_BIAS_SELECTION_LIFT, focus_state != 0u),
    u.plane_mix,
  );
  z += depth_bias * interp_clip.w;
  out.pos = vec4f(ndc * interp_clip.w, z, interp_clip.w);
  out.uv = vec2f(ext_t, side);
  return out;
}

fn edge_common(
  strip: vec2f,
  edge_id: u32,
  endpoints: vec2u,
  wa: vec3f,
  wb: vec3f,
  ha: f32,
  hb: f32,
  role: u32,
) -> VOut {
  var focus_state = 0u;
  if (role == ROLE_FOCUS || role == ROLE_HALO) {
    let resolved_focus_state = edge_focus_state_for(i32(edge_id));
    if (resolved_focus_state == 0u) { return culled_edge(); }
    focus_state = resolved_focus_state;
  }
  var out = build_edge_capsule(strip, edge_id, wa, wb, ha, hb, role == ROLE_HALO, focus_state);
  out.edge_color = edge_channel_color_from_vertices(edge_id, endpoints);
  if (u.dash_period > 0.0) {
    out.dashed = select(0u, 1u, edge_dash_val(edge_id) < 0.5);
  }
  return out;
}

fn vs_edge(strip: vec2f, inst: u32, role: u32) -> VOut {
  let seg = segment_record(inst);
  if (!edge_visible(seg.edge_id)) { return culled_edge(); }
  let endpoints = vec2u(seg.from_vertex, seg.to_vertex);
  let h_a_endpoint = vertex_norm_height(seg.from_vertex);
  let h_b_endpoint = vertex_norm_height(seg.to_vertex);
  let surface_a = segment_surface_world(seg, inst, 0u);
  let surface_b = segment_surface_world(seg, inst, 1u);
  let ha = mix(h_a_endpoint, h_b_endpoint, seg.height_t.x);
  let hb = mix(h_a_endpoint, h_b_endpoint, seg.height_t.y);
  let wa = displace_world(surface_a, ha);
  let wb = displace_world(surface_b, hb);

  return edge_common(strip, seg.edge_id, endpoints, wa, wb, ha, hb, role);
}

@vertex
fn vs(@location(0) strip: vec2f, @builtin(instance_index) inst: u32) -> VOut {
  return vs_edge(strip, inst, ROLE_BASE);
}

@vertex
fn vs_focus(@location(0) strip: vec2f, @builtin(instance_index) inst: u32) -> VOut {
  return vs_edge(strip, inst, ROLE_FOCUS);
}

@vertex
fn vs_halo(@location(0) strip: vec2f, @builtin(instance_index) inst: u32) -> VOut {
  return vs_edge(strip, inst, ROLE_HALO);
}

fn edge_fragment_color(v: VOut) -> vec4f {
  let d = edge_capsule_distance(v);
  if (d > 1.0) { discard; }

  // Original AA window: solid line out to d=0.85, soft fade to d=1.0. Visible
  // width is 1.85*hw - proportional AA scales naturally with line thickness.
  // Segment-local screen-space dash phase.
  if (edge_dash_discard(v)) { discard; }

  // Sphere occlusion is the depth test against the bg-written surface depth.
  let alpha = edge_fragment_alpha(d);
  if (alpha < FRAGMENT_ALPHA_DISCARD) { discard; }
  return vec4f(v.edge_color.rgb * v.light, v.edge_color.a * alpha);
}

@fragment
fn fs_color(v: VOut) -> ColorOut {
  return ColorOut(edge_fragment_color(v));
}

fn edge_underlay_fragment_color(v: VOut) -> vec4f {
  let cx = clamp(v.uv.x, 0.0, v.seg_aspect);
  let d = length(vec2f(v.uv.x - cx, v.uv.y));
  let aa = fwidth(d);
  if (d > 1.0) { discard; }

  if (u.dash_period > 0.0 && v.dashed != 0u) {
    let along = clamp(v.uv.x, 0.0, v.seg_aspect) / max(v.seg_aspect, 1e-6);
    let px = along * v.seg_len_px;
    if (fract(px / css_px(u.dash_period)) > 0.5) { discard; }
  }

  let selected = v.focus == 2u;
  let alpha = edge_underlay_alpha(d, v.core_ratio, aa) *
    select(u.focus_hover_alpha, u.focus_selected_alpha, selected);
  if (alpha < FRAGMENT_ALPHA_DISCARD) { discard; }

  let packed = select(u.focus_hover_color, u.focus_selected_color, selected);
  return vec4f(unpack4x8unorm(packed).rgb, alpha);
}

@fragment
fn fs_underlay_color(v: VOut) -> ColorOut {
  return ColorOut(edge_underlay_fragment_color(v));
}
