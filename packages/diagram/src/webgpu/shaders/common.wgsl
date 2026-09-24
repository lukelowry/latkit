// The prelude of every diagram pass: the uniform block, bind group 0, record layouts and
// constants, accessors, signed distance functions, and coverage helpers. The renderer prepends it
// to every pass module; unit tests hold the struct layout and every constant to the TypeScript
// side (webgpu/uniforms.ts, webgpu/buffers.ts, channels.ts, part.ts, prepare.ts, visual.ts).
//
// Units: diagram units are CSS pixels at zoom 1, y down; `_PX` values are CSS pixels; `viewport`
// is in device pixels, so `viewport / backing_scale` is the CSS size.

struct Uniforms {
  // Frame.
  viewport: vec2f,
  backing_scale: f32,
  // Seconds, wrapping every hour.
  time: f32,

  // Camera: the diagram point at the viewport center, CSS px per diagram unit, and the grid pitch
  // in diagram units.
  center: vec2f,
  zoom: f32,
  grid_pitch: f32,
  // Canvas-local CSS px, POINTER_NONE when absent.
  pointer_px: vec2f,
  // DISPLAY_* bits.
  flags: u32,
  flow_rate: f32,

  // Counts, and the word offsets of each record family in its buffer.
  block_count: u32,
  port_count: u32,
  net_count: u32,
  group_count: u32,
  port_base: u32,
  net_base: u32,
  group_base: u32,
  anchor_base: u32,
  focus_port: u32,
  focus_net: u32,
  focus_group: u32,
  status_count: u32,
  port_color_count: u32,

  // Glyph atlas geometry, in atlas pixels.
  atlas_cols: u32,
  atlas_font_px: f32,
  atlas_sdf_px: f32,
  atlas_size: vec2f,
  atlas_cell: vec2f,

  // Theme, straight alpha.
  block_base_color: vec4f,
  outline_color: vec4f,
  net_base_color: vec4f,
  text_color: vec4f,
  grid_color: vec4f,
  group_color: vec4f,
  hover_color: vec4f,
  selected_color: vec4f,
  status_colors: array<vec4f, 4>,
  port_colors: array<vec4f, 8>,

  // Per SLOT_*: x the slot's word offset in channel_buf, y 1 while bound, z and w the f32 bits of
  // the colormap normalization `(value - min) * scale`.
  channels: array<vec4u, 9>,

  // The host shade's block, written by Shade.tick before every frame.
  host: array<vec4f, 16>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
// [blocks | ports | nets] records.
@group(0) @binding(1) var<storage, read> structure_buf: array<u32>;
// [positions 2B | group bounds 4G | net anchors 2N].
@group(0) @binding(2) var<storage, read> layout_buf: array<f32>;
// Channel slots in SLOT_* order.
@group(0) @binding(3) var<storage, read> channel_buf: array<f32>;
// [blocks | ports | nets | groups] FOCUS_* flags.
@group(0) @binding(4) var<storage, read> focus_buf: array<u32>;
@group(0) @binding(5) var colormap_tex: texture_2d<f32>;
@group(0) @binding(6) var atlas_tex: texture_2d<f32>;
@group(0) @binding(7) var linear_sampler: sampler;

// Indices and sentinels.
const NONE: u32 = 0xffffffffu;
const POINTER_NONE: f32 = -1e6;

// Part kinds.
const PART_BLOCK: u32 = 0u;
const PART_PORT: u32 = 1u;
const PART_NET: u32 = 2u;
const PART_GROUP: u32 = 3u;

// Port flows, port sides, and net styles.
const FLOW_IN: u32 = 0u;
const FLOW_OUT: u32 = 1u;
const FLOW_BOTH: u32 = 2u;
const SIDE_LEFT: u32 = 0u;
const SIDE_RIGHT: u32 = 1u;
const SIDE_TOP: u32 = 2u;
const SIDE_BOTTOM: u32 = 3u;
const STYLE_WIRE: u32 = 0u;
const STYLE_TAG: u32 = 1u;

// u.flags bits.
const DISPLAY_GRID: u32 = 1u;
const DISPLAY_ARROWS: u32 = 2u;
const DISPLAY_JUNCTIONS: u32 = 4u;
const DISPLAY_LABELS: u32 = 8u;
const DISPLAY_REDUCED: u32 = 16u;
const DISPLAY_EDIT: u32 = 32u;

// focus_buf bits.
const FOCUS_HOVER: u32 = 1u;
const FOCUS_SELECTED: u32 = 2u;
const FOCUS_COMPATIBLE: u32 = 4u;
const FOCUS_TARGET: u32 = 8u;
const FOCUS_DRAGGING: u32 = 16u;

// Channel slots: u.channels[SLOT_*].
const SLOT_BLOCK_COLOR: u32 = 0u;
const SLOT_BLOCK_VISIBLE: u32 = 1u;
const SLOT_BLOCK_STATUS: u32 = 2u;
const SLOT_BLOCK_SHADE: u32 = 3u;
const SLOT_PORT_STATUS: u32 = 4u;
const SLOT_NET_COLOR: u32 = 5u;
const SLOT_NET_FLOW: u32 = 6u;
const SLOT_NET_VISIBLE: u32 = 7u;
const SLOT_NET_SHADE: u32 = 8u;

// Block record: w f32, h f32, group u32, flags u32.
const BLOCK_WORDS: u32 = 4u;
const BLOCK_TITLED: u32 = 1u;
// Port record: block u32, offX f32, offY f32, packed u32, net u32, tagLength f32, pad, pad.
const PORT_WORDS: u32 = 8u;
const PORT_FLOW_MASK: u32 = 0x3u;
const PORT_SIDE_SHIFT: u32 = 2u;
const PORT_KIND_SHIFT: u32 = 4u;
const PORT_TAG: u32 = 0x1000u;
// Net record: driver u32, group u32, style u32, portCount u32.
const NET_WORDS: u32 = 4u;

// Wire entry: ax f32, ay f32, bx f32, by f32, net u32, kind u32, along f32, pad.
const WIRE_WORDS: u32 = 8u;
const WIRE_EMPTY: u32 = 0u;
const WIRE_SEGMENT: u32 = 1u;
const WIRE_JUNCTION: u32 = 2u;
const WIRE_ARROW: u32 = 3u;

// Glyph entry: anchor u32, index u32, offX f32, offY f32, em f32, cell u32, role u32, pad.
const GLYPH_WORDS: u32 = 8u;
const ANCHOR_BLOCK: u32 = 0u;
const ANCHOR_PORT: u32 = 1u;
const ANCHOR_NET: u32 = 2u;
const ANCHOR_GROUP: u32 = 3u;
const ROLE_TITLE: u32 = 0u;
const ROLE_LABEL: u32 = 1u;
const ROLE_PORT: u32 = 2u;
const ROLE_TAG: u32 = 3u;
const ROLE_NET: u32 = 4u;
const ROLE_GROUP: u32 = 5u;
const GLYPH_WIDE: u32 = 0x80000000u;

// Overlay entry: kind u32, x0 f32, y0 f32, x1 f32, y1 f32, alpha f32, along f32, pad; along is a
// preview entry's distance along the whole preview at (x0, y0), in diagram units.
const OVERLAY_WORDS: u32 = 8u;
const OVERLAY_ALONG: u32 = 6u;
const OVERLAY_MARQUEE: u32 = 1u;
const OVERLAY_PREVIEW: u32 = 2u;
const OVERLAY_GHOST: u32 = 3u;

// Visual tuning, CSS px unless named otherwise: visual.ts VISUAL, key for key.
const WIRE_HALF_WIDTH_PX: f32 = 0.75;
const WIRE_HOVER_HALF_WIDTH_PX: f32 = 1.25;
const WIRE_SELECTED_HALF_WIDTH_PX: f32 = 1.5;
const JUNCTION_RADIUS_PX: f32 = 2.5;
const ARROW_LENGTH_PX: f32 = 7.0;
const ARROW_WIDTH_PX: f32 = 6.0;
const WIRE_DETAIL_GRID_PX: f32 = 4.0;
const DASH_PERIOD_PX: f32 = 10.0;
const DASH_DUTY: f32 = 0.6;
const DASH_SPEED_PX: f32 = 40.0;
const CHEVRON_PERIOD_PX: f32 = 16.0;
const GRID_DOT_RADIUS_PX: f32 = 1.0;
const GRID_MIN_SPACING_PX: f32 = 8.0;
const GRID_FULL_SPACING_PX: f32 = 16.0;
const OUTLINE_PX: f32 = 1.0;
const STATUS_RING_PX: f32 = 2.0;
const HOVER_HALO_PX: f32 = 3.0;
const SELECTED_RING_PX: f32 = 2.0;
const DRAGGING_ALPHA: f32 = 0.85;
const LABEL_MIN_PX: f32 = 4.5;
const LABEL_FULL_PX: f32 = 7.0;
const PORT_FOLD_PX: f32 = 3.0;
const TILE_START_PX: f32 = 96.0;
const TILE_FULL_PX: f32 = 40.0;
const PREVIEW_DASH_PX: f32 = 6.0;
const PREVIEW_GAP_PX: f32 = 4.0;
const GLYPH_SOFTNESS: f32 = 0.7;

// ---------------------------------------------------------------------------------------------
// Display and transforms

fn display(flag: u32) -> bool {
  return (u.flags & flag) != 0u;
}

// The canvas size in CSS px.
fn viewport_css() -> vec2f {
  return u.viewport / max(u.backing_scale, 1e-6);
}

// Diagram units to clip space: `(p - center) * zoom * 2 / viewport_css`, y flipped.
fn to_clip(p: vec2f) -> vec4f {
  let ndc = (p - u.center) * u.zoom * 2.0 / viewport_css();
  return vec4f(ndc.x, -ndc.y, 0.0, 1.0);
}

// Diagram units to canvas-local CSS px, where u.pointer_px lives.
fn to_screen(p: vec2f) -> vec2f {
  return (p - u.center) * u.zoom + 0.5 * viewport_css();
}

// A diagram-unit length in CSS px.
fn px(d: f32) -> f32 {
  return d * u.zoom;
}

// A CSS-px length in diagram units.
fn units(css: f32) -> f32 {
  return css / max(u.zoom, 1e-6);
}

// Corner `vi % 6` of a two-triangle quad, in [0, 1]^2: (0,0) (1,0) (0,1), (0,1) (1,0) (1,1).
fn quad_corner(vi: u32) -> vec2f {
  let i = vi % 6u;
  let x = select(0.0, 1.0, i == 1u || i == 4u || i == 5u);
  let y = select(0.0, 1.0, i == 2u || i == 3u || i == 5u);
  return vec2f(x, y);
}

// Whether a float is NaN, by its bits: fast-math may fold `x != x` away. Empty group bounds and
// absent net anchors are NaN.
fn is_nan(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u;
}

// ---------------------------------------------------------------------------------------------
// Structure and layout

fn block_pos(b: u32) -> vec2f {
  return vec2f(layout_buf[2u * b], layout_buf[2u * b + 1u]);
}

fn block_size(b: u32) -> vec2f {
  let at = b * BLOCK_WORDS;
  return vec2f(bitcast<f32>(structure_buf[at]), bitcast<f32>(structure_buf[at + 1u]));
}

fn block_group(b: u32) -> u32 {
  return structure_buf[b * BLOCK_WORDS + 2u];
}

fn block_flags(b: u32) -> u32 {
  return structure_buf[b * BLOCK_WORDS + 3u];
}

fn port_record(p: u32) -> u32 {
  return u.port_base + p * PORT_WORDS;
}

fn port_block(p: u32) -> u32 {
  return structure_buf[port_record(p)];
}

// Relative to the block's top-left.
fn port_offset(p: u32) -> vec2f {
  let at = port_record(p);
  return vec2f(bitcast<f32>(structure_buf[at + 1u]), bitcast<f32>(structure_buf[at + 2u]));
}

fn port_packed(p: u32) -> u32 {
  return structure_buf[port_record(p) + 3u];
}

fn port_flow(p: u32) -> u32 {
  return port_packed(p) & PORT_FLOW_MASK;
}

fn port_side(p: u32) -> u32 {
  return (port_packed(p) >> PORT_SIDE_SHIFT) & 0x3u;
}

fn port_kind(p: u32) -> u32 {
  return (port_packed(p) >> PORT_KIND_SHIFT) & 0xffu;
}

// Whether the port draws its net's tag.
fn port_tagged(p: u32) -> bool {
  return (port_packed(p) & PORT_TAG) != 0u;
}

fn port_net(p: u32) -> u32 {
  return structure_buf[port_record(p) + 4u];
}

fn port_tag_length(p: u32) -> f32 {
  return bitcast<f32>(structure_buf[port_record(p) + 5u]);
}

fn port_pos(p: u32) -> vec2f {
  return block_pos(port_block(p)) + port_offset(p);
}

// The outward unit normal of a port's side.
fn side_normal(side: u32) -> vec2f {
  switch side {
    case SIDE_LEFT: { return vec2f(-1.0, 0.0); }
    case SIDE_RIGHT: { return vec2f(1.0, 0.0); }
    case SIDE_TOP: { return vec2f(0.0, -1.0); }
    default: { return vec2f(0.0, 1.0); }
  }
}

fn net_record(n: u32) -> u32 {
  return u.net_base + n * NET_WORDS;
}

fn net_driver(n: u32) -> u32 {
  return structure_buf[net_record(n)];
}

fn net_group(n: u32) -> u32 {
  return structure_buf[net_record(n) + 1u];
}

fn net_style(n: u32) -> u32 {
  return structure_buf[net_record(n) + 2u];
}

fn net_port_count(n: u32) -> u32 {
  return structure_buf[net_record(n) + 3u];
}

// (x0, y0, x1, y1) with the header strip; NaN when no member shows.
fn group_bounds(g: u32) -> vec4f {
  let at = u.group_base + 4u * g;
  return vec4f(layout_buf[at], layout_buf[at + 1u], layout_buf[at + 2u], layout_buf[at + 3u]);
}

// Where a net's label sits; NaN when the net has no route.
fn net_anchor(n: u32) -> vec2f {
  let at = u.anchor_base + 2u * n;
  return vec2f(layout_buf[at], layout_buf[at + 1u]);
}

// ---------------------------------------------------------------------------------------------
// Channels, focus, and color

fn channel_on(slot: u32) -> bool {
  return u.channels[slot].y != 0u;
}

// A channel's raw value for item `i`; read only while `channel_on(slot)`.
fn channel(slot: u32, i: u32) -> f32 {
  return channel_buf[u.channels[slot].x + i];
}

// A colormap channel's value through its domain, clamped to [0, 1].
fn channel_t(slot: u32, i: u32) -> f32 {
  let record = u.channels[slot];
  return clamp((channel(slot, i) - bitcast<f32>(record.z)) * bitcast<f32>(record.w), 0.0, 1.0);
}

fn block_visible(b: u32) -> bool {
  return !channel_on(SLOT_BLOCK_VISIBLE) || channel(SLOT_BLOCK_VISIBLE, b) != 0.0;
}

fn net_visible(n: u32) -> bool {
  return !channel_on(SLOT_NET_VISIBLE) || channel(SLOT_NET_VISIBLE, n) != 0.0;
}

// A status channel's integer; 0 is none.
fn status_of(slot: u32, i: u32) -> u32 {
  if (!channel_on(slot)) { return 0u; }
  return u32(max(round(channel(slot, i)), 0.0));
}

// A shade channel's value for Fragment.value; 0 when unbound.
fn shade_value(slot: u32, i: u32) -> f32 {
  if (!channel_on(slot)) { return 0.0; }
  return channel(slot, i);
}

// A net's signed dash speed; 0 when unbound.
fn net_flow(n: u32) -> f32 {
  if (!channel_on(SLOT_NET_FLOW)) { return 0.0; }
  return channel(SLOT_NET_FLOW, n);
}

// FOCUS_* flags of part `i` of kind `part`.
fn focus_of(part: u32, i: u32) -> u32 {
  var base = 0u;
  if (part == PART_PORT) {
    base = u.focus_port;
  } else if (part == PART_NET) {
    base = u.focus_net;
  } else if (part == PART_GROUP) {
    base = u.focus_group;
  }
  return focus_buf[base + i];
}

// Status color k > 0, clamped to the last one configured.
fn status_color(k: u32) -> vec4f {
  let count = max(u.status_count, 1u);
  return u.status_colors[min(max(k, 1u), count) - 1u];
}

// Port color by kind, cycling through the configured ones.
fn port_color(kind: u32) -> vec4f {
  return u.port_colors[kind % max(u.port_color_count, 1u)];
}

// The colormap at t in [0, 1], opaque; t = 0 and t = 1 land on the first and last texel centers.
fn colormap(t: f32) -> vec4f {
  let x = (clamp(t, 0.0, 1.0) * 255.0 + 0.5) / 256.0;
  // Explicit LOD: vertex stages cannot use implicit derivatives.
  return textureSampleLevel(colormap_tex, linear_sampler, vec2f(x, 0.5), 0.0);
}

// A block's fill: its blockColor through the colormap, else the base color.
fn block_fill(b: u32) -> vec4f {
  if (!channel_on(SLOT_BLOCK_COLOR)) { return u.block_base_color; }
  return vec4f(colormap(channel_t(SLOT_BLOCK_COLOR, b)).rgb, u.block_base_color.a);
}

// A net's wire color: its netColor through the colormap, else the base color.
fn net_color(n: u32) -> vec4f {
  if (!channel_on(SLOT_NET_COLOR)) { return u.net_base_color; }
  return vec4f(colormap(channel_t(SLOT_NET_COLOR, n)).rgb, u.net_base_color.a);
}

// How far a group has turned into a solid tile: 0 while its frame is wide on screen, 1 once it
// is narrower than TILE_FULL_PX. Members fade by `1 - tile`.
fn tile(g: u32) -> f32 {
  if (g == NONE) { return 0.0; }
  let bounds = group_bounds(g);
  if (is_nan(bounds.x)) { return 0.0; }
  return 1.0 - smoothstep(TILE_FULL_PX, TILE_START_PX, px(bounds.z - bounds.x));
}

// Text opacity for an em size in diagram units: invisible below LABEL_MIN_PX on screen.
fn text_alpha(em: f32) -> f32 {
  return smoothstep(LABEL_MIN_PX, LABEL_FULL_PX, px(em));
}

// Straight-alpha `top` over straight-alpha `bottom`.
fn over(top: vec4f, bottom: vec4f) -> vec4f {
  let a = top.a + bottom.a * (1.0 - top.a);
  if (a <= 0.0) { return vec4f(0.0); }
  return vec4f((top.rgb * top.a + bottom.rgb * bottom.a * (1.0 - top.a)) / a, a);
}

// Straight to premultiplied alpha, for the premultiplied "over" blend every pass uses.
fn premultiply(c: vec4f) -> vec4f {
  return vec4f(c.rgb * c.a, c.a);
}

// ---------------------------------------------------------------------------------------------
// Signed distances (negative inside) and coverage

fn sd_circle(p: vec2f, radius: f32) -> f32 {
  return length(p) - radius;
}

// A rectangle of half extents `half_size` centered at the origin, corners rounded by `radius`.
fn sd_round_rect(p: vec2f, half_size: vec2f, radius: f32) -> f32 {
  let q = abs(p) - half_size + vec2f(radius);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

// A segment from `a` to `b` thickened to `radius`.
fn sd_capsule(p: vec2f, a: vec2f, b: vec2f, radius: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
  return length(pa - ba * h) - radius;
}

// The triangle `a b c`, either winding.
fn sd_triangle(p: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
  let e0 = b - a;
  let e1 = c - b;
  let e2 = a - c;
  let v0 = p - a;
  let v1 = p - b;
  let v2 = p - c;
  let pq0 = v0 - e0 * clamp(dot(v0, e0) / max(dot(e0, e0), 1e-12), 0.0, 1.0);
  let pq1 = v1 - e1 * clamp(dot(v1, e1) / max(dot(e1, e1), 1e-12), 0.0, 1.0);
  let pq2 = v2 - e2 * clamp(dot(v2, e2) / max(dot(e2, e2), 1e-12), 0.0, 1.0);
  let s = sign(e0.x * e2.y - e0.y * e2.x);
  let d = min(
    min(
      vec2f(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
      vec2f(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x)),
    ),
    vec2f(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)),
  );
  return -sqrt(d.x) * sign(d.y);
}

// Coverage of a shape whose edge is `d` CSS px away (negative inside), over one device pixel.
fn aa(d: f32) -> f32 {
  return clamp(0.5 - d * u.backing_scale, 0.0, 1.0);
}

// Coverage of a line of half-width `half_width` CSS px at distance `d` from its center.
fn aa_band(d: f32, half_width: f32) -> f32 {
  return aa(abs(d) - half_width);
}

// Coverage of a ring `width` CSS px wide just outside an edge at distance `d`.
fn aa_ring(d: f32, width: f32) -> f32 {
  return aa(abs(d - 0.5 * width) - 0.5 * width);
}

// Signed distance in CSS px from `t`, a position along a line in CSS px, to the nearest dash of a
// pattern that draws `on` px of every `period` from t = 0; negative inside a dash.
fn dash_distance(t: f32, period: f32, on: f32) -> f32 {
  let q = t - 0.5 * on;
  let r = q - period * floor(q / period);
  return min(r, period - r) - 0.5 * on;
}

// ---------------------------------------------------------------------------------------------
// Pass plumbing

// Canvas-local CSS px to diagram units: the inverse of to_screen.
fn from_screen(css: vec2f) -> vec2f {
  return (css - 0.5 * viewport_css()) / max(u.zoom, 1e-6) + u.center;
}

// A clip position outside the view volume. Every vertex of a culled instance lands on it, so its
// triangles are degenerate and clipped away before they cost a fragment.
fn culled_position() -> vec4f {
  return vec4f(0.0, 0.0, 2.0, 1.0);
}

// Corner `vi % 6` of the quad from `lo` to `hi`.
fn quad_point(lo: vec2f, hi: vec2f, vi: u32) -> vec2f {
  return mix(lo, hi, quad_corner(vi));
}

// Whether either coordinate of a point is NaN.
fn is_nan2(p: vec2f) -> bool {
  return is_nan(p.x) || is_nan(p.y);
}

// `color` at `coverage`: its alpha scaled, one layer for `over`.
fn layer(color: vec4f, coverage: f32) -> vec4f {
  return vec4f(color.rgb, color.a * clamp(coverage, 0.0, 1.0));
}

// What a part paints under its silhouette: a composite of layers, whose alpha carries the
// silhouette's own coverage, with that coverage divided back out. A shade sees this color, and
// `emit` puts the edge back after it, so a shade that ignores `f.color` still draws the part's
// anti-aliased shape rather than its quad.
fn paint_of(composite: vec4f, coverage: f32) -> vec4f {
  if (coverage <= 0.0) { return vec4f(composite.rgb, 0.0); }
  return vec4f(composite.rgb, min(composite.a / coverage, 1.0));
}

// A pass's output: straight-alpha `color` at `coverage`, clamped and premultiplied for the blend.
fn emit(color: vec4f, coverage: f32) -> vec4f {
  let c = clamp(color, vec4f(0.0), vec4f(1.0));
  return premultiply(vec4f(c.rgb, c.a * clamp(coverage, 0.0, 1.0)));
}

// A slow pulse in [0.4, 1] for glows that invite a drop; steady at 1 under reduced motion. At
// 0.8 Hz a whole number of periods fits the clock's hour, so the wrap is seamless.
fn pulse() -> f32 {
  if (display(DISPLAY_REDUCED)) { return 1.0; }
  return 0.7 + 0.3 * cos(u.time * 5.0265482);
}
