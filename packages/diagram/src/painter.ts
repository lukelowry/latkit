import { kit, type Gpu, type RGBA } from '@latkit/gpu';
import type { DiagramData, DiagramItem, Point } from './data.js';
import { itemKey } from './data.js';
import type { Scene, Rect, Vertex, Wire } from './scene.js';
import { intersects, itemSlots } from './scene.js';
import type { Style } from './config.js';
import type { DragDraw } from './drag.js';
import { labelBox } from './geometry.js';
import { Styles, styleShader, type StyleFrame } from './styles.js';

/** What each instance draws; the shader branches on it. */
const KIND = {
  block: 0,
  group: 1,
  segment: 2,
  corner: 3,
  arrow: 4,
  port: 5,
  junction: 6,
  label: 7,
  box: 8,
  preview: 9,
} as const;
/** Words per instance: two vec4s of geometry, its kind, and its slot. */
const WORDS = 12;
/** Instances per bank: a bank's own origin keeps its float32 positions precise. */
const BANK = 16384;
/** No item: overlay and preview instances, which no focus or style reaches. */
const NONE = 0xffffffff;
const SHAPES = ['rounded', 'rectangle', 'ellipse', 'diamond'] as const;
interface Bank {
  bounds: Rect;
  origin: Point;
  data: kit.BufferData;
  count: number;
}
interface Geometry {
  banks: Bank[];
  text: readonly kit.TextBankPage[];
  focus: kit.BufferData;
  /** Each slot's flags, as last written. */
  states: Map<number, number>;
}
export interface Pipelines {
  shapes: GPURenderPipeline;
  text: GPURenderPipeline;
  grid: GPURenderPipeline;
  styles: GPUComputePipeline;
  layout: GPUBindGroupLayout;
  styleLayout: GPUBindGroupLayout;
}
export interface Overlay {
  readonly box?: readonly [number, number, number, number];
  readonly wire?: readonly Point[];
  readonly compatible?: readonly DiagramItem[];
  readonly target?: DiagramItem | null;
  readonly muted?: string;
  readonly invalid?: boolean;
}
/** What one frame draws. */
export interface DrawState {
  readonly scene: Scene;
  readonly data: DiagramData;
  readonly style: Style;
  readonly camera: kit.Camera2D;
  /** Replaced whenever it changes. */
  readonly selection: readonly DiagramItem[];
  readonly hover: DiagramItem | null;
  readonly pipelines: Pipelines;
  /** The shade's uniforms for this frame. */
  readonly shade: GPUBufferBinding;
  readonly overlay: Overlay | null;
  /** A drag drawn over the scene: what it moves, how far, and its rerouted wires. */
  readonly drag: DragDraw | null;
  /** Flow animates; false under reduced motion. */
  readonly motion: boolean;
}
export interface Paint {
  pipelines: Pipelines;
  restyle: StyleFrame;
  banks: { group: GPUBindGroup; count: number }[];
  text: { group: GPUBindGroup; pages: readonly kit.TextPage[] }[];
  grid: GPUBindGroup;
  msaa?: GPUTextureView;
  background: RGBA;
  drawCalls: number;
}
const kinds = Object.entries(KIND)
  .map(([name, value]) => `const ${name.toUpperCase()}: u32 = ${value}u;`)
  .join('\n');
const shader = /* wgsl */ `
${kinds}
struct View {
  /** The bank's origin from the camera center, and pixels per diagram unit. */
  camera: vec4f,
  /** Canvas size in CSS pixels, pixel ratio, and time in milliseconds. */
  viewport: vec4f,
  /** Grid pitch, grid shown, motion, and the text size of the bank. */
  grid: vec4f,
  selected: vec4f,
  hovered: vec4f,
  dots: vec4f,
  /** Outline, selection, and hover widths in pixels; 1 keeps an item's own color selected. */
  metrics: vec4f,
  background: vec4f,
  /** Detail fades, the grid's least spacing, port size, and the default edge width. */
  detail: vec4f,
  /** A drag's offset in diagram units, junctions shown, and the first port slot: below it, blocks. */
  drag: vec4f,
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
/** Coverage of an edge \`d\` CSS pixels away, over one device pixel. */
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
/** Moving items follow the drag; rerouted ones hide while their new wires draw. */
fn dragged(flags: u32) -> vec2f { return select(vec2f(0.), view.drag.xy, (flags & 64u) != 0u); }
fn hidden(i: u32) -> Out { return Out(vec4f(2., 2., 2., 1.), vec2f(0.), i, vec4f(0.), vec4f(0.)); }
/** The rim selection and hover draw past a shape, in pixels. */
fn rim() -> f32 { return max(6., max(view.metrics.y, view.metrics.z) + 2.); }
@vertex fn shape_vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let item = items[i];
  let c = corner(v);
  let flags = flagsOf(item.slot);
  if ((flags & 128u) != 0u) { return hidden(i); }
  let offset = dragged(flags);
  let k = item.kind;
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
  let wire = k == SEGMENT || k == CORNER || k == ARROW || k == JUNCTION;
  var opacity = select(1., 0.22, (flags & 32u) != 0u);
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
    opacity *= fold(v.size.x * 2.) * view.drag.z;
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
  if (slot >= u32(view.drag.w)) { return color; }
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
  return Out(clip(screen(t.position + anchor.position + dragged(flags))), t.uv, i, vec4f(0.), legible(t.color, anchor.slot));
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
`;
/** A buffer holding `values`, writing only what changed since `previous` held. */
function sync(values: Uint32Array, label: string, previous?: kit.BufferData): kit.BufferData {
  if (!previous) {
    const created = new kit.BufferData({ size: Math.max(4, values.byteLength), label });
    if (values.length) created.write({ data: values });
    return created;
  }
  previous.resize(Math.max(4, values.byteLength));
  const before = new Uint32Array(previous.bytes.buffer, previous.bytes.byteOffset, values.length);
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    if (i < values.length && before[i] !== values[i]) {
      if (start < 0) start = i;
      before[i] = values[i];
    } else if (start >= 0) {
      previous.touch({ offset: start * 4, size: (i - start) * 4 });
      start = -1;
    }
  }
  return previous;
}
/** Instances written straight into typed storage, a bank at a time. */
class Banks {
  readonly banks: Bank[] = [];
  private readonly f = new Float32Array(WORDS * BANK);
  private readonly u = new Uint32Array(this.f.buffer);
  private used = 0;
  private origin: Point = [0, 0];
  private bounds = [Infinity, Infinity, -Infinity, -Infinity];
  constructor(
    private readonly label: string,
    private readonly previous?: readonly Bank[],
  ) {}
  /**
   * An instance: `a` and `b` in diagram units, its first point (and a segment's second) made
   * relative to the bank's origin, and the box it covers for culling.
   */
  push(kind: number, slot: number, a: readonly number[], b: readonly number[], box: Rect): void {
    if (this.used === BANK) this.flush();
    if (!this.used) this.origin = this.previous?.[this.banks.length]?.origin ?? [a[0], a[1]];
    const at = this.used++ * WORDS,
      [ox, oy] = this.origin,
      two = kind === KIND.segment || kind === KIND.preview;
    this.f[at] = a[0] - ox;
    this.f[at + 1] = a[1] - oy;
    this.f[at + 2] = two ? a[2] - ox : a[2];
    this.f[at + 3] = two ? a[3] - oy : a[3];
    this.f[at + 4] = b[0] ?? 0;
    this.f[at + 5] = b[1] ?? 0;
    this.f[at + 6] = b[2] ?? 0;
    this.f[at + 7] = b[3] ?? 0;
    this.u[at + 8] = kind;
    this.u[at + 9] = slot;
    const r = this.bounds;
    r[0] = Math.min(r[0], box[0]);
    r[1] = Math.min(r[1], box[1]);
    r[2] = Math.max(r[2], box[2]);
    r[3] = Math.max(r[3], box[3]);
  }
  flush(): Bank[] {
    if (this.used) {
      const index = this.banks.length;
      this.banks.push({
        origin: this.origin,
        bounds: this.bounds as unknown as Rect,
        data: sync(this.u.subarray(0, this.used * WORDS), this.label, this.previous?.[index]?.data),
        count: this.used,
      });
      this.used = 0;
      this.bounds = [Infinity, Infinity, -Infinity, -Infinity];
    }
    return this.banks;
  }
}
/** A wire's instances: segments that end where their bends' arcs begin, arrows, and junctions. */
function wire(banks: Banks, slot: number, drawn: Wire, radius: number): void {
  drawn.paths.forEach((path, p) => {
    let along = drawn.offsets[p] ?? 0,
      from = path[0];
    const segment = (a: Point, b: Point) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length > 1e-9)
        banks.push(
          KIND.segment,
          slot,
          [a[0], a[1], b[0], b[1]],
          [along],
          [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
        );
      along += length;
    };
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[i - 1],
        b = path[i],
        c = path[i + 1],
        ab = Math.hypot(b[0] - a[0], b[1] - a[1]),
        bc = Math.hypot(c[0] - b[0], c[1] - b[1]),
        r = Math.min(radius, ab / 2, bc / 2);
      if (!(r > 1e-6)) continue;
      const into: Point = [(b[0] - a[0]) / ab, (b[1] - a[1]) / ab],
        onward: Point = [(c[0] - b[0]) / bc, (c[1] - b[1]) / bc],
        enter: Point = [b[0] - into[0] * r, b[1] - into[1] * r],
        leave: Point = [b[0] + onward[0] * r, b[1] + onward[1] * r];
      segment(from, enter);
      const center: Point = [enter[0] + leave[0] - b[0], enter[1] + leave[1] - b[1]];
      banks.push(
        KIND.corner,
        slot,
        [center[0], center[1], r, along],
        [-onward[0], -onward[1], into[0], into[1]],
        [center[0] - r, center[1] - r, center[0] + r, center[1] + r],
      );
      along += (r * Math.PI) / 2;
      from = leave;
    }
    segment(from, path[path.length - 1]);
  });
  for (const { point: p, direction: d } of drawn.arrows)
    banks.push(KIND.arrow, slot, [p[0], p[1], d[0], d[1]], [], [p[0], p[1], p[0], p[1]]);
  for (const p of drawn.junctions)
    banks.push(KIND.junction, slot, [p[0], p[1], 0, 0], [], [p[0], p[1], p[0], p[1]]);
}
/** Where a vertex's title sits: centered by its capitals in its band, or on the vertex. */
function titleAt(vertex: Vertex, style: Style): Point {
  const x = vertex.x + vertex.width / 2;
  if (vertex.options.labelPosition !== 'header')
    return kit.textOrigin(vertex.label, [x, vertex.y + vertex.height / 2], 'center', 'middle');
  const top = vertex.ports.some((p) => p.side === 'top') ? style.portFontSize * 1.5 : 0,
    inset =
      vertex.shape === 'diamond'
        ? vertex.height / 4
        : vertex.shape === 'ellipse'
          ? (vertex.height * (1 - Math.SQRT1_2)) / 2
          : 0;
  return kit.textOrigin(
    vertex.label,
    [x, vertex.y + inset + top + (vertex.header - top) / 2],
    'center',
    'middle',
  );
}
/** Where a port's name sits: inside its vertex, a marker's half and a gap from the port. */
function portNameAt(vertex: Vertex, port: Vertex['ports'][number], style: Style): Point {
  const label = port.label,
    [x, y] = port.position,
    gap = style.portSize / 2 + 4,
    slant =
      vertex.shape === 'diamond'
        ? ((label.width + gap * 2) * vertex.height) / (2 * vertex.width)
        : 0;
  return port.side === 'left'
    ? kit.textOrigin(label, [x + gap, y], 'start', 'middle')
    : port.side === 'right'
      ? kit.textOrigin(label, [x - gap, y], 'end', 'middle')
      : port.side === 'top'
        ? kit.textOrigin(label, [x, y + gap + slant], 'center', 'top')
        : kit.textOrigin(label, [x, y - gap - slant], 'center', 'bottom');
}
/** Build the pipelines for one target format, MSAA, and shade; the view caches each variant. */
export async function pipelines(
  gpu: Gpu,
  format: GPUTextureFormat,
  msaa: 1 | 4,
  shade: string,
): Promise<Pipelines> {
  const d = gpu.device,
    V = GPUShaderStage.VERTEX,
    F = GPUShaderStage.FRAGMENT;
  const layout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: F, buffer: { type: 'uniform' } },
      { binding: 2, visibility: V | F, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: V | F, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: V, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: V | F, buffer: { type: 'read-only-storage' } },
    ],
  });
  const styleLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const [module, compute] = await Promise.all([
    gpu.shaderModule(
      kit.shadeShader({ group: 0, binding: 1 }) +
        kit.textShader({ group: 1 }) +
        kit.outputShader() +
        shader +
        shade,
      'diagram',
    ),
    gpu.shaderModule(kit.fieldShader({ group: 0, colormap: 2 }) + styleShader, 'diagram styles'),
  ]);
  const pipe = (vertex: string, fragment: string, text = false) =>
    gpu.renderPipeline({
      layout: d.createPipelineLayout({
        bindGroupLayouts: text ? [layout, gpu.textLayout] : [layout],
      }),
      vertex: { module, entryPoint: vertex },
      fragment: {
        module,
        entryPoint: fragment,
        targets: [{ format, blend: kit.premultipliedBlend }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: msaa },
    });
  const [shapes, text, grid, styles] = await Promise.all([
    pipe('shape_vertex', 'shape_fragment'),
    pipe('text_vertex', 'text_fragment', true),
    pipe('grid_vertex', 'grid_fragment'),
    gpu.computePipeline({
      layout: d.createPipelineLayout({
        bindGroupLayouts: [gpu.fieldLayout, styleLayout, gpu.colormapLayout],
      }),
      compute: { module: compute, entryPoint: 'style_main' },
    }),
  ]);
  return { shapes, text, grid, styles, layout, styleLayout };
}
export class Painter {
  private focused?: {
    readonly geometry: Geometry;
    readonly selection: readonly DiagramItem[];
    readonly hover: DiagramItem | null;
    readonly overlay: Overlay | null;
    readonly drag: DragDraw['marks'] | null;
  };
  private readonly attachments: kit.Attachments;
  private readonly styles: Styles;
  private readonly empty = new kit.BufferData({ size: 16, label: 'diagram empty' });
  private gesture?: readonly Bank[];
  private dragged?: readonly Bank[];
  /** Every label, by the slot it names: a scene that keeps its text only moves anchors. */
  private readonly text = new kit.TextBank('diagram text', true);
  /** The labels of rerouted wires a drag draws. */
  private readonly dragText = new kit.TextBank('diagram drag text', true);
  constructor(private readonly gpu: Gpu) {
    this.attachments = new kit.Attachments(gpu);
    this.styles = new Styles(gpu);
  }
  private build(scene: Scene, style: Style, previous?: Geometry): Geometry {
    const banks = new Banks('diagram instances', previous?.banks),
      text = this.text;
    text.hide();
    scene.groups.forEach((group, i) => {
      const b = group.bounds;
      if (b[0] === b[2]) return;
      banks.push(
        KIND.group,
        scene.slots.groups + i,
        [b[0], b[1], b[2] - b[0], b[3] - b[1]],
        [style.cornerRadius, group.header, +group.collapsed],
        b,
      );
      const slot = scene.slots.groups + i;
      text.add(
        slot,
        group.label,
        kit.textOrigin(
          group.label,
          [b[0] + style.vertexPadding, b[1] + group.header / 2],
          'start',
          'middle',
        ),
        slot,
      );
    });
    scene.edges.forEach((edge, i) => {
      if (edge.visible && edge.paths.length)
        wire(banks, scene.slots.edges + i, edge, style.cornerRadius);
    });
    scene.edges.forEach((edge, i) => {
      if (!edge.visible || !edge.paths.length || !style.labels) return;
      const slot = scene.slots.edges + i;
      edge.labels.forEach((at, k) => {
        const b = labelBox(edge, at);
        banks.push(
          KIND.label,
          slot,
          [b[0], b[1], b[2] - b[0], b[3] - b[1]],
          [+(edge.options.appearance === 'tag')],
          b,
        );
        text.add(slot + ':' + k, edge.label, at, slot);
      });
    });
    scene.vertices.forEach((vertex, i) => {
      if (!vertex.visible) return;
      const box: Rect = [vertex.x, vertex.y, vertex.x + vertex.width, vertex.y + vertex.height];
      banks.push(
        KIND.block,
        i,
        [vertex.x, vertex.y, vertex.width, vertex.height],
        [vertex.radius, vertex.header, SHAPES.indexOf(vertex.shape)],
        box,
      );
      text.add(i, vertex.label, titleAt(vertex, style), i);
      vertex.ports.forEach((port, k) => {
        const p = port.position,
          slot = vertex.portSlot + k,
          sign = port.direction === 'in' ? -1 : 1;
        banks.push(
          KIND.port,
          slot,
          [p[0], p[1], port.normal[0] * sign, port.normal[1] * sign],
          [
            port.marker === 'diamond'
              ? 2
              : port.marker === 'directional' && port.direction !== undefined
                ? 1
                : 0,
            +port.connected,
          ],
          [p[0], p[1], p[0], p[1]],
        );
        // A port's name sits on its block: it follows the block's drag and reads on its fill.
        text.add(slot, port.label, portNameAt(vertex, port, style), i);
      });
    });
    const reuse = previous?.focus.size === Math.max(4, scene.slots.count * 4);
    return {
      banks: banks.flush(),
      text: text.flush(),
      focus: reuse
        ? previous.focus
        : new kit.BufferData({ size: Math.max(4, scene.slots.count * 4), label: 'diagram focus' }),
      states: reuse ? previous.states : new Map<number, number>(),
    };
  }
  async prepare(frame: kit.Preparation, state: DrawState): Promise<Paint> {
    const { scene, style, camera, pipelines, shade: effect, overlay } = state;
    // A scene's instances and labels, built once; a new scene writes only what changed.
    const geometry = await frame.memo('geometry', [scene], (_, previous: Geometry | undefined) =>
      this.build(scene, style, previous),
    );
    this.focus(scene, geometry, state);
    const restyle = await this.styles.prepare(frame, scene, state.data, pipelines.styleLayout),
      { styles } = restyle,
      focus = frame.buffer(geometry.focus),
      empty = frame.buffer(this.empty),
      accent = style.selectedColor ?? style.hoverColor;
    const group = (
      origin: Point,
      data: GPUBufferBinding,
      anchors = empty,
      textSize = 0,
      flags = focus,
    ) =>
      this.gpu.device.createBindGroup({
        layout: pipelines.layout,
        entries: [
          {
            binding: 0,
            resource: frame.uniforms(
              Float32Array.of(
                origin[0] - camera.center[0],
                origin[1] - camera.center[1],
                camera.scale[0],
                camera.scale[1] * (camera.yDirection === 'down' ? 1 : -1),
                frame.viewport.width,
                frame.viewport.height,
                frame.viewport.pixelRatio,
                frame.timeMs,
                style.gridPitch,
                +style.grid,
                +state.motion,
                textSize,
                ...accent,
                ...style.hoverColor,
                ...style.gridColor,
                style.outlineWidthPx,
                style.selectedWidthPx,
                style.hoverWidthPx,
                +(style.selectedColor === null),
                ...style.background,
                +(style.detail === 'auto'),
                style.gridMinSpacingPx,
                style.portSize,
                style.edgeWidthPx,
                ...(state.drag?.delta ?? [0, 0]),
                +style.junctions,
                scene.slots.ports,
                ...style.vertexBaseColor,
                ...style.edgeBaseColor,
                ...style.outlineColor,
                ...style.groupColor,
              ),
            ),
          },
          { binding: 1, resource: effect },
          { binding: 2, resource: data },
          { binding: 3, resource: flags },
          { binding: 4, resource: anchors },
          { binding: 5, resource: styles },
        ],
      });
    // Culling keeps the rims, shadows, and markers of what lies just off the canvas.
    const reach = 16 + style.portSize * camera.scale[0],
      dx = (frame.viewport.width / 2 + reach) / camera.scale[0],
      dy = (frame.viewport.height / 2 + reach) / camera.scale[1],
      visible: Rect = [
        camera.center[0] - dx,
        camera.center[1] - dy,
        camera.center[0] + dx,
        camera.center[1] + dy,
      ];
    const banks: Paint['banks'] = [],
      text: Paint['text'] = [];
    const draw = (list: readonly Bank[], flags = focus) => {
      for (const bank of list)
        if (intersects(bank.bounds, visible))
          banks.push({
            group: group(bank.origin, frame.buffer(bank.data), empty, 0, flags),
            count: bank.count,
          });
    };
    const write = async (list: readonly kit.TextBankPage[], flags = focus) => {
      for (const bank of list)
        if (intersects(bank.bounds, visible) && bank.maxSize * camera.scale[0] >= 3)
          text.push({
            group: group(
              bank.origin,
              frame.buffer(this.empty),
              frame.buffer(bank.anchors),
              bank.maxSize,
              flags,
            ),
            pages: await frame.text({ runs: bank.runs }),
          });
    };
    draw(geometry.banks);
    await write(geometry.text);
    if (state.drag?.wires.length) {
      // Rerouted wires draw as they will be, past the focus that hides their old routes.
      const moving = new Banks('diagram drag', this.dragged),
        named = this.dragText;
      named.hide();
      for (const dragged of state.drag.wires) {
        wire(moving, dragged.slot, dragged, style.cornerRadius);
        dragged.labels.forEach((at, k) => {
          const b = labelBox(dragged.edge, at);
          moving.push(KIND.label, dragged.slot, [b[0], b[1], b[2] - b[0], b[3] - b[1]], [], b);
          named.add(dragged.slot + ':' + k, dragged.edge.label, at, dragged.slot);
        });
      }
      this.dragged = moving.flush();
      draw(this.dragged, empty);
      await write(named.flush(), empty);
    }
    if (overlay?.box || overlay?.wire) {
      const gesture = new Banks('diagram gesture', this.gesture);
      if (overlay.box) {
        const b = overlay.box;
        gesture.push(KIND.box, NONE, [b[0], b[1], b[2] - b[0], b[3] - b[1]], [], b);
      }
      let along = 0;
      for (let i = 1; i < (overlay.wire?.length ?? 0); i++) {
        const a = overlay.wire![i - 1],
          b = overlay.wire![i];
        gesture.push(
          KIND.preview,
          NONE,
          [a[0], a[1], b[0], b[1]],
          [along, +!!overlay.invalid],
          [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
        );
        along += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      this.gesture = gesture.flush();
      draw(this.gesture, empty);
    }
    const msaa = this.attachments.prepare(frame, { msaa: style.msaa }).color;
    const level = Math.max(
      0,
      Math.ceil(
        Math.log(Math.max(1, style.gridMinSpacingPx / (style.gridPitch * camera.scale[0]))) /
          Math.log(4),
      ),
    );
    const period = style.gridPitch * 4 ** (level + 1);
    return {
      pipelines,
      restyle,
      banks,
      text,
      grid: group(
        [
          Math.floor(camera.center[0] / period) * period,
          Math.floor(camera.center[1] / period) * period,
        ],
        empty,
      ),
      msaa,
      background: style.background,
      drawCalls: 1 + banks.length + text.reduce((n, b) => n + b.pages.length, 0),
    };
  }
  encode(frame: kit.Encoding, paint: Paint): void {
    this.styles.encode(frame.encoder, paint.pipelines.styles, paint.restyle);
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: paint.msaa ?? frame.target,
          resolveTarget: paint.msaa ? frame.target : undefined,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: kit.clearColor(paint.background),
        },
      ],
    });
    pass.setPipeline(paint.pipelines.grid);
    pass.setBindGroup(0, paint.grid);
    pass.draw(3);
    pass.setPipeline(paint.pipelines.shapes);
    for (const bank of paint.banks) {
      pass.setBindGroup(0, bank.group);
      pass.draw(6, bank.count);
    }
    pass.setPipeline(paint.pipelines.text);
    for (const bank of paint.text) {
      pass.setBindGroup(0, bank.group);
      for (const page of bank.pages) {
        pass.setBindGroup(1, page.bindGroup);
        pass.draw(6, page.count);
      }
    }
    pass.end();
  }
  /** Write each slot's selection, hover, and gesture flags where they changed. */
  private focus(scene: Scene, geometry: Geometry, state: DrawState): void {
    const { selection, hover, overlay } = state,
      drag = state.drag?.marks ?? null,
      last = this.focused;
    if (
      last?.geometry === geometry &&
      last.selection === selection &&
      last.hover === hover &&
      last.overlay === overlay &&
      last.drag === drag
    )
      return;
    this.focused = { geometry, selection, hover, overlay, drag };
    const slots = itemSlots(scene),
      states = new Map<number, number>();
    const flag = (slot: number | undefined, bit: number) => {
      if (slot !== undefined) states.set(slot, (states.get(slot) ?? 0) | bit);
    };
    for (const item of selection) flag(slots.get(itemKey(item)), 1);
    if (hover && !overlay?.wire) flag(slots.get(itemKey(hover)), 2);
    for (const item of overlay?.compatible ?? []) flag(slots.get(itemKey(item)), 4);
    if (overlay?.target) flag(slots.get(itemKey(overlay.target)), 8);
    if (overlay?.muted) flag(slots.get(overlay.muted), 32);
    for (const slot of drag?.moving ?? []) flag(slot, 64);
    for (const slot of drag?.rerouted ?? []) flag(slot, 128);
    const words = new Uint32Array(
      geometry.focus.bytes.buffer,
      geometry.focus.bytes.byteOffset,
      geometry.focus.size / 4,
    );
    const write = (slot: number, value: number) => {
      if (slot < words.length && words[slot] !== value) {
        words[slot] = value;
        geometry.focus.touch({ offset: slot * 4, size: 4 });
      }
    };
    for (const slot of geometry.states.keys()) if (!states.has(slot)) write(slot, 0);
    for (const [slot, value] of states) write(slot, value);
    geometry.states = states;
  }
  destroy(): void {
    this.attachments.destroy();
    this.styles.destroy();
    this.focused = undefined;
    this.dragged = undefined;
    this.gesture = undefined;
    this.text.clear();
    this.dragText.clear();
  }
}
