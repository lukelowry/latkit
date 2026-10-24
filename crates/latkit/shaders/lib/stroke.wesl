// Strokes: antialiased segments with dashes, flowing comets, and arrowheads, in CSS pixels.

import package::lib::bind::frame;
import package::lib::mark::coverage;
import package::lib::types::{FLOW_PX, FLOW_UNITS};

struct Stroke {
    a: vec2f,
    b: vec2f,
    // Distance along the whole line at `a` and at `b`, CSS pixels: dashes and comets run on across
    // segments.
    phase: vec2f,
    // The same in length units, as far along as the line's own points: comets drawn in position
    // units run along it.
    along: vec2f,
    width: f32,
    color: vec4f,
    // Comet speed, negative backward, 0 for none; and how far the row's comets traveled.
    flow: f32,
    travel: f32,
    dash: bool,
    // Whether the segment ends in an arrowhead at `b`.
    arrow: bool,
}

// The arrowhead at `b` pointing along `dir`: a triangle `frame.arrow` long, as a signed distance.
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

// (distance outside the stroke's edge, distance along the line, fraction of the way from `a` to `b`)
// for pixel `p`.
fn stroke_distance(p: vec2f, s: Stroke) -> vec3f {
    let ab = s.b - s.a;
    let len = length(ab);
    let dir = ab / max(len, 1e-6);
    // An arrowhead's stroke stops where the head begins.
    let end = select(s.b, s.b - dir * (frame.arrow + s.width) * 0.8, s.arrow && len > frame.arrow);
    let ae = end - s.a;
    let t = clamp(dot(p - s.a, ae) / max(dot(ae, ae), 1e-6), 0.0, 1.0);
    var d = length(p - (s.a + ae * t)) - 0.5 * s.width;
    if s.arrow {
        d = min(d, head_distance(p, s.b, dir, s.width));
    }
    let along = clamp(dot(p - s.a, dir) / max(len, 1e-6), 0.0, 1.0);
    return vec3f(d, mix(s.phase.x, s.phase.y, along), along);
}

// How much of the pixel at `d`, from `stroke_distance`, the line of stroke `s` covers, dashed.
fn covered(d: vec3f, s: Stroke) -> f32 {
    var alpha = coverage(d.x);
    if s.dash {
        alpha *= step(0.5, fract(d.y / max(frame.dash, 1.0)));
    }
    return alpha;
}

// How much of the pixel at `d` a comet covers: comets `frame.flow_spacing` apart, moved on by stroke
// `s`'s travel, each a round head `frame.flow_width` wide, never narrower than the stroke, brightest
// at its middle, trailing a tail `frame.flow_length` long that thins and fades.
fn comet(d: vec3f, s: Stroke) -> f32 {
    if s.flow == 0.0 || frame.flow.a <= 0.0 {
        return 0.0;
    }
    // Where the pixel lies along the line in the comets' lengths, and CSS pixels per length: position
    // units where comets are part of the drawing, CSS pixels where they keep to the screen, else the
    // space's lengths.
    var along = d.y / frame.unit;
    var px = frame.unit;
    if frame.flow_unit == FLOW_UNITS {
        along = mix(s.along.x, s.along.y, d.z);
        px = length(s.b - s.a) / max(abs(s.along.y - s.along.x), 1e-12);
    } else if frame.flow_unit == FLOW_PX {
        along = d.y;
        px = 1.0;
    }
    let spacing = max(frame.flow_spacing, 1e-6);
    // How far the pixel leads the head behind it, the way comets run, and trails the head ahead.
    let lead = fract(sign(s.flow) * (along - s.travel) / spacing) * spacing;
    let trail = spacing - lead;
    let across = d.x + 0.5 * s.width;
    let cap = lead < trail;
    let fade = select(saturate(1.0 - trail / max(frame.flow_length, 1e-6)), 1.0, cap);
    let reach = 0.5 * max(frame.flow_width, s.width) * mix(0.4, 1.0, fade);
    let distance = select(across, length(vec2f(lead * px, across)), cap);
    return fade * fade * (1.0 - smoothstep(0.35 * reach, reach, distance));
}

// Stroke `s` at pixel `p`, comets over its line; a comet fades with its row.
fn stroke(p: vec2f, s: Stroke) -> vec4f {
    let d = stroke_distance(p, s);
    let line = s.color.a * covered(d, s);
    let head = comet(d, s) * frame.flow.a * s.color.a;
    let alpha = head + line * (1.0 - head);
    let color = (frame.flow.rgb * head + s.color.rgb * line * (1.0 - head)) / max(alpha, 1e-6);
    return vec4f(color, alpha);
}
