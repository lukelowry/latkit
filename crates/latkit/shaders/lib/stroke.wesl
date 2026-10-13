// Strokes: antialiased segments with dashes, flowing comets, and arrowheads, in CSS pixels.

import package::lib::bind::frame;
import package::lib::mark::coverage;

struct Stroke {
    a: vec2f,
    b: vec2f,
    // Distance along the whole line at `a`, CSS pixels.
    along: f32,
    width: f32,
    color: vec4f,
    // Comet speed, CSS pixels per second; 0 for none.
    flow: f32,
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

// (distance outside the stroke's edge, distance along the line) for pixel `p`.
fn stroke_distance(p: vec2f, s: Stroke) -> vec2f {
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
    return vec2f(d, s.along + clamp(dot(p - s.a, dir), 0.0, len));
}

fn stroke(p: vec2f, s: Stroke) -> vec4f {
    let d = stroke_distance(p, s);
    var alpha = coverage(d.x);
    if s.dash {
        alpha *= step(0.5, fract(d.y / max(frame.dash, 1.0)));
    }
    var color = s.color.rgb;
    if s.flow != 0.0 && frame.flow.a > 0.0 {
        let comet = pow(fract((d.y - frame.elapsed * s.flow) / max(frame.flow_spacing, 1.0)), 6.0);
        color = mix(color, frame.flow.rgb, comet * frame.flow.a);
    }
    return vec4f(color, s.color.a * alpha);
}
