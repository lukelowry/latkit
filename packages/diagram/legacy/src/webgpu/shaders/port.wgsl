// The port pass: a marker where each port meets its block's edge, half outside it, over the
// blocks: `in` a triangle pointing into the block, `out` one pointing out, `both` a disc, one grid
// pitch across, in its kind's color and hollow while unwired. A port on a tag net also draws its
// net's tag, a pill its text sits in. A status draws a ring around the port, hover a halo,
// selection and a wire's current target a ring, and a port a wire could land on a soft pulsing
// glow. Markers fold into the block edge below PORT_FOLD_PX on screen.

// Reach and peak opacity of the glow on a port a wire being drawn could land on.
const PORT_GLOW_PX: f32 = 6.0;
const PORT_GLOW_ALPHA: f32 = 0.45;
// A tag pill's fill: its port color, slightly darkened under its text.
const TAG_SHADE: f32 = 0.9;

struct VOut {
  @builtin(position) pos: vec4f,
  // Diagram units in the port's side frame, from the port: x outward from the block edge, y along
  // it. Every shape below is laid out in this frame, so one layout serves all four sides.
  @location(0) local: vec2f,
  @location(1) point: vec2f,
  @location(2) @interpolate(flat) color: vec4f,
  @location(3) @interpolate(flat) index: u32,
  @location(4) @interpolate(flat) flow: u32,
  // 1 for a top or bottom port, whose tag lies across the side frame so its text reads level.
  @location(5) @interpolate(flat) across: u32,
  @location(6) @interpolate(flat) wired: u32,
  @location(7) @interpolate(flat) focus: u32,
  @location(8) @interpolate(flat) status: u32,
  // The tag pill's length from the port, 0 without a tag.
  @location(9) @interpolate(flat) tag_length: f32,
  // The marker's fold, the tag's fold, and the member fade of the block's group.
  @location(10) @interpolate(flat) fades: vec3f,
  @location(11) @interpolate(flat) value: f32,
}

// A tag pill's box in the side frame, (x0, y0, x1, y1): a side port's tag runs outward from half a
// grid pitch out to its length, two pitches tall; a top or bottom port's lies across, centered on
// the port, its length wide.
fn tag_box(tag_len: f32, across: bool) -> vec4f {
  let gap = 0.5 * u.grid_pitch;
  let tall = u.grid_pitch;
  if (across) {
    return vec4f(gap, -0.5 * tag_len, gap + 2.0 * tall, 0.5 * tag_len);
  }
  return vec4f(gap, -tall, max(tag_len, gap), tall);
}

// Signed distance in diagram units to a tag pill, in the side frame.
fn sd_tag(q: vec2f, tag_len: f32, across: bool) -> f32 {
  let pill = tag_box(tag_len, across);
  let half_size = 0.5 * (pill.zw - pill.xy);
  let radius = min(half_size.x, half_size.y);
  return sd_round_rect(q - 0.5 * (pill.xy + pill.zw), half_size, radius);
}

// Signed distance in diagram units to a port's marker, in the side frame.
fn sd_marker(q: vec2f, flow: u32) -> f32 {
  let r = 0.5 * u.grid_pitch;
  if (flow == FLOW_BOTH) {
    return sd_circle(q, r);
  }
  if (flow == FLOW_OUT) {
    return sd_triangle(q, vec2f(r, 0.0), vec2f(-r, -r), vec2f(-r, r));
  }
  return sd_triangle(q, vec2f(-r, 0.0), vec2f(r, -r), vec2f(r, r));
}

// How far a port's rings reach outside its shape, in CSS px: its status ring, then the widest
// focus ring outside that.
fn port_reach(focus: u32, status: u32) -> f32 {
  var reach = 0.0;
  if ((focus & FOCUS_HOVER) != 0u) { reach = max(reach, HOVER_HALO_PX); }
  if ((focus & (FOCUS_SELECTED | FOCUS_TARGET)) != 0u) { reach = max(reach, SELECTED_RING_PX); }
  if ((focus & FOCUS_COMPATIBLE) != 0u) { reach = max(reach, PORT_GLOW_PX); }
  return select(0.0, STATUS_RING_PX, status > 0u) + reach;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) p: u32) -> VOut {
  var out: VOut;
  out.pos = culled_position();
  if (p >= u.port_count) { return out; }
  let b = port_block(p);
  if (!block_visible(b)) { return out; }
  let member = 1.0 - tile(block_group(b));
  if (member <= 0.0) { return out; }
  let origin = port_pos(p);
  if (is_nan2(origin)) { return out; }
  let net = port_net(p);
  let side = port_side(p);
  let across = side == SIDE_TOP || side == SIDE_BOTTOM;
  let marker_fold = smoothstep(0.5 * PORT_FOLD_PX, PORT_FOLD_PX, px(u.grid_pitch));
  var tag_len = 0.0;
  var tag_fold = 0.0;
  // A hidden tag net hides its tags.
  if (port_tagged(p) && (net == NONE || net_visible(net))) {
    tag_len = port_tag_length(p);
    tag_fold = smoothstep(0.5 * PORT_FOLD_PX, PORT_FOLD_PX, px(2.0 * u.grid_pitch));
  }
  if (marker_fold <= 0.0 && (tag_len <= 0.0 || tag_fold <= 0.0)) { return out; }
  let r = 0.5 * u.grid_pitch;
  var lo = vec2f(-r, -r);
  var hi = vec2f(r, r);
  if (tag_len > 0.0) {
    let pill = tag_box(tag_len, across);
    lo = min(lo, pill.xy);
    hi = max(hi, pill.zw);
  }
  let focus = focus_of(PART_PORT, p);
  let status = status_of(SLOT_PORT_STATUS, p);
  let pad = vec2f(units(port_reach(focus, status) + 1.0));
  let q = quad_point(lo - pad, hi + pad, vi);
  let n = side_normal(side);
  let point = origin + n * q.x + vec2f(-n.y, n.x) * q.y;
  out.pos = to_clip(point);
  out.local = q;
  out.point = point;
  out.color = port_color(port_kind(p));
  out.index = p;
  out.flow = port_flow(p);
  out.across = select(0u, 1u, across);
  out.wired = select(0u, 1u, net != NONE);
  out.focus = focus;
  out.status = status;
  out.tag_length = tag_len;
  out.fades = vec3f(marker_fold, tag_fold, member);
  out.value = shade_value(SLOT_BLOCK_SHADE, b);
  return out;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let focus = v.focus;
  let tagged = v.tag_length > 0.0;
  let marker_d = px(sd_marker(v.local, v.flow));
  // The silhouette the rings follow: the marker, joined by the pill when the port has a tag, and
  // the fold of whatever of it still shows.
  var d = marker_d;
  var tag_d = 0.0;
  var shown = v.fades.x;
  if (tagged) {
    tag_d = px(sd_tag(v.local, v.tag_length, v.across != 0u));
    d = min(d, tag_d);
    shown = max(shown, v.fades.y);
  }
  // Focus rings sit outside the status ring.
  let ring = d - select(0.0, STATUS_RING_PX, v.status > 0u);
  var color = vec4f(0.0);
  if ((focus & FOCUS_COMPATIBLE) != 0u) {
    let glow = PORT_GLOW_ALPHA * pulse() * (1.0 - smoothstep(0.0, PORT_GLOW_PX, ring));
    color = layer(u.selected_color, glow * shown);
  }
  if (tagged) {
    let pill = vec4f(v.color.rgb * TAG_SHADE, v.color.a);
    color = over(layer(pill, aa(tag_d) * v.fades.y), color);
  }
  var marker = aa(marker_d);
  if (v.wired == 0u) { marker = aa_ring(-marker_d, OUTLINE_PX); }
  color = over(layer(v.color, marker * v.fades.x), color);
  if (v.status > 0u) {
    color = over(layer(status_color(v.status), aa_ring(d, STATUS_RING_PX) * shown), color);
  }
  if ((focus & FOCUS_HOVER) != 0u) {
    color = over(layer(u.hover_color, 0.5 * aa_ring(ring, HOVER_HALO_PX) * shown), color);
  }
  if ((focus & (FOCUS_SELECTED | FOCUS_TARGET)) != 0u) {
    color = over(layer(u.selected_color, aa_ring(ring, SELECTED_RING_PX) * shown), color);
  }
  let coverage = aa(d - port_reach(focus, v.status));
  let f = Fragment(paint_of(color, coverage), PART_PORT, v.index, v.point, focus, v.value, 0.0, u.time);
  return emit(shade(f), coverage * v.fades.z);
}
