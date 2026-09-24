// The group pass: one rounded frame per group over its members' bounds, under the wires and
// blocks, with a header strip its label sits in. A frame narrower than TILE_START_PX on screen
// fills toward an opaque tile while its members fade (they read tile() themselves).

// Width of a hovered or selected frame's outline.
const GROUP_FOCUS_PX: f32 = 2.0;
// Opacity of the outline color in the frame's outline and in its header strip.
const GROUP_OUTLINE_ALPHA: f32 = 0.35;
const GROUP_HEADER_ALPHA: f32 = 0.06;

struct VOut {
  @builtin(position) pos: vec4f,
  // Diagram units from the frame's center, and the diagram point for the shade.
  @location(0) local: vec2f,
  @location(1) point: vec2f,
  @location(2) @interpolate(flat) half_size: vec2f,
  @location(3) @interpolate(flat) index: u32,
  @location(4) @interpolate(flat) focus: u32,
  @location(5) @interpolate(flat) tiled: f32,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) g: u32) -> VOut {
  var out: VOut;
  out.pos = culled_position();
  if (g >= u.group_count) { return out; }
  let bounds = group_bounds(g);
  // NaN bounds: no member shows.
  if (is_nan2(bounds.xy) || is_nan2(bounds.zw)) { return out; }
  let lo = min(bounds.xy, bounds.zw);
  let hi = max(bounds.xy, bounds.zw);
  let pad = vec2f(units(1.0));
  let point = quad_point(lo - pad, hi + pad, vi);
  out.pos = to_clip(point);
  out.local = point - 0.5 * (lo + hi);
  out.point = point;
  out.half_size = 0.5 * (hi - lo);
  out.index = g;
  out.focus = focus_of(PART_GROUP, g);
  out.tiled = tile(g);
  return out;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let radius = min(0.5 * u.grid_pitch, min(v.half_size.x, v.half_size.y));
  let d = px(sd_round_rect(v.local, v.half_size, radius));
  let edge = aa(d);
  // Negative inside the header strip, the frame's top three grid pitches.
  let header = aa(px(v.local.y + v.half_size.y - 3.0 * u.grid_pitch));
  let fill = mix(u.group_color, vec4f(u.block_base_color.rgb, 1.0), v.tiled);
  var color = layer(fill, edge);
  let strip = vec4f(u.outline_color.rgb, u.outline_color.a * GROUP_HEADER_ALPHA);
  color = over(layer(strip, edge * header), color);
  let outline = vec4f(u.outline_color.rgb, u.outline_color.a * GROUP_OUTLINE_ALPHA);
  color = over(layer(outline, aa_ring(-d, OUTLINE_PX)), color);
  if ((v.focus & FOCUS_HOVER) != 0u) {
    color = over(layer(u.hover_color, aa_ring(-d, GROUP_FOCUS_PX)), color);
  }
  if ((v.focus & FOCUS_SELECTED) != 0u) {
    color = over(layer(u.selected_color, aa_ring(-d, GROUP_FOCUS_PX)), color);
  }
  let f = Fragment(paint_of(color, edge), PART_GROUP, v.index, v.point, v.focus, 0.0, 0.0, u.time);
  return emit(shade(f), edge);
}
