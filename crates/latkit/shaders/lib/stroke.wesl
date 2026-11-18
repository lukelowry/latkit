// Strokes: antialiased segments of a path, with dashes, flowing comets, and arrowheads, in CSS
// pixels. Where a path runs on through a segment's end, the segment draws only its own side of the
// joint there, so a path draws as one stroke.

import package::lib::bind::frame;
import package::lib::mark::coverage;
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
    // Whether the segment ends in an arrowhead at `b`.
    arrow: bool,
    // The normals of the lines splitting the pixels at `a` and at `b` with the segments beyond, and
    // whether it shares each end that way (see `Joints` in `lib/path.wesl`).
    split: vec4f,
    shares: vec2<bool>,
    // Whether its comets take a rim (see `COMET_CONTRAST`).
    rim: bool,
    // How far past `b` along its path the tip of its row's arrowhead lies, in CSS pixels: 0 on the
    // segment ending in it, and negative where comets keep clear of none.
    tip: f32,
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

// Signed distance to the arrowhead at `b`, a triangle `frame.arrow + width` long along `dir`.
fn head_distance(p: vec2f, b: vec2f, dir: vec2f, width: f32) -> f32 {
    let length = frame.arrow + width;
    let q = p - b;
    let along = dot(q, dir);
    let across = abs(dot(q, vec2f(-dir.y, dir.x)));
    let half = 0.5 * length * 0.9;
    // Inside where it lies behind the tip and within the widening flanks.
    let slope = half / length;
    let flank = (across - (-along) * slope) / sqrt(1.0 + slope * slope);
    return max(max(flank, along), -along - length);
}

// For pixel `p`: (distance outside the stroke's edge, distance along the line, fraction of the way
// from `a` to `b`).
fn stroke_distance(p: vec2f, s: Stroke) -> vec3f {
    let ab = s.b - s.a;
    if !s.arrow {
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
    let len = length(ab);
    let dir = ab / max(len, 1e-6);
    // An arrowhead's stroke stops where the head begins.
    let end = select(s.b, s.b - dir * (frame.arrow + s.width) * 0.8, s.arrow && len > frame.arrow);
    let ae = end - s.a;
    let t = clamp(dot(p - s.a, ae) / max(dot(ae, ae), 1e-6), 0.0, 1.0);
    let line = length(p - (s.a + ae * t)) - 0.5 * s.width;
    // The head is drawn whole: its base can reach back past a joint, where the segment before draws
    // the line.
    let head = head_distance(p, s.b, dir, s.width);
    let d = select(head, min(line, head), owns(p, s));
    let along = clamp(dot(p - s.a, dir) / max(len, 1e-6), 0.0, 1.0);
    return vec3f(d, mix(s.phase.x, s.phase.y, along), along);
}

// Whether the pixel at `d` (from `stroke_distance`) falls in a gap between stroke `s`'s dashes.
fn gap(d: vec3f, s: Stroke) -> bool {
    return s.dash && fract(d.y / max(frame.dash, 1.0)) < 0.5;
}

// Coverage of the pixel at `d` (from `stroke_distance`) by stroke `s`'s line, with its dashes.
fn covered(d: vec3f, s: Stroke) -> f32 {
    return select(coverage(d.x), 0.0, gap(d, s));
}

// Coverage of the pixel at `d` by comets (x), and by their rims (y). Comets are
// `frame.flow_spacing` apart, offset by stroke `s`'s travel. Each has a round head
// `frame.flow_width` wide (at least the stroke's width), brightest at its middle, and a tail
// `frame.flow_length` long that thins and fades. A rim rings the front of the head. A comet never
// covers an arrowhead: on every segment of a row ending in one, a comet fades out before its part
// nearest the arrowhead (its head's front, or its tail where comets run away from the arrowhead)
// reaches where the head begins. A stub too short for a comet carries none.
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
    var clear = 1.0;
    if s.tip >= 0.0 {
        // Where this pixel's comet has its head, in CSS pixels from `a`: behind the pixel by `lead`
        // in the direction comets run, or ahead of it by `trail`. It reaches toward the arrowhead
        // by its head's front, or where comets run away from the arrowhead, by its tail.
        let len = length(s.b - s.a);
        let head_at = d.z * len - select(-trail, lead, cap) * px * sign(s.flow);
        let radius = 0.5 * max(frame.flow_width, s.width);
        let reach = head_at + select(radius, frame.flow_length * px, s.flow < 0.0) + COMET_RIM;
        let base = len + s.tip - frame.arrow - s.width;
        clear = saturate((base - reach) / radius);
    }
    return fade * fade * clear * vec2f(head, select(0.0, rim, s.rim & cap));
}

// Premultiplied color of stroke `s` at the pixel at `d`: its line, where `line` says, then any rim
// over it in the background color, and the comets over both, where `comets` says. Rows paint both,
// except in a frame that draws comets apart, in a draw of their own.
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
