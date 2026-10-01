// The block pass: one rounded rectangle per block over the wires, filled by its blockColor or the
// base color and outlined. A status draws a ring just inside the edge; hover a soft halo and
// selection a ring just outside it. A block moving with a drag goes slightly translucent, and a
// block whose group has turned into a tile fades with it.

struct VOut {
  @builtin(position) pos: vec4f,
  // Diagram units from the block's center, and the diagram point for the shade.
  @location(0) local: vec2f,
  @location(1) point: vec2f,
  @location(2) @interpolate(flat) half_size: vec2f,
  @location(3) @interpolate(flat) fill: vec4f,
  @location(4) @interpolate(flat) index: u32,
  @location(5) @interpolate(flat) focus: u32,
  @location(6) @interpolate(flat) status: u32,
  @location(7) @interpolate(flat) fade: f32,
  @location(8) @interpolate(flat) value: f32,
}

// How far a block's focus rings reach outside its edge, in CSS px.
fn block_reach(focus: u32) -> f32 {
  var reach = 0.0;
  if ((focus & FOCUS_HOVER) != 0u) { reach = max(reach, HOVER_HALO_PX); }
  if ((focus & FOCUS_SELECTED) != 0u) { reach = max(reach, SELECTED_RING_PX); }
  return reach;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) b: u32) -> VOut {
  var out: VOut;
  out.pos = culled_position();
  if (b >= u.block_count || !block_visible(b)) { return out; }
  let fade = 1.0 - tile(block_group(b));
  if (fade <= 0.0) { return out; }
  let lo = block_pos(b);
  if (is_nan2(lo)) { return out; }
  let size = block_size(b);
  let focus = focus_of(PART_BLOCK, b);
  let pad = vec2f(units(block_reach(focus) + 1.0));
  let point = quad_point(lo - pad, lo + size + pad, vi);
  var fill = block_fill(b);
  if ((focus & FOCUS_DRAGGING) != 0u) { fill.a = fill.a * DRAGGING_ALPHA; }
  out.pos = to_clip(point);
  out.local = point - (lo + 0.5 * size);
  out.point = point;
  out.half_size = 0.5 * size;
  out.fill = fill;
  out.index = b;
  out.focus = focus;
  out.status = status_of(SLOT_BLOCK_STATUS, b);
  out.fade = fade;
  out.value = shade_value(SLOT_BLOCK_SHADE, b);
  return out;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let radius = min(0.5 * u.grid_pitch, min(v.half_size.x, v.half_size.y));
  let d = px(sd_round_rect(v.local, v.half_size, radius));
  var color = layer(v.fill, aa(d));
  color = over(layer(u.outline_color, aa_ring(-d, OUTLINE_PX)), color);
  if (v.status > 0u) {
    color = over(layer(status_color(v.status), aa_ring(-d, STATUS_RING_PX)), color);
  }
  if ((v.focus & FOCUS_HOVER) != 0u) {
    color = over(layer(u.hover_color, 0.5 * aa_ring(d, HOVER_HALO_PX)), color);
  }
  if ((v.focus & FOCUS_SELECTED) != 0u) {
    color = over(layer(u.selected_color, aa_ring(d, SELECTED_RING_PX)), color);
  }
  let coverage = aa(d - block_reach(v.focus));
  let f = Fragment(paint_of(color, coverage), PART_BLOCK, v.index, v.point, v.focus, v.value, 0.0, u.time);
  return emit(shade(f), coverage * v.fade);
}
