// Strokes: antialiased segments with dashes and flowing comets, in CSS pixels.

import package::lib::bind::frame;

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
}

// (distance outside the stroke's edge, distance along the line) for pixel `p`.
fn stroke_distance(p: vec2f, s: Stroke) -> vec2f {
    let ab = s.b - s.a;
    let t = clamp(dot(p - s.a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    return vec2f(length(p - (s.a + ab * t)) - 0.5 * s.width, s.along + t * length(ab));
}

fn stroke(p: vec2f, s: Stroke) -> vec4f {
    let d = stroke_distance(p, s);
    var alpha = clamp(0.5 - d.x * frame.pixel_ratio, 0.0, 1.0);
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
