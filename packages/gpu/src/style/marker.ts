import { failure } from '@latkit/model';
import { integer } from '../error.js';
import { validateRgba, type RGBA } from '../colors/color.js';
import type { Channel } from './channel.js';

/** An outline: a diagram block's, and the shape a marker fills. */
export type Shape = 'rounded' | 'rectangle' | 'ellipse' | 'diamond';
/** Each shape's code in WGSL, as `shapeDistance` reads it. */
export const SHAPES: readonly Shape[] = ['rounded', 'rectangle', 'ellipse', 'diamond'];
/** An image a marker samples: decoded pixels, or anything a 2D canvas draws. */
export type MarkerImage =
  ImageData | ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement;
/**
 * How each row of a type draws: WGSL defining `fn marker(f: MarkerFragment) -> MarkerColor` in CSS
 * pixels, from the shapes and markers of the shared library, the channels it reads by name, and
 * images it samples. It returns its color, each layer covered as `filled` covers it, and the
 * distance to its outline, which the view's halos and shadows follow.
 */
export interface Marker {
  readonly wgsl: string;
  /**
   * Up to eight numbers a row, each a channel, read in WGSL as `f.<name>`. A transition eases them
   * from what was drawn, except those in `steps`.
   */
  readonly inputs?: Readonly<Record<string, Channel>>;
  /** Inputs that change at once rather than ease, as an image's index does. */
  readonly steps?: readonly string[];
  /** Images `markerImage(index, uv)` samples, each fitted into one square cell of an atlas. */
  readonly images?: readonly MarkerImage[];
}
/** Inputs a marker reads; one uniform slot holds their channels. */
export const MARKER_INPUTS = 8;
/** Images a marker samples: a sixteen by sixteen atlas. */
const MARKER_IMAGES = 256;
const RESERVED = new Set(['p', 'radiusPx', 'color']);
const NAME = /^[a-z][A-Za-z0-9]*$/;

/** Throw unless a marker is one a view can draw. */
export function checkMarker(marker: Marker): void {
  if (typeof marker !== 'object' || marker === null || typeof marker.wgsl !== 'string')
    throw failure('invalid-input', 'Invalid marker');
  if (!/\bfn\s+marker\s*\(/.test(marker.wgsl))
    throw failure('invalid-input', 'A marker defines fn marker(f: MarkerFragment) -> MarkerColor');
  const names = Object.keys(marker.inputs ?? {});
  if (names.length > MARKER_INPUTS)
    throw failure('invalid-input', `A marker reads at most ${MARKER_INPUTS} inputs`);
  for (const name of names)
    if (!NAME.test(name) || RESERVED.has(name))
      throw failure('invalid-input', 'Invalid marker input name: ' + name);
  if (
    marker.steps !== undefined &&
    (!Array.isArray(marker.steps) ||
      (marker.steps as readonly unknown[]).some(
        (name) => typeof name !== 'string' || !names.includes(name),
      ))
  )
    throw failure('invalid-input', 'A marker steps only its own inputs');
  if (marker.images !== undefined) {
    if (!Array.isArray(marker.images) || marker.images.length > MARKER_IMAGES)
      throw failure('invalid-input', `A marker samples at most ${MARKER_IMAGES} images`);
    for (const image of marker.images as readonly Partial<MarkerImage>[])
      if (!(Number(image?.width) > 0) || !(Number(image?.height) > 0))
        throw failure('invalid-input', 'Invalid marker image');
  }
}
/** A number as a WGSL float literal. */
function float(value: number, name: string): string {
  if (!Number.isFinite(value)) throw failure('invalid-input', 'Invalid ' + name);
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
/** A shape's WGSL code. */
function code(name: Shape): string {
  const at = SHAPES.indexOf(name);
  if (at < 0) throw failure('invalid-input', 'Invalid shape: ' + String(name));
  return at + 'u';
}
const color = (rgba: RGBA) =>
  `vec4f(${rgba.map((v, i) => float(v, 'color component ' + i)).join(', ')})`;

/** A shape in the row's color: what a vertex draws by default as an ellipse, a disc. */
export function shape(name: Shape = 'ellipse'): Marker {
  return {
    wgsl: `fn marker(f: MarkerFragment) -> MarkerColor {
  return filled(f.color, shapeDistance(${code(name)}, f.p, vec2f(f.radiusPx), f.radiusPx * 0.25));
}`,
  };
}
/**
 * A fraction of a whole: a ring of the row's color, a gap, and `fill` of the shape inside, a wedge
 * clockwise from 12 o'clock in an ellipse, a bar from the bottom otherwise. What it leaves open shows
 * what lies below, as a pie's hole does.
 */
export function gauge(options: {
  readonly fill: Channel;
  readonly shape?: Shape;
  /** The ring's width, in CSS pixels. */
  readonly ringPx?: number;
  /** The gap inside the ring, in CSS pixels. */
  readonly gapPx?: number;
}): Marker {
  const ring = options.ringPx ?? 2,
    gap = options.gapPx ?? 1;
  if (!(ring >= 0) || !(gap >= 0)) throw failure('invalid-input', 'Invalid gauge ring');
  return {
    inputs: { fill: options.fill },
    wgsl: `fn marker(f: MarkerFragment) -> MarkerColor {
  return gaugeMarker(f, ${code(options.shape ?? 'ellipse')}, f.fill, ${float(ring, 'ringPx')}, ${float(gap, 'gapPx')});
}`,
  };
}
/** Slices of a whole, clockwise from 12 o'clock: `slices[i]` of their sum in `colors[i]`. */
export function pie(options: {
  readonly slices: readonly Channel[];
  readonly colors: readonly RGBA[];
  /** The open middle, a fraction of the radius: a ring chart above zero. */
  readonly hole?: number;
}): Marker {
  const { slices, colors } = options,
    hole = options.hole ?? 0;
  if (!slices.length || slices.length > MARKER_INPUTS || colors.length !== slices.length)
    throw failure('invalid-input', `A pie takes one to ${MARKER_INPUTS} slices, a color each`);
  for (const rgba of colors) validateRgba(rgba);
  if (!(hole >= 0 && hole < 1)) throw failure('invalid-input', 'Invalid pie hole');
  const names = slices.map((_, i) => 's' + i),
    pad = <T>(values: T[], fill: T) => [
      ...values,
      ...Array<T>(MARKER_INPUTS - values.length).fill(fill),
    ];
  return {
    inputs: Object.fromEntries(names.map((name, i) => [name, slices[i]])),
    wgsl: `fn marker(f: MarkerFragment) -> MarkerColor {
  return pieMarker(
    f,
    array<f32, ${MARKER_INPUTS}>(${pad(
      names.map((name) => 'f.' + name),
      '0.0',
    ).join(', ')}),
    array<vec4f, ${MARKER_INPUTS}>(${pad(colors.map(color), 'vec4f(0.0)').join(', ')}),
    ${names.length}u,
    ${float(hole, 'hole')},
  );
}`,
  };
}
/** The image `image` picks from `images`, over the row's color in `shape`. */
export function icon(options: {
  readonly images: readonly MarkerImage[];
  readonly image: Channel;
  readonly shape?: Shape;
}): Marker {
  return {
    images: options.images,
    inputs: { image: options.image },
    steps: ['image'],
    wgsl: `fn marker(f: MarkerFragment) -> MarkerColor {
  let back = filled(f.color, shapeDistance(${code(options.shape ?? 'ellipse')}, f.p, vec2f(f.radiusPx), f.radiusPx * 0.25));
  return over(filled(markerImage(f.image, f.p / f.radiusPx), back.distance), back);
}`,
  };
}

/**
 * Signed distances to every \`Shape\`, negative inside, in the units of \`p\`, about a box of half size
 * \`half\`: \`shapeDistance\` by code, \`SHAPE_ROUNDED\` through \`SHAPE_DIAMOND\`, rounding corners by
 * \`radius\`. And the views' one soft shadow, and \`turns\`, clockwise from 12 o'clock with y up.
 */
export function shapeShader(): string {
  return `
const SHAPE_ROUNDED: u32 = 0u;
const SHAPE_RECTANGLE: u32 = 1u;
const SHAPE_ELLIPSE: u32 = 2u;
const SHAPE_DIAMOND: u32 = 3u;
fn ellipseDistance(p: vec2f, half: vec2f) -> f32 {
  return (length(p / max(half, vec2f(0.001))) - 1.0) * min(half.x, half.y);
}
fn rectangleDistance(p: vec2f, half: vec2f, radius: f32) -> f32 {
  let q = abs(p) - half + radius;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}
fn diamondDistance(p: vec2f, half: vec2f) -> f32 {
  return (dot(abs(p) / max(half, vec2f(0.001)), vec2f(1.0)) - 1.0) * min(half.x, half.y) * 0.707107;
}
fn shapeDistance(shape: u32, p: vec2f, half: vec2f, radius: f32) -> f32 {
  if (shape == SHAPE_ELLIPSE) { return ellipseDistance(p, half); }
  if (shape == SHAPE_DIAMOND) { return diamondDistance(p, half); }
  return rectangleDistance(p, half, select(0.0, min(radius, min(half.x, half.y)), shape == SHAPE_ROUNDED));
}
/** The soft shadow a shape casts, from its distance where the shadow falls: 2 px below it. */
fn shadowAlpha(d: f32) -> f32 { return 0.16 * (1.0 - smoothstep(-2.0, 8.0, d)); }
fn turns(p: vec2f) -> f32 { return fract(atan2(p.x, p.y) / 6.283185307); }
`;
}
/**
 * The WGSL a marker draws with: its fragment and inputs, the shared shapes and markers, its images,
 * and its own \`marker\`. It begins a module: a view puts it first, and binds the atlas at \`binding\`
 * and its sampler after it.
 */
export function markerShader(
  marker: Marker,
  options: { readonly group: number; readonly binding: number; readonly columns: number },
): string {
  checkMarker(marker);
  const names = Object.keys(marker.inputs ?? {}),
    group = integer(options.group, 'marker group', 0, 3),
    binding = integer(options.binding, 'marker binding', 0, 998),
    lane = (i: number) => `${i < 4 ? 'a' : 'b'}.${'xyzw'[i % 4]}`;
  return `diagnostic(off, derivative_uniformity);
/**
 * One pixel of a row's marker: where, in CSS pixels from its center with y up, its radius, its
 * color, and what the row reads.
 */
struct MarkerFragment {
  p: vec2f,
  radiusPx: f32,
  color: vec4f,
${names.map((name) => `  ${name}: f32,`).join('\n')}
}
/**
 * What a marker draws at a pixel: its color, with what of the pixel it covers in its alpha, and how
 * far outside its outline, in CSS pixels. Holes inside the outline are in the alpha alone.
 */
struct MarkerColor { color: vec4f, distance: f32 }
fn markerFragment(p: vec2f, radiusPx: f32, color: vec4f, a: vec4f, b: vec4f) -> MarkerFragment {
  return MarkerFragment(p, radiusPx, color${names.map((_, i) => ', ' + lane(i)).join('')});
}
@group(${group}) @binding(${binding}) var markerAtlas: texture_2d<f32>;
@group(${group}) @binding(${binding + 1}) var markerSampler: sampler;
const MARKER_COLUMNS: f32 = ${float(Math.max(1, options.columns), 'columns')};
const MARKER_IMAGES: f32 = ${float(marker.images?.length ?? 0, 'images')};
${shapeShader()}
/** How much of a pixel a shape covers, from its distance. */
fn coverage(d: f32) -> f32 { return clamp(0.5 - d / max(fwidth(d), 0.000001), 0.0, 1.0); }
/** \`color\` where the shape \`d\` outlines covers the pixel, antialiased at its edge. */
fn filled(color: vec4f, d: f32) -> MarkerColor {
  return MarkerColor(vec4f(color.rgb, color.a * coverage(d)), d);
}
/** \`top\` over \`bottom\`, outlined by both. */
fn over(top: MarkerColor, bottom: MarkerColor) -> MarkerColor {
  let a = top.color.a;
  let alpha = a + bottom.color.a * (1.0 - a);
  let rgb = (top.color.rgb * a + bottom.color.rgb * bottom.color.a * (1.0 - a)) / max(alpha, 0.000001);
  return MarkerColor(vec4f(rgb, alpha), min(top.distance, bottom.distance));
}
/**
 * Signed distance to the sector from 12 o'clock clockwise through \`fraction\` of a turn, of any
 * radius: its two edges, so a wedge's cut is as smooth as its rim.
 */
fn sectorDistance(p: vec2f, fraction: f32) -> f32 {
  if (fraction >= 1.0) { return -1e6; }
  if (fraction <= 0.0) { return 1e6; }
  let half = fraction * 3.141592654;
  let c = vec2f(sin(half), cos(half));
  var q = vec2f(p.x * c.y - p.y * c.x, p.x * c.x + p.y * c.y);
  q.x = abs(q.x);
  return length(q - c * max(dot(q, c), 0.0)) * sign(c.y * q.x - c.x * q.y);
}
/** Image \`index\` across the marker, \`uv\` from (-1, -1) to (1, 1), filtered over the pixel. */
fn markerImage(index: f32, uv: vec2f) -> vec4f {
  let local = vec2f(uv.x, -uv.y) * 0.5 + 0.5;
  if (MARKER_IMAGES < 1.0 || any(local < vec2f(0.0)) || any(local > vec2f(1.0))) { return vec4f(0.0); }
  let i = clamp(round(index), 0.0, max(MARKER_IMAGES, 1.0) - 1.0);
  let origin = vec2f(i % MARKER_COLUMNS, floor(i / MARKER_COLUMNS)) / MARKER_COLUMNS;
  let texel = 0.5 / vec2f(textureDimensions(markerAtlas));
  let low = origin + texel;
  let high = origin + 1.0 / MARKER_COLUMNS - texel;
  let at = origin + local / MARKER_COLUMNS;
  let dx = dpdx(at);
  let dy = dpdy(at);
  var taps = array<vec2f, 4>(vec2f(-0.125, -0.375), vec2f(0.375, -0.125), vec2f(0.125, 0.375), vec2f(-0.375, 0.125));
  var sum = vec4f(0.0);
  for (var k = 0u; k < 4u; k++) {
    sum += textureSampleLevel(markerAtlas, markerSampler, clamp(at + dx * taps[k].x + dy * taps[k].y, low, high), 0.0);
  }
  sum *= 0.25;
  return vec4f(sum.rgb / max(sum.a, 0.000001), sum.a);
}
/**
 * A ring of the row's color \`ringPx\` wide, an open \`gapPx\` gap, and \`fill\` of the shape inside:
 * a wedge clockwise from 12 o'clock in an ellipse, a bar from the bottom otherwise. Its outline is
 * the ring's outer edge.
 */
fn gaugeMarker(f: MarkerFragment, shape: u32, fill: f32, ringPx: f32, gapPx: f32) -> MarkerColor {
  let r = f.radiusPx;
  let outline = shapeDistance(shape, f.p, vec2f(r), r * 0.25);
  let within = r - ringPx;
  let ring = filled(f.color, max(outline, -shapeDistance(shape, f.p, vec2f(within), within * 0.25)));
  let inner = within - gapPx;
  let part = clamp(fill, 0.0, 1.0);
  let share = select(
    f.p.y - (2.0 * part - 1.0) * inner,
    sectorDistance(f.p, part),
    shape == SHAPE_ELLIPSE,
  );
  let core = filled(f.color, max(shapeDistance(shape, f.p, vec2f(inner), inner * 0.25), share));
  return MarkerColor(over(core, ring).color, outline);
}
/**
 * Slices clockwise from 12 o'clock, each \`slices[i]\` of their sum, in \`colors[i]\`, open in the
 * middle \`hole\` of the radius. Its outline is the rim.
 */
fn pieMarker(f: MarkerFragment, slices: array<f32, ${MARKER_INPUTS}>, colors: array<vec4f, ${MARKER_INPUTS}>, count: u32, hole: f32) -> MarkerColor {
  var s = slices;
  var c = colors;
  var total = 0.0;
  for (var i = 0u; i < count; i++) { total += max(s[i], 0.0); }
  let r = length(f.p);
  let outline = r - f.radiusPx;
  let cover = coverage(max(outline, hole * f.radiusPx - r));
  if (total <= 0.0) { return MarkerColor(vec4f(0.0), outline); }
  let along = turns(f.p);
  var start = 0.0;
  for (var i = 0u; i < count; i++) {
    let end = start + max(s[i], 0.0) / total;
    if (along < end || i + 1u == count) {
      // A pixel at a slice's edge takes half its neighbor's color, as the rim does.
      var after = (i + 1u) % count;
      for (var k = 0u; k < count && s[after] <= 0.0; k++) { after = (after + 1u) % count; }
      var before = (i + count - 1u) % count;
      for (var k = 0u; k < count && s[before] <= 0.0; k++) { before = (before + count - 1u) % count; }
      let next = c[after];
      let previous = c[before];
      let toEnd = (end - along) * 6.283185307 * r;
      let toStart = (along - start) * 6.283185307 * r;
      var color = c[i];
      color = mix(next, color, clamp(0.5 + toEnd, 0.0, 1.0));
      color = mix(previous, color, clamp(0.5 + toStart, 0.0, 1.0));
      return MarkerColor(vec4f(color.rgb, color.a * cover), outline);
    }
    start = end;
  }
  return MarkerColor(vec4f(c[0].rgb, c[0].a * cover), outline);
}
${marker.wgsl}
`;
}

/** Pixels a marker image holds: decoded already, or drawn once into a canvas. */
function pixelsOf(image: MarkerImage): {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
} {
  if ('data' in image) return image;
  const canvas = new OffscreenCanvas(image.width, image.height),
    context = canvas.getContext('2d');
  if (!context) throw failure('unsupported', 'Marker images require a 2D canvas');
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height);
}
/**
 * A marker's images in one atlas of square cells: each image fitted into its cell, centered,
 * averaged over the source pixels each cell pixel covers, with its color premultiplied.
 */
export function markerAtlas(
  images: readonly MarkerImage[],
  cell = 64,
): {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly columns: number;
} {
  const columns = Math.max(1, Math.ceil(Math.sqrt(images.length))),
    rows = Math.max(1, Math.ceil(images.length / columns)),
    width = columns * cell,
    height = rows * cell,
    data = new Uint8Array(width * height * 4);
  images.forEach((image, i) => {
    const source = pixelsOf(image),
      fit = cell / Math.max(source.width, source.height),
      w = Math.max(1, Math.round(source.width * fit)),
      h = Math.max(1, Math.round(source.height * fit)),
      left = (i % columns) * cell + ((cell - w) >> 1),
      top = Math.floor(i / columns) * cell + ((cell - h) >> 1);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // The source pixels this one covers, at least one.
        const x0 = Math.floor((x * source.width) / w),
          x1 = Math.max(x0 + 1, Math.floor(((x + 1) * source.width) / w)),
          y0 = Math.floor((y * source.height) / h),
          y1 = Math.max(y0 + 1, Math.floor(((y + 1) * source.height) / h));
        let r = 0,
          g = 0,
          b = 0,
          a = 0;
        for (let sy = y0; sy < y1; sy++)
          for (let sx = x0; sx < x1; sx++) {
            const at = (sy * source.width + sx) * 4,
              alpha = source.data[at + 3] / 255;
            r += source.data[at] * alpha;
            g += source.data[at + 1] * alpha;
            b += source.data[at + 2] * alpha;
            a += alpha;
          }
        const n = (x1 - x0) * (y1 - y0),
          out = ((top + y) * width + left + x) * 4;
        data[out] = Math.round(r / n);
        data[out + 1] = Math.round(g / n);
        data[out + 2] = Math.round(b / n);
        data[out + 3] = Math.round((a / n) * 255);
      }
  });
  return { data, width, height, columns };
}
