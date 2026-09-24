// The overlay pass: the editing marks over everything. A marquee is a faint rectangle with a
// dashed outline and a wire preview a dashed line, both in the selected color; the ghost of a
// removed block is its rounded rectangle fading out at the entry's alpha. A preview
// is one entry per leg; each carries the preview's length before it, so the dashes run on
// unbroken around every bend.

@group(1) @binding(0) var<storage, read> overlay_buf: array<u32>;

// Marquee fill opacity, and the preview line's half-width in CSS px.
const MARQUEE_FILL_ALPHA: f32 = 0.08;
const PREVIEW_HALF_WIDTH_PX: f32 = 0.75;

struct VOut {
  @builtin(position) pos: vec4f,
  // Diagram units: from a rectangle's center, or along and across a preview segment from its start.
  @location(0) local: vec2f,
  // A rectangle's half extents, or a segment's (length, 0).
  @location(1) @interpolate(flat) half_size: vec2f,
  @location(2) @interpolate(flat) kind: u32,
  @location(3) @interpolate(flat) alpha: f32,
  // A preview segment's distance along the whole preview at its start, diagram units.
  @location(4) @interpolate(flat) along: f32,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> VOut {
  var out: VOut;
  out.pos = culled_position();
  let at = i * OVERLAY_WORDS;
  let kind = overlay_buf[at];
  if (kind < OVERLAY_MARQUEE || kind > OVERLAY_GHOST) { return out; }
  let p0 = vec2f(bitcast<f32>(overlay_buf[at + 1u]), bitcast<f32>(overlay_buf[at + 2u]));
  let p1 = vec2f(bitcast<f32>(overlay_buf[at + 3u]), bitcast<f32>(overlay_buf[at + 4u]));
  if (is_nan2(p0) || is_nan2(p1)) { return out; }
  out.kind = kind;
  out.alpha = bitcast<f32>(overlay_buf[at + 5u]);
  if (kind == OVERLAY_PREVIEW) {
    let span = length(p1 - p0);
    var dir = vec2f(1.0, 0.0);
    if (span > 1e-6) { dir = (p1 - p0) / span; }
    let r = units(PREVIEW_HALF_WIDTH_PX + 1.0);
    let q = quad_point(vec2f(-r, -r), vec2f(span + r, r), vi);
    out.pos = to_clip(p0 + dir * q.x + vec2f(-dir.y, dir.x) * q.y);
    out.local = q;
    out.half_size = vec2f(span, 0.0);
    out.along = bitcast<f32>(overlay_buf[at + OVERLAY_ALONG]);
    return out;
  }
  let lo = min(p0, p1);
  let hi = max(p0, p1);
  let pad = vec2f(units(1.0));
  let point = quad_point(lo - pad, hi + pad, vi);
  out.pos = to_clip(point);
  out.local = point - 0.5 * (lo + hi);
  out.half_size = 0.5 * (hi - lo);
  return out;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let period = PREVIEW_DASH_PX + PREVIEW_GAP_PX;
  if (v.kind == OVERLAY_PREVIEW) {
    let s = clamp(v.local.x, 0.0, v.half_size.x);
    let line = px(length(vec2f(v.local.x - s, v.local.y))) - PREVIEW_HALF_WIDTH_PX;
    let dashed = max(line, dash_distance(px(v.along + s), period, PREVIEW_DASH_PX));
    return premultiply(layer(u.selected_color, aa(dashed)));
  }
  if (v.kind == OVERLAY_MARQUEE) {
    let d = px(sd_round_rect(v.local, v.half_size, 0.0));
    // Dashes run along whichever edge is nearer: x on the top and bottom, y on the sides.
    let to_side = v.half_size.x - abs(v.local.x);
    let to_top = v.half_size.y - abs(v.local.y);
    let t = px(select(v.local.y + v.half_size.y, v.local.x + v.half_size.x, to_top < to_side));
    let outline = max(abs(d + 0.5 * OUTLINE_PX) - 0.5 * OUTLINE_PX, dash_distance(t, period, PREVIEW_DASH_PX));
    var color = layer(u.selected_color, MARQUEE_FILL_ALPHA * aa(d));
    color = over(layer(u.selected_color, aa(outline)), color);
    return premultiply(color);
  }
  // A ghost: the removed block's rounded rectangle, fading out.
  let radius = min(0.5 * u.grid_pitch, min(v.half_size.x, v.half_size.y));
  let d = px(sd_round_rect(v.local, v.half_size, radius));
  var color = layer(u.block_base_color, aa(d));
  color = over(layer(u.outline_color, aa_ring(-d, OUTLINE_PX)), color);
  return premultiply(layer(color, clamp(v.alpha, 0.0, 1.0)));
}
