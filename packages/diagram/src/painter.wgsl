// Blocks, groups, wires, ports, labels, and the grid of a diagram, from one instance buffer.
// The kind constants come first, from `KIND` in painter.ts.
struct View {
  /** The page's origin from the camera center, and pixels per diagram unit. */
  camera: vec4f,
  /** Canvas size in CSS pixels, pixel ratio, and time in milliseconds. */
  viewport: vec4f,
  /** Grid pitch, grid shown, motion, and the text size of the page. */
  grid: vec4f,
  selected: vec4f,
  hovered: vec4f,
  dots: vec4f,
  /** Outline, selection, and hover widths in pixels; 1 keeps an item's own color selected. */
  metrics: vec4f,
  background: vec4f,
  /** Detail fades, the grid's least spacing, port size, and the default edge width. */
  detail: vec4f,
  /** What scales each slot's offset on each axis, the wires' opacity, and whether only wires draw. */
  motion: vec4f,
  /** Junctions shown, then the first port, edge, and group slots; below the first port, blocks. */
  slots: vec4f,
  vertexColor: vec4f,
  edgeColor: vec4f,
  outline: vec4f,
  group: vec4f,
}
struct Item { a: vec4f, b: vec4f, kind: u32, slot: u32, unused: vec2u }
struct Style { color: vec4f, status: vec4f, width: f32, flow: f32, shade: f32 }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(2) var<storage, read> items: array<Item>;
@group(0) @binding(3) var<storage, read> focus: array<u32>;
/** Each label's anchor, as a text bank writes it: its origin, and the slot of the item it labels. */
@group(0) @binding(4) var<storage, read> anchors: array<vec4f>;
@group(0) @binding(5) var<storage, read> styles: array<vec4u>;
/** Each slot's offset, which `motion` scales: (1, 1) where a drag moves, or from minus to. */
@group(0) @binding(6) var<storage, read> offsets: array<vec2f>;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) index: u32,
  @location(2) @interpolate(flat) size: vec4f,
  @location(3) color: vec4f,
}
fn screen(p: vec2f) -> vec2f { return (p + view.camera.xy) * view.camera.zw + view.viewport.xy * 0.5; }
fn clip(p: vec2f) -> vec4f { return vec4f(p / view.viewport.xy * vec2f(2., -2.) + vec2f(-1., 1.), 0., 1.); }
fn corner(v: u32) -> vec2f {
  return array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1))[v];
}
/** Coverage of an edge `d` CSS pixels away, over one device pixel. */
fn aa(d: f32) -> f32 { return clamp(0.5 - d * view.viewport.z, 0., 1.); }
fn scale() -> f32 { return abs(view.camera.z); }
fn flagsOf(slot: u32) -> u32 { if (slot >= arrayLength(&focus)) { return 0u; } return focus[slot]; }
/** A slot's style; a zero color is the view's base color for the kind. */
fn styleOf(slot: u32, kind: u32) -> Style {
  var s = vec4u(0u, 0u, 0xbc00u, 0u);
  if (slot < arrayLength(&styles)) { s = styles[slot]; }
  let wf = unpack2x16float(s.z);
  var color = unpack4x8unorm(s.x);
  if (s.x == 0u) { color = select(view.edgeColor, view.vertexColor, kind == BLOCK); }
  return Style(color, unpack4x8unorm(s.y), select(view.detail.w, wf.x, wf.x >= 0.), wf.y, bitcast<f32>(s.w));
}
fn chosen(color: vec4f) -> vec4f { return select(view.selected, color, view.metrics.w != 0.); }
/** How far a fading mark shows at a size in pixels; detail 'full' always shows it. */
fn fold(px: f32) -> f32 { return select(1., smoothstep(1., 3., px), view.detail.x != 0.); }
/** Where an item draws from its place: following a drag, or easing in from where it was. */
fn shifted(slot: u32) -> vec2f {
  if (slot >= arrayLength(&offsets)) { return vec2f(0.); }
  return offsets[slot] * view.motion.xy;
}
fn wired(k: u32) -> bool { return k == SEGMENT || k == CORNER || k == ARROW || k == JUNCTION; }
fn hidden(i: u32) -> Out { return Out(vec4f(2., 2., 2., 1.), vec2f(0.), i, vec4f(0.), vec4f(0.)); }
/** The rim selection and hover draw past a shape, in pixels. */
fn rim() -> f32 { return max(6., max(view.metrics.y, view.metrics.z) + 2.); }
@vertex fn shape_vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let item = items[i];
  let c = corner(v);
  let flags = flagsOf(item.slot);
  let k = item.kind;
  // Rerouted wires hide while their new ones draw; wires a transition leaves draw alone.
  if ((flags & 128u) != 0u || (view.motion.w != 0. && !wired(k))) { return hidden(i); }
  let offset = shifted(item.slot);
  let pad = rim();
  if (k == SEGMENT || k == PREVIEW) {
    let a = screen(item.a.xy + offset);
    let b = screen(item.a.zw + offset);
    let span = max(distance(a, b), 0.0001);
    let dir = (b - a) / span;
    let half = styleOf(item.slot, k).width * 0.5 + pad;
    let uv = vec2f(mix(-half, span + half, c.x), mix(-half, half, c.y));
    return Out(clip(a + dir * uv.x + vec2f(-dir.y, dir.x) * uv.y), uv, i, vec4f(span, 0., 0., 0.), vec4f(0.));
  }
  if (k == CORNER) {
    let center = screen(item.a.xy + offset);
    let reach = item.a.z * scale() + styleOf(item.slot, k).width * 0.5 + pad;
    let uv = (item.b.xy * c.x + item.b.zw * c.y) * reach;
    return Out(clip(center + uv), uv, i, vec4f(item.a.z * scale(), 0., 0., 0.), vec4f(0.));
  }
  if (k == ARROW) {
    let tip = screen(item.a.xy + offset);
    let dir = item.a.zw;
    let span = view.detail.z * scale();
    let half = span * 0.4;
    let uv = vec2f(mix(-pad, span + pad, c.x), mix(-half - pad, half + pad, c.y));
    return Out(clip(tip - dir * uv.x + vec2f(-dir.y, dir.x) * uv.y), uv, i, vec4f(span, half, 0., 0.), vec4f(0.));
  }
  if (k == PORT || k == JUNCTION) {
    let center = screen(item.a.xy + offset);
    let half = view.detail.z * scale() * select(0.5, 0.32, k == JUNCTION);
    let uv = (c * 2. - 1.) * (half + pad);
    return Out(clip(center + uv), uv, i, vec4f(half, 0., 0., 0.), vec4f(0.));
  }
  // A box: a block, a group, a label, or the marquee.
  let half = item.a.zw * scale() * 0.5;
  let center = screen(item.a.xy + item.a.zw * 0.5 + offset);
  let uv = (c * 2. - 1.) * (half + pad + select(0., 10., k == BLOCK));
  return Out(clip(center + uv), uv, i, vec4f(half, 0., 0.), vec4f(0.));
}
fn box(p: vec2f, half: vec2f, radius: f32) -> f32 {
  let q = abs(p) - half + radius;
  return length(max(q, vec2f(0.))) + min(max(q.x, q.y), 0.) - radius;
}
/** Signed distance in pixels to a block's outline: rounded, rectangle, ellipse, or diamond. */
fn outline(p: vec2f, half: vec2f, radius: f32, shape: u32) -> f32 {
  if (shape == 2u) { return (length(p / max(half, vec2f(0.001))) - 1.) * min(half.x, half.y); }
  if (shape == 3u) { return (dot(abs(p) / max(half, vec2f(0.001)), vec2f(1.)) - 1.) * min(half.x, half.y) * 0.707107; }
  return box(p, half, select(0., radius, shape == 0u));
}
/** Marching dashes along a flowing wire, or still chevrons under reduced motion. */
fn flowing(d: f32, along: f32, across: f32, flow: f32) -> f32 {
  if (flow == 0.) { return d; }
  if (view.grid.z != 0.) {
    if (fract((along - view.viewport.w * flow / 1000.) / 14.) > 0.62) { return 1e3; }
    return d;
  }
  let q = vec2f(fract(along / 18.) * 18. - 9., abs(across));
  return min(d, max(abs(q.y + q.x * 0.65) - 0.8, max(-q.x - 3., q.x - 3.)));
}
@fragment fn shape_fragment(v: Out) -> @location(0) vec4f {
  let item = items[v.index];
  let k = item.kind;
  let flags = flagsOf(item.slot);
  let style = styleOf(item.slot, k);
  let selected = (flags & 1u) != 0u;
  let hovered = (flags & 2u) != 0u;
  let compatible = (flags & 4u) != 0u;
  let targeted = (flags & 8u) != 0u;
  let wire = wired(k);
  var opacity = select(1., 0.22, (flags & 32u) != 0u) * select(1., view.motion.z, wire || k == LABEL);
  var color = style.color;
  var d = 0.;
  var shadow = 0.;
  if (k == SEGMENT || k == CORNER || k == PREVIEW) {
    var along = 0.;
    var across = 0.;
    if (k == CORNER) {
      // A quarter arc owns the pixels its two radii bound; the segments on either side own the
      // rest, so each pixel draws once and a translucent wire never darkens at a bend.
      let toward = dot(v.uv, item.b.xy);
      let onward = dot(v.uv, item.b.zw);
      if (toward <= 0. || onward < 0.) { discard; }
      across = length(v.uv) - v.size.x;
      along = item.a.w * scale() + v.size.x * atan2(onward, toward);
    } else {
      if (v.uv.x < 0. || v.uv.x >= v.size.x) { discard; }
      across = v.uv.y;
      along = item.b.x * scale() + v.uv.x;
    }
    if (k == PREVIEW) {
      color = select(view.selected, vec4f(0.95, 0.3, 0.24, 1.), item.b.y != 0.);
      d = abs(across) - 0.75;
      if (fract((along) / 10.) > 0.6) { discard; }
    } else {
      let extra = select(select(0., 0.5, hovered), 1., selected || targeted);
      d = flowing(abs(across) - style.width * 0.5 - extra, along, across, style.flow);
      if (hovered) { color = mix(color, view.hovered, 0.65); }
      if (selected || targeted) { color = chosen(color); }
    }
  } else if (k == ARROW) {
    let slope = v.size.y / v.size.x;
    d = max((abs(v.uv.y) - v.uv.x * slope) / sqrt(1. + slope * slope), v.uv.x - v.size.x);
    opacity *= fold(v.size.x);
    if (selected || targeted) { color = chosen(color); } else if (hovered) { color = mix(color, view.hovered, 0.65); }
  } else if (k == JUNCTION) {
    d = length(v.uv) - v.size.x;
    opacity *= fold(v.size.x * 2.) * view.slots.x;
    if (selected || targeted) { color = chosen(color); }
  } else if (k == PORT) {
    let half = v.size.x;
    let n = item.a.zw;
    let q = vec2f(dot(v.uv, n), dot(v.uv, vec2f(-n.y, n.x)));
    if (item.b.x == 1.) { d = max(abs(q.y) * 0.894427 + (q.x - half) * 0.447214, -q.x - half); }
    else if (item.b.x == 2.) { d = (abs(v.uv.x) + abs(v.uv.y) - half) * 0.707107; }
    else { d = length(v.uv) - half; }
    // An unwired port is hollow.
    if (item.b.y == 0.) { color = mix(view.background, color, smoothstep(-1.8, -0.8, d)); }
    if (style.status.a > 0.) { color = mix(color, style.status, aa(abs(d - 1.5) - 1.) * style.status.a); }
    opacity *= fold(half * 2.);
  } else {
    let half = v.size.xy;
    if (k == BLOCK) {
      let radius = min(item.b.x * scale(), min(half.x, half.y));
      let shape = u32(item.b.z);
      d = outline(v.uv, half, radius, shape);
      let header = item.b.y * scale();
      if (header > 0. && shape <= 1u) {
        // The title band, and the rule under it.
        if (v.uv.y < header - half.y) { color = mix(color, view.outline, 0.16); }
        color = mix(color, view.outline, aa(abs(v.uv.y - header + half.y) - 0.5) * 0.8);
      }
      color = mix(color, view.outline, 1. - aa(d + view.metrics.x));
      if (style.status.a > 0.) {
        color = mix(color, style.status, aa(abs(d + view.metrics.x + 1.5) - 1.) * style.status.a);
      }
      // A soft shadow below the block, once it is large enough to cast one.
      shadow = 0.16 * (1. - smoothstep(-2., 8., outline(v.uv - vec2f(0., 2.), half, radius, shape))) *
        smoothstep(0.3, 0.6, scale());
      if ((flags & 64u) != 0u) { opacity *= 0.88; }
    } else if (k == GROUP) {
      d = box(v.uv, half, min(item.b.x * scale(), min(half.x, half.y)));
      let header = item.b.y * scale();
      color = view.group;
      if (item.b.z != 0. || v.uv.y < header - half.y) { color.a = min(1., color.a * select(2.2, 4., item.b.z != 0.)); }
      color = mix(color, vec4f(view.outline.rgb, view.outline.a * 0.55), 1. - aa(d + 1.));
    } else if (k == LABEL) {
      d = box(v.uv, half, min(half.y, 6.));
      color = vec4f(view.background.rgb, view.background.a * 0.92);
      if (item.b.x != 0.) { color = mix(color, style.color, 1. - aa(d + 1.)); }
    } else {
      d = box(v.uv, half, 2.);
      color = mix(vec4f(view.selected.rgb, 0.12), view.selected, 1. - aa(d + 1.));
    }
  }
  let shaded = shade(ShadeFragment(color, v.position.xy / view.viewport.z, style.shade));
  var result = outputColor(shaded, aa(d));
  if (shadow > 0.) { result = result + vec4f(0., 0., 0., shadow * (1. - aa(d))) * (1. - result.a); }
  var accent = view.hovered;
  var ring = 0.;
  if (!wire && k != PREVIEW && k != BOX) {
    if (hovered) { ring = 0.35 * (1. - smoothstep(0., view.metrics.z, d)); }
    if (compatible) { accent = chosen(style.color); ring = max(ring, 0.28 * (1. - smoothstep(0., 5., d))); }
    if (selected || targeted) { accent = chosen(style.color); ring = max(ring, aa(d - view.metrics.y) * smoothstep(-0.5, 0.5, d)); }
  } else if (compatible) {
    accent = chosen(style.color);
    ring = 0.28 * (1. - smoothstep(0., 5., d));
  }
  result = result + outputColor(accent, ring) * (1. - result.a);
  return result * opacity;
}
/** A block's title in its own color where that reads on the block's fill, else dark or light. */
fn legible(color: vec4f, slot: u32) -> vec4f {
  if (slot >= u32(view.slots.y)) { return color; }
  let luma = vec3f(0.2126, 0.7152, 0.0722);
  let fill = dot(styleOf(slot, BLOCK).color.rgb, luma);
  if (abs(dot(color.rgb, luma) - fill) >= 0.4) { return color; }
  return vec4f(select(vec3f(0.96), vec3f(0.08), fill > 0.5), color.a);
}
@vertex fn text_vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let t = textVertex(v, i);
  let anchor = latkitAnchor(anchors[t.anchor]);
  let flags = flagsOf(anchor.slot);
  if (!anchor.shown || (flags & 128u) != 0u) { return hidden(i); }
  // A wire's label fades with its wire.
  let wire = anchor.slot >= u32(view.slots.z) && anchor.slot < u32(view.slots.w);
  var color = legible(t.color, anchor.slot);
  color.a *= select(1., view.motion.z, wire);
  return Out(clip(screen(t.position + anchor.position + shifted(anchor.slot))), t.uv, i, vec4f(0.), color);
}
@fragment fn text_fragment(v: Out) -> @location(0) vec4f {
  return textColor(v.uv, v.color, vec4f(0.), 0.) * smoothstep(4., 8., view.grid.w * scale());
}
@vertex fn grid_vertex(@builtin(vertex_index) v: u32) -> Out {
  let p = vec2f(f32((v << 1u) & 2u), f32(v & 2u));
  return Out(vec4f(p * vec2f(2., -2.) + vec2f(-1., 1.), 0., 1.), p * view.viewport.xy, 0u, vec4f(0.), vec4f(0.));
}
fn dots(world: vec2f, pitch: f32) -> f32 {
  let q = abs(fract(world / pitch + 0.5) - 0.5) * pitch * abs(view.camera.zw);
  return 1. - smoothstep(0.4, 1.15, length(q));
}
@fragment fn grid_fragment(v: Out) -> @location(0) vec4f {
  if (view.grid.y == 0.) { discard; }
  let level = max(ceil(log2(view.detail.y / (view.grid.x * scale())) / 2.), 0.);
  let pitch = view.grid.x * exp2(level * 2.);
  let world = (v.uv - view.viewport.xy * 0.5) / view.camera.zw - view.camera.xy;
  let fade = smoothstep(view.detail.y, view.detail.y * 2., pitch * scale());
  return outputColor(view.dots, max(dots(world, pitch) * fade * 0.7, dots(world, pitch * 4.) * 0.7));
}
