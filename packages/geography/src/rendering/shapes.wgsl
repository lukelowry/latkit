/** What a draw of one record's shapes reads beside its buffers. */
struct Draw {
  /** The type's color and style, for rows its records leave unset. */
  color: vec4f,
  /** Width, shade, whether shown (1) and dashed (2), and how fast its comets move. */
  style: vec4f,
  /** Whether rows read records, whether through a map to their values' rows, the hovered row, and whether any row is selected. */
  flags: vec4u,
  /** The strip entries the draw's level holds. */
  info: vec4u,
}
/** Per vertex its x and y relative to its row's origin, and its row: three words. */
@group(1) @binding(0) var<storage, read> vertices: array<u32>;
/** Per row its origin, split: high longitude and latitude, then the low parts. */
@group(1) @binding(1) var<storage, read> origins: array<vec4f>;
/** Per values row its color, then its width, shade, whether shown (1) and dashed (2), and flow. */
@group(1) @binding(2) var<storage, read> records: array<vec4f>;
/** Per row its values row, or NONE. */
@group(1) @binding(3) var<storage, read> rowMap: array<u32>;
/** A bit per row: whether it is selected. */
@group(1) @binding(4) var<storage, read> selection: array<u32>;
@group(1) @binding(5) var<storage, read> strips: array<u32>;
@group(1) @binding(6) var<storage, read> along: array<f32>;
@group(1) @binding(7) var<uniform> draw: Draw;

struct Look {
  color: vec4f,
  width: f32,
  shade: f32,
  visible: bool,
  dash: bool,
  /** How far comets move along the line each second, in CSS pixels; 0 draws none. */
  flow: f32,
  /** 0, hovered 1, or selected 2. */
  focus: u32,
}
fn rowOf(v: u32) -> u32 { return vertices[v * 3u + 2u]; }
/** Where a vertex lies relative to the camera center. */
fn relativeOf(v: u32) -> vec2f {
  let local = vec2f(bitcast<f32>(vertices[v * 3u]), bitcast<f32>(vertices[v * 3u + 1u]));
  return projection_relative(origins[rowOf(v)], local, scene.projection);
}
/** How a row draws: its record's values, or the type's, and how it is focused. */
fn lookOf(row: u32) -> Look {
  var look: Look;
  look.color = draw.color;
  look.width = draw.style.x;
  look.shade = draw.style.y;
  var flags = u32(draw.style.z);
  look.flow = draw.style.w;
  if (draw.flags.x == 1u) {
    var r = row;
    if (draw.flags.y == 1u) { r = rowMap[row]; }
    if (r != NONE) {
      let a = records[r * 2u];
      let b = records[r * 2u + 1u];
      look.color = a;
      look.width = b.x;
      look.shade = b.y;
      flags = u32(b.z);
      look.flow = b.w;
    }
  }
  look.visible = (flags & 1u) != 0u;
  look.dash = (flags & 2u) != 0u;
  look.focus = 0u;
  if (draw.flags.w == 1u && (selection[row >> 5u] & (1u << (row & 31u))) != 0u) { look.focus = 2u; }
  else if (row == draw.flags.z) { look.focus = 1u; }
  return look;
}
/** A focused row's color: tinted by hover or the selection; the rest fade while anything is selected. */
fn focused(look: Look, strength: f32) -> vec4f {
  var color = look.color;
  if (look.focus == 2u) {
    if (u.selected.a >= 0.0) { color = vec4f(mix(color.rgb, u.selected.rgb, u.selected.a * strength), max(color.a, u.selected.a * strength)); }
    else { color = vec4f(min(color.rgb * 1.25 + 0.08, vec3f(1.0)), color.a); }
  } else if (look.focus == 1u) {
    color = vec4f(mix(color.rgb, u.hover.rgb, u.hover.a * strength), max(color.a, u.hover.a * strength));
  } else if (draw.flags.w == 1u) { color.a *= u.glow.z; }
  return color;
}

struct Fill {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) facing: f32,
  @location(2) shade: f32,
}
const HIDDEN = vec4f(2.0, 2.0, 2.0, 1.0);
/** Areas: indexed triangles, each vertex at its row's origin plus its offset. */
@vertex fn area_vertex(@builtin(vertex_index) v: u32) -> Fill {
  var out: Fill;
  let row = rowOf(v);
  let look = lookOf(row);
  if (!look.visible) { out.position = HIDDEN; return out; }
  let relative = relativeOf(v);
  let world = projection_world(relative, 0.0, scene.projection);
  out.position = projection_clip(world, scene.projection);
  let color = focused(look, 1.0);
  out.color = vec4f(color.rgb * lightAt(relative), color.a);
  out.facing = facingOf(world);
  out.shade = look.shade;
  return out;
}
@fragment fn area_fragment(v: Fill) -> @location(0) vec4f {
  if (v.facing < 0.0) { discard; }
  let px = v.position.xy / scene.projection.view.z;
  return premultiplied(shade(ShadeFragment(v.color, px, v.shade)));
}

struct Stroke {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  /** Across the stroke in CSS pixels from its middle, and half its width. */
  @location(1) across: vec2f,
  /** Along the stroke in CSS pixels, for dashes. */
  @location(2) along: f32,
  @location(3) facing: f32,
  @location(4) shade: f32,
  @location(5) @interpolate(flat) dash: u32,
  /** Its comets: their speed, how far they have moved, and their heads' radius, in CSS pixels. */
  @location(6) @interpolate(flat) flow: vec3f,
  @location(7) @interpolate(flat) row: u32,
}
/** A vertex's clip position. */
fn clipOf(v: u32) -> vec4f {
  return projection_clip(projection_world(relativeOf(v), 0.0, scene.projection), scene.projection);
}
/** A clip position in CSS pixels from the canvas center. */
fn pixels(c: vec4f) -> vec2f { return c.xy / max(c.w, 0.000001) * 0.5 * scene.projection.view.xy; }
/**
 * Lines: joined triangle strips, two vertices per point, restarting where a strip breaks, so
 * translucent lines never darken where their segments meet. A break's two vertices repeat its
 * neighbors', which draws nothing between strips.
 */
@vertex fn line_vertex(@builtin(vertex_index) index: u32) -> Stroke {
  var out: Stroke;
  var k = index >> 1u;
  var side = f32(index & 1u) * 2.0 - 1.0;
  let count = draw.info.x;
  if (strips[k] == NONE) {
    if (side < 0.0 && k > 0u) { k -= 1u; side = 1.0; }
    else if (k + 1u < count) { k += 1u; side = -1.0; }
    else { out.position = HIDDEN; return out; }
    if (strips[k] == NONE) { out.position = HIDDEN; return out; }
  }
  let v = strips[k];
  let row = rowOf(v);
  let look = lookOf(row);
  if (!look.visible) { out.position = HIDDEN; return out; }
  let relative = relativeOf(v);
  let world = projection_world(relative, 0.0, scene.projection);
  let c = projection_clip(world, scene.projection);
  if (c.w <= 0.0) { out.position = HIDDEN; return out; }
  let p = pixels(c);
  var tangent = vec2f(0.0);
  var normal = vec2f(0.0);
  var stretch = 1.0;
  var before = NONE;
  if (k > 0u) { before = strips[k - 1u]; }
  var after = NONE;
  if (k + 1u < count) { after = strips[k + 1u]; }
  var a = vec2f(0.0);
  var b = vec2f(0.0);
  var has = 0u;
  if (before != NONE) {
    let cb = clipOf(before);
    if (cb.w > 0.0) { let d = p - pixels(cb); if (dot(d, d) > 0.0) { a = normalize(d); has |= 1u; } }
  }
  if (after != NONE) {
    let ca = clipOf(after);
    if (ca.w > 0.0) { let d = pixels(ca) - p; if (dot(d, d) > 0.0) { b = normalize(d); has |= 2u; } }
  }
  if (has == 3u) {
    let n0 = vec2f(-a.y, a.x);
    let n1 = vec2f(-b.y, b.x);
    let m = n0 + n1;
    if (dot(m, m) < 0.0001) { normal = n0; }
    else {
      normal = normalize(m);
      // A miter, held to four times the half width at sharp turns.
      stretch = 1.0 / max(dot(normal, n0), 0.25);
    }
  } else if (has == 1u) { normal = vec2f(-a.y, a.x); }
  else if (has == 2u) { normal = vec2f(-b.y, b.x); }
  var width = look.width;
  if (look.focus != 0u) { width += 2.0; }
  let half = max(width * 0.5, 0.5);
  // A pixel beyond the stroke on each side, which the fragment fades for antialiasing, and as far
  // as a flowing line's comets' heads.
  let head = max(half * 1.6, 2.0);
  let flowing = look.flow != 0.0 && u.motion.x > 0.0;
  let reach = select(half, max(half, head), flowing) + 1.0;
  let offset = normal * side * reach * stretch;
  out.position = vec4f(c.xy + offset * 2.0 / scene.projection.view.xy * c.w, c.z, c.w);
  out.across = vec2f(side * reach, half);
  let latitude = relative.y + scene.projection.center.y;
  let stretched = select(1.0, 1.0 / max(cos(latitude * DEGREE), 0.01), scene.projection.geo.w > 1.5);
  out.along = along[k] * projection_pixels(scene.projection) * stretched;
  var color = focused(look, 1.0);
  // Strokes thinner than a pixel draw a pixel wide, fainter.
  color.a *= min(width, 1.0);
  out.color = vec4f(color.rgb * lightAt(relative), color.a);
  out.facing = facingOf(world);
  out.shade = look.shade;
  out.dash = select(0u, 1u, look.dash);
  let spacing = max(u.motion.x, 1.0);
  let moved = look.flow * u.motion.y;
  out.flow = vec3f(select(0.0, look.flow, flowing), moved - spacing * floor(moved / spacing), head);
  out.row = row;
  return out;
}
@fragment fn line_fragment(v: Stroke) -> @location(0) vec4f {
  if (v.facing < 0.0) { discard; }
  if (v.dash == 1u && !stroke_dash(v.along, u.glow.w)) { discard; }
  let line = clamp(v.across.y + 0.5 - abs(v.across.x), 0.0, 1.0);
  // Derivatives read in uniform control flow, before any branch on the row.
  let aa = max(fwidth(v.across.x), 0.01);
  var comets = 0.0;
  if (v.flow.x != 0.0) {
    comets = stroke_comet(v.along, v.across.x, v.row, v.flow.x, v.flow.y, v.flow.z, u.motion.x, aa) * u.flow.a;
  }
  // The line and its comets, in its shade.
  let color = vec4f(mix(v.color.rgb, u.flow.rgb, comets), mix(v.color.a, 1.0, comets));
  let px = v.position.xy / scene.projection.view.z;
  return outputColor(shade(ShadeFragment(color, px, v.shade)), max(line, comets));
}
