// The wire pass: every routed net entry as one quad under the blocks. A segment is a capsule
// WIRE_HALF_WIDTH_PX thick, wider and tinted while hovered, in the selected color while selected
// or targeted; a junction is a disc and an arrow a triangle with its tip at the reader port, both
// fading out once a grid pitch is under WIRE_DETAIL_GRID_PX on screen. A net with a nonzero
// netFlow marches dashes along its route, or, under reduced motion, shows still chevrons.

@group(1) @binding(0) var<storage, read> wire_buf: array<u32>;

// Reach and peak opacity of the glow on a net a wire being drawn could land on.
const WIRE_GLOW_PX: f32 = 4.0;
const WIRE_GLOW_ALPHA: f32 = 0.35;
// A reduced-motion chevron: how far each arm reaches back and out, and its stroke half-width.
const CHEVRON_ARM_PX: f32 = 3.0;
const CHEVRON_STROKE_PX: f32 = 0.75;

struct VOut {
  @builtin(position) pos: vec4f,
  // Diagram units in the entry's frame, from `a`: x along the segment (or back along an arrow),
  // y across it.
  @location(0) local: vec2f,
  @location(1) point: vec2f,
  @location(2) @interpolate(flat) color: vec4f,
  @location(3) @interpolate(flat) net: u32,
  @location(4) @interpolate(flat) kind: u32,
  @location(5) @interpolate(flat) focus: u32,
  // A segment's length, and the net's along at `a`, both diagram units.
  @location(6) @interpolate(flat) span: f32,
  @location(7) @interpolate(flat) along: f32,
  // Line half-width in CSS px.
  @location(8) @interpolate(flat) half_width: f32,
  // The net's signed dash speed; 0 draws a solid line.
  @location(9) @interpolate(flat) flow: f32,
  @location(10) @interpolate(flat) fade: f32,
  @location(11) @interpolate(flat) value: f32,
}

// Signed distance in CSS px to the chevrons a flowing wire shows under reduced motion instead of
// marching dashes: one every CHEVRON_PERIOD_PX, pointing downstream (`toward` +1) or back to the
// driver (-1). `t` runs along the wire and `n` across it, both CSS px.
fn chevron_distance(t: f32, n: f32, toward: f32) -> f32 {
  let r = t - CHEVRON_PERIOD_PX * floor(t / CHEVRON_PERIOD_PX) - 0.5 * CHEVRON_PERIOD_PX;
  let q = vec2f(r * toward, abs(n));
  let tip = vec2f(0.5 * CHEVRON_ARM_PX, 0.0);
  let tail = vec2f(-0.5 * CHEVRON_ARM_PX, CHEVRON_ARM_PX);
  return sd_capsule(q, tip, tail, CHEVRON_STROKE_PX);
}

// How far an entry's ink reaches across its frame from `a`'s line, in CSS px; an arrow's length
// runs back from its tip on its own.
fn wire_reach(kind: u32, half_width: f32, focus: u32, flow: f32) -> f32 {
  var reach = half_width;
  if (kind == WIRE_JUNCTION) { reach = JUNCTION_RADIUS_PX; }
  if (kind == WIRE_ARROW) { reach = 0.5 * ARROW_WIDTH_PX; }
  if (kind == WIRE_SEGMENT && flow != 0.0 && display(DISPLAY_REDUCED)) {
    reach = max(reach, CHEVRON_ARM_PX + CHEVRON_STROKE_PX);
  }
  if ((focus & FOCUS_COMPATIBLE) != 0u) { reach = max(reach, half_width + WIRE_GLOW_PX); }
  return reach;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> VOut {
  var out: VOut;
  out.pos = culled_position();
  let at = i * WIRE_WORDS;
  let kind = wire_buf[at + 5u];
  let net = wire_buf[at + 4u];
  if (kind == WIRE_EMPTY || kind > WIRE_ARROW || net >= u.net_count || !net_visible(net)) {
    return out;
  }
  if (kind == WIRE_JUNCTION && !display(DISPLAY_JUNCTIONS)) { return out; }
  if (kind == WIRE_ARROW && !display(DISPLAY_ARROWS)) { return out; }
  var fade = 1.0 - tile(net_group(net));
  if (kind != WIRE_SEGMENT) {
    fade = fade * smoothstep(0.5 * WIRE_DETAIL_GRID_PX, WIRE_DETAIL_GRID_PX, px(u.grid_pitch));
  }
  if (fade <= 0.0) { return out; }
  let a = vec2f(bitcast<f32>(wire_buf[at]), bitcast<f32>(wire_buf[at + 1u]));
  let b = vec2f(bitcast<f32>(wire_buf[at + 2u]), bitcast<f32>(wire_buf[at + 3u]));
  if (is_nan2(a) || is_nan2(b)) { return out; }

  let focus = focus_of(PART_NET, net);
  var color = net_color(net);
  var half_width = WIRE_HALF_WIDTH_PX;
  if ((focus & FOCUS_HOVER) != 0u) {
    half_width = WIRE_HOVER_HALF_WIDTH_PX;
    color = mix(color, u.hover_color, 0.5);
  }
  if ((focus & (FOCUS_SELECTED | FOCUS_TARGET)) != 0u) {
    half_width = WIRE_SELECTED_HALF_WIDTH_PX;
    color = u.selected_color;
  }
  let flow = net_flow(net);

  // The entry's frame: along the segment, along the arrow (whose `b` is its unit direction), or
  // any frame for a junction's disc.
  var dir = vec2f(1.0, 0.0);
  var span = 0.0;
  if (kind == WIRE_SEGMENT) {
    span = length(b - a);
    if (span > 1e-6) { dir = (b - a) / span; }
  } else if (kind == WIRE_ARROW) {
    let reach = length(b);
    if (reach > 1e-6) { dir = b / reach; }
  }
  let r = units(wire_reach(kind, half_width, focus, flow) + 1.0);
  var lo = vec2f(-r, -r);
  var hi = vec2f(span + r, r);
  if (kind == WIRE_ARROW) {
    // The arrow runs back from its tip at `a`.
    lo = vec2f(-units(ARROW_LENGTH_PX) - units(1.0), -r);
    hi = vec2f(units(1.0), r);
  }
  let q = quad_point(lo, hi, vi);
  let point = a + dir * q.x + vec2f(-dir.y, dir.x) * q.y;
  out.pos = to_clip(point);
  out.local = q;
  out.point = point;
  out.color = color;
  out.net = net;
  out.kind = kind;
  out.focus = focus;
  out.span = span;
  out.along = bitcast<f32>(wire_buf[at + 6u]);
  out.half_width = half_width;
  out.flow = flow;
  out.fade = fade;
  out.value = shade_value(SLOT_NET_SHADE, net);
  return out;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  var d = 0.0;
  var along = v.along;
  if (v.kind == WIRE_SEGMENT) {
    let s = clamp(v.local.x, 0.0, v.span);
    along = v.along + s;
    d = px(length(vec2f(v.local.x - s, v.local.y))) - v.half_width;
    if (v.flow != 0.0) {
      if (display(DISPLAY_REDUCED)) {
        // Cut to the segment's own length: past either end `along` stops, and a chevron there
        // would streak on through the quad's overhang as a spur beyond the bend.
        let beyond = px(max(-v.local.x, v.local.x - v.span));
        let chevrons = max(chevron_distance(px(along), px(v.local.y), sign(v.flow)), beyond);
        d = min(d, chevrons);
      } else {
        // Positive flow marches away from the driver.
        let phase = px(along) - u.time * DASH_SPEED_PX * u.flow_rate * v.flow;
        d = max(d, dash_distance(phase, DASH_PERIOD_PX, DASH_DUTY * DASH_PERIOD_PX));
      }
    }
  } else if (v.kind == WIRE_JUNCTION) {
    d = px(length(v.local)) - JUNCTION_RADIUS_PX;
  } else {
    let back = units(ARROW_LENGTH_PX);
    let wing = units(0.5 * ARROW_WIDTH_PX);
    d = px(sd_triangle(v.local, vec2f(0.0), vec2f(-back, -wing), vec2f(-back, wing)));
  }
  var color = layer(v.color, aa(d));
  var reach = 0.0;
  if ((v.focus & FOCUS_COMPATIBLE) != 0u) {
    let glow = WIRE_GLOW_ALPHA * pulse() * (1.0 - smoothstep(0.0, WIRE_GLOW_PX, d));
    color = over(color, layer(u.selected_color, glow));
    reach = WIRE_GLOW_PX;
  }
  let coverage = aa(d - reach);
  let f = Fragment(paint_of(color, coverage), PART_NET, v.net, v.point, v.focus, v.value, along, u.time);
  return emit(shade(f), coverage * v.fade);
}
