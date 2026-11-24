// Strokes: antialiased segments of a path, with dashes and flowing comets, in CSS
// pixels. Where a path runs on through a segment's end, the segment draws only its own side of the
// joint there, so a path draws as one stroke.

import package::lib::bind::{frame, eye};
import package::lib::mark::{coverage, fringe};
import package::lib::types::FLOW_UNITS;
import package::lib::color::{to_linear, luminance, contrast};

// The least contrast a comet keeps with its stroke, as WCAG measures it: its minimum for graphics.
// A comet whose color has less takes a rim of the background color, `COMET_RIM` CSS pixels wide,
// ahead of its head, which parts it from the line.
const COMET_CONTRAST: f32 = 3.0;
const COMET_RIM: f32 = 1.0;

struct Stroke {
    a: vec2f,
    b: vec2f,
    // Distance along the whole line at `a` and at `b`, in CSS pixels, so dashes and comets continue
    // across segments.
    phase: vec2f,
    // The same distances in position units, measured along the line's own points. Comets spaced in
    // position units use them.
    along: vec2f,
    width: f32,
    color: vec4f,
    // Comet speed (negative runs backward, 0 for none), and how far the row's comets have traveled.
    flow: f32,
    travel: f32,
    dash: bool,
    // The normals of the lines splitting the pixels at `a` and at `b` with the segments beyond, and
    // whether it shares each end that way (see `Joints` in `lib/path.wesl`).
    split: vec4f,
    shares: vec2<bool>,
    // Whether its comets take a rim (see `COMET_CONTRAST`).
    rim: bool,
}

// Whether comets on a stroke of color `line` (straight) take a rim: the flow color contrasts too
// little with it.
fn rims(line: vec3f) -> bool {
    return contrast(luminance(to_linear(frame.flow.rgb)), luminance(to_linear(line))) < COMET_CONTRAST;
}

// Whether segment `s` draws its line at pixel `p`. Past an end it shares, the segment beyond draws
// it. A pixel on a split line belongs to the later segment.
fn owns(p: vec2f, s: Stroke) -> bool {
    let start = !s.shares.x | (dot(p - s.a, s.split.xy) >= 0.0);
    let end = !s.shares.y | (dot(p - s.b, s.split.zw) < 0.0);
    return start & end;
}

// For pixel `p`: (distance outside the stroke's edge, distance along the line, fraction of the way
// from `a` to `b`).
fn stroke_distance(p: vec2f, s: Stroke) -> vec3f {
    let ab = s.b - s.a;
    let squared = dot(ab, ab);
    let projected = dot(p - s.a, ab);
    let t = clamp(projected / max(squared, 1e-6), 0.0, 1.0);
    let d = length(p - (s.a + ab * t)) - 0.5 * s.width;
    // A solid stroke only needs distance. Avoid the second division and phase interpolation
    // for every covered pixel when neither dashes nor comets consume them.
    if !s.dash && s.flow == 0.0 { return vec3f(d, 0.0, 0.0); }
    let along = clamp(projected / max(squared, 1e-12), 0.0, 1.0);
    return vec3f(d, mix(s.phase.x, s.phase.y, along), along);
}

// Whether the pixel at `d` (from `stroke_distance`) falls in a gap between stroke `s`'s dashes.
fn gap(d: vec3f, s: Stroke) -> bool {
    return s.dash && fract(d.y / max(frame.dash, 1.0)) < 0.5;
}

// Coverage of the pixel at `d` (from `stroke_distance`) by stroke `s`'s line, with its dashes.
fn covered(d: vec3f, s: Stroke) -> f32 {
    return select(line_coverage(d, s), 0.0, gap(d, s));
}

// Coverage of the pixel at `d` by stroke `s`'s line, without its dashes. A line thinner than a
// target pixel covers as a line one pixel wide does, at its width's share: pixels along it, which
// lie at every distance from its middle up to half a pixel diagonally, then sum to one brightness.
// At its own width it would cover only pixels near its middle, and look dotted.
fn line_coverage(d: vec3f, s: Stroke) -> f32 {
    let thin = s.width * eye.pixel_ratio;
    if thin >= 1.0 {
        return coverage(d.x);
    }
    return thin * coverage(d.x + 0.5 * (s.width - fringe()));
}

// Coverage of the pixel at `d` by comets (x), and by their rims (y). Comets are
// `frame.flow_spacing` apart, offset by stroke `s`'s travel. Each has a round head
// `frame.flow_width` wide (at least the stroke's width), brightest at its middle, and a tail
// `frame.flow_length` long that thins and fades. A rim rings the front of the head. A stub too
// short for a comet carries none.
fn comet(d: vec3f, s: Stroke) -> vec2f {
    if s.flow == 0.0 || frame.flow.a <= 0.0 {
        return vec2f(0.0);
    }
    // The pixel's distance along the line in the comet unit, and CSS pixels per comet unit: CSS
    // pixels, or position units (`FLOW_UNITS`).
    var along = d.y;
    var px = 1.0;
    if frame.flow_unit == FLOW_UNITS {
        along = mix(s.along.x, s.along.y, d.z);
        px = length(s.b - s.a) / max(abs(s.along.y - s.along.x), 1e-12);
    }
    let spacing = max(frame.flow_spacing, 1e-6);
    // How far the pixel is ahead of the comet head behind it, in the direction comets run, and how
    // far it is behind the head in front of it.
    let lead = fract(sign(s.flow) * (along - s.travel) / spacing) * spacing;
    let trail = spacing - lead;
    let across = d.x + 0.5 * s.width;
    let cap = lead < trail;
    let fade = select(saturate(1.0 - trail / max(frame.flow_length, 1e-6)), 1.0, cap);
    let reach = 0.5 * max(frame.flow_width, s.width) * mix(0.4, 1.0, fade);
    let distance = select(across, length(vec2f(lead * px, across)), cap);
    let head = 1.0 - smoothstep(0.35 * reach, reach, distance);
    let rim = saturate(1.0 - smoothstep(reach, reach + COMET_RIM, distance) - head);
    return fade * fade * vec2f(head, select(0.0, rim, s.rim & cap));
}

// Which part of a segment comets cover this frame, as fractions of it from `a` to `b` (x and y), and
// whether any does (z), as `comet` draws them. The segment runs from `c.x` to `c.y` along its path,
// in the comet unit, at `px` CSS pixels a unit. Comet heads stand `flow_spacing` apart from where a
// row's comets have traveled, `travel`, each with a tail `flow_length` behind it, in the direction
// `flow` runs, and a head reaching `front` CSS pixels ahead. Neither reaches past half the spacing.
fn comets_on(c: vec2f, px: f32, travel: f32, flow: f32, front: f32) -> vec3f {
    let reach = comet_reach(px, flow, front);
    let spacing = max(frame.flow_spacing, 1e-6);
    let low = min(c.x, c.y);
    let high = max(c.x, c.y);
    let first = ceil((low - reach.y - travel) / spacing);
    let last = floor((high + reach.x - travel) / spacing);
    return covering(c, vec2f(travel + first * spacing - reach.x, travel + last * spacing + reach.y), first <= last);
}

// The part of a segment that comet `k` of those reaching its part `visible` (fractions of it from `a`
// to `b`) covers this frame, as `comets_on` gives a part, for the comets draw's quad of one comet
// slot (see `raster/comets.wesl`). Covers none when fewer comets reach that part.
fn comet_on(c: vec2f, px: f32, travel: f32, flow: f32, front: f32, visible: vec2f, k: u32) -> vec3f {
    let reach = comet_reach(px, flow, front);
    let spacing = max(frame.flow_spacing, 1e-6);
    let shown = c.x + (c.y - c.x) * visible;
    let first = ceil((min(shown.x, shown.y) - reach.y - travel) / spacing) + f32(k);
    let last = floor((max(shown.x, shown.y) + reach.x - travel) / spacing);
    let head = travel + first * spacing;
    return covering(c, vec2f(head - reach.x, head + reach.y), first <= last);
}

// How far a comet reaches below its head along its path (x) and above it (y), in the comet unit at
// `px` CSS pixels a unit: its tail behind it, in the direction `flow` runs, and its head `front` CSS
// pixels ahead. Neither reaches past half the spacing.
fn comet_reach(px: f32, flow: f32, front: f32) -> vec2f {
    let spacing = max(frame.flow_spacing, 1e-6);
    let tail = min(frame.flow_length, 0.5 * spacing);
    let ahead = min(front / max(px, 1e-12), 0.5 * spacing);
    return select(vec2f(tail, ahead), vec2f(ahead, tail), flow <= 0.0);
}

// The part `span` of a segment running from `c.x` to `c.y` covers, within it, as fractions of it
// from `a` to `b` (x and y), and whether it covers any (z).
fn covering(c: vec2f, span: vec2f, any: bool) -> vec3f {
    let covered = vec2f(max(min(c.x, c.y), span.x), min(max(c.x, c.y), span.y));
    let length = c.y - c.x;
    let t = (covered - c.x) / select(length, 1e-12, abs(length) < 1e-12);
    return vec3f(min(t.x, t.y), max(t.x, t.y), select(0.0, 1.0, any));
}

// Premultiplied color of stroke `s` at the pixel at `d`: its line, where `line` says, then any rim
// over it in the background color, and the comets over both, where `comets` says. Rows paint the
// line, and the comets draw the comets. The lit draw paints both.
fn stroke_paint(d: vec3f, s: Stroke, line: bool, comets: bool) -> vec4f {
    var paint = select(vec4f(0.0), vec4f(s.color.rgb, 1.0) * (s.color.a * covered(d, s)), line);
    if !comets || s.flow == 0.0 || frame.flow.a <= 0.0 {
        return paint;
    }
    let c = comet(d, s) * (frame.flow.a * s.color.a);
    paint = vec4f(frame.background.rgb, 1.0) * c.y + paint * (1.0 - c.y);
    return vec4f(frame.flow.rgb, 1.0) * c.x + paint * (1.0 - c.x);
}

// Preserve the straight-color path's attenuation at vanishing alpha without dividing each RGB
// component and immediately multiplying it back for blending.
fn painted(color: vec4f) -> vec4f {
    return vec4f(color.rgb * min(color.a * 1e6, 1.0), color.a);
}
