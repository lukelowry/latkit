// The glyph pass: one quad per glyph instance in the text window, over the ports, sampling the
// atlas's signed distance field. A glyph sits at its anchor (a block's top-left, a port, a net's
// label anchor, or a group frame's top-left) plus its offset, one atlas cell scaled to its em
// size, two for a wide glyph. Text fades in between LABEL_MIN_PX and LABEL_FULL_PX em on screen,
// hides with its part and without DISPLAY_LABELS, and fades with its group's members.

@group(1) @binding(0) var<storage, read> glyph_buf: array<u32>;

// Text opacity by role: block labels and net labels, then port labels.
const LABEL_ALPHA: f32 = 0.72;
const PORT_LABEL_ALPHA: f32 = 0.85;

struct VOut {
  @builtin(position) pos: vec4f,
  // Atlas texture coordinates.
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
}

// A role's text color at `alpha`: titles and group labels in full, block, port, and net labels
// quieter, tags in the block base color over their pill.
fn glyph_color(role: u32, alpha: f32) -> vec4f {
  var color = u.text_color;
  if (role == ROLE_LABEL || role == ROLE_NET) {
    color.a = color.a * LABEL_ALPHA;
  } else if (role == ROLE_PORT) {
    color.a = color.a * PORT_LABEL_ALPHA;
  } else if (role == ROLE_TAG) {
    color = u.block_base_color;
  }
  color.a = color.a * alpha;
  return color;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> VOut {
  var out: VOut;
  out.pos = culled_position();
  if (!display(DISPLAY_LABELS)) { return out; }
  let at = i * GLYPH_WORDS;
  let anchor = glyph_buf[at];
  let index = glyph_buf[at + 1u];
  let offset = vec2f(bitcast<f32>(glyph_buf[at + 2u]), bitcast<f32>(glyph_buf[at + 3u]));
  let em = bitcast<f32>(glyph_buf[at + 4u]);
  let cell = glyph_buf[at + 5u];
  let role = glyph_buf[at + 6u];

  var origin = vec2f(0.0);
  // The group whose tile this glyph's part fades into, or NONE.
  var owner = NONE;
  if (anchor == ANCHOR_BLOCK) {
    if (index >= u.block_count || !block_visible(index)) { return out; }
    origin = block_pos(index);
    owner = block_group(index);
  } else if (anchor == ANCHOR_PORT) {
    if (index >= u.port_count) { return out; }
    let b = port_block(index);
    let net = port_net(index);
    if (!block_visible(b) || (net != NONE && !net_visible(net))) { return out; }
    origin = port_pos(index);
    owner = block_group(b);
  } else if (anchor == ANCHOR_NET) {
    if (index >= u.net_count || !net_visible(index)) { return out; }
    origin = net_anchor(index);
    owner = net_group(index);
  } else if (anchor == ANCHOR_GROUP) {
    // A group's own label stays on its tile.
    if (index >= u.group_count) { return out; }
    origin = group_bounds(index).xy;
  } else {
    return out;
  }
  if (is_nan2(origin)) { return out; }
  let alpha = text_alpha(em) * (1.0 - tile(owner));
  if (alpha <= 0.0) { return out; }

  let wide = (cell & GLYPH_WIDE) != 0u;
  let slot = cell & ~GLYPH_WIDE;
  let cols = max(u.atlas_cols, 1u);
  let cell_px = vec2f(u.atlas_cell.x * select(1.0, 2.0, wide), u.atlas_cell.y);
  let texel = vec2f(f32(slot % cols), f32(slot / cols)) * u.atlas_cell;
  // Diagram units per atlas pixel: the atlas rasterizes at atlas_font_px per em.
  let scale = em / max(u.atlas_font_px, 1e-6);
  let corner = quad_corner(vi);
  let point = origin + offset + corner * cell_px * scale;
  out.pos = to_clip(point);
  out.uv = (texel + corner * cell_px) / max(u.atlas_size, vec2f(1.0));
  out.color = glyph_color(role, alpha);
  return out;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  // Sample and differentiate before anything branches: fwidth needs uniform control flow.
  let d = textureSampleLevel(atlas_tex, linear_sampler, v.uv, 0.0).r;
  let w = max(fwidth(d) * GLYPH_SOFTNESS, 1e-4);
  let coverage = smoothstep(0.5 - w, 0.5 + w, d);
  return premultiply(layer(v.color, coverage));
}
