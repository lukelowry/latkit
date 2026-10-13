// Markers are signed distance fields in CSS pixels; a custom marker supplies `fn marker`.

import package::lib::types::{
    SELECTED, SHAPE_RECTANGLE, SHAPE_ROUNDED, SHAPE_DIAMOND, MARKER_GAUGE, MARKER_PIE, MARKER_BLOCK,
};
import package::lib::bind::{frame, mark};
import package::lib::focus::focus_of;
import package::lib::project::TAU;

struct MarkerColor {
    color: vec4f,
    distance: f32,
}

struct MarkerFragment {
    // The pixel's offset from the vertex, CSS pixels, y up.
    p: vec2f,
    // Half the marker's width and height.
    half: vec2f,
    color: vec4f,
    input: array<f32, 8>,
}

fn box_distance(p: vec2f, half: vec2f, corner: f32) -> f32 {
    let d = abs(p) - half + corner;
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - corner;
}

fn shape_distance(shape: u32, p: vec2f, half: vec2f) -> f32 {
    switch shape {
        case SHAPE_RECTANGLE: { return box_distance(p, half, 0.0); }
        case SHAPE_ROUNDED: { return box_distance(p, half, 0.3 * min(half.x, half.y)); }
        case SHAPE_DIAMOND: { return (abs(p.x) / half.x + abs(p.y) / half.y - 1.0) * min(half.x, half.y) * 0.7071; }
        default: { return (length(p / half) - 1.0) * min(half.x, half.y); }
    }
}

// `color` covering where `distance` is negative, antialiased over a pixel.
fn filled(color: vec4f, distance: f32) -> MarkerColor {
    return MarkerColor(vec4f(color.rgb, color.a * clamp(0.5 - distance * frame.pixel_ratio, 0.0, 1.0)), distance);
}

// `top` over `bottom`.
fn over(top: MarkerColor, bottom: MarkerColor) -> MarkerColor {
    let a = top.color.a + bottom.color.a * (1.0 - top.color.a);
    let rgb = (top.color.rgb * top.color.a + bottom.color.rgb * bottom.color.a * (1.0 - top.color.a)) / max(a, 1e-6);
    return MarkerColor(vec4f(rgb, a), min(top.distance, bottom.distance));
}

fn gauge(p: vec2f, half: vec2f, color: vec4f, shape: u32, fill: f32) -> MarkerColor {
    let ring = filled(color, abs(shape_distance(shape, p, half)) - 1.0);
    let f = clamp(fill, 0.0, 1.0);
    let inner = shape_distance(shape, p, half - 2.5);
    let around = (fract(atan2(p.x, p.y) / TAU + 1.0) - f) * half.x * TAU;
    let cut = select(p.y - mix(-half.y, half.y, f), around, shape == 0u);
    return over(ring, filled(color, max(inner, cut)));
}

fn pie(p: vec2f, radius: f32, slices: array<f32, 8>, count: u32, hole: f32) -> MarkerColor {
    var total = 0.0;
    for (var i = 0u; i < count; i++) {
        total += max(slices[i], 0.0);
    }
    let angle = fract(atan2(p.x, p.y) / TAU + 1.0) * total;
    var start = 0.0;
    var color = mark.pie[0];
    for (var i = 0u; i < count; i++) {
        let end = start + max(slices[i], 0.0);
        color = select(color, mark.pie[i], angle >= start && angle < end);
        start = end;
    }
    let d = length(p);
    return filled(color, max(d - radius, radius * hole - d));
}

fn builtin_marker(f: MarkerFragment) -> MarkerColor {
    switch mark.marker {
        case MARKER_GAUGE: { return gauge(f.p, f.half, f.color, mark.shape, f.input[0]); }
        case MARKER_PIE: { return pie(f.p, min(f.half.x, f.half.y), f.input, mark.inputs, mark.hole); }
        case MARKER_BLOCK: { return filled(f.color, box_distance(f.p, f.half, mark.corner)); }
        default: { return filled(f.color, shape_distance(mark.shape, f.p, f.half)); }
    }
}

// A premultiplied color with the row's focus glow around its shape.
fn glow(m: MarkerColor, row: u32) -> vec4f {
    let base = vec4f(m.color.rgb * m.color.a, m.color.a);
    let focus = focus_of(row);
    if focus == 0u || frame.glow <= 0.0 {
        return base;
    }
    let own = vec4f(m.color.rgb, frame.selected.a);
    let selected = select(frame.selected, own, frame.selected.r < 0.0);
    let tint = select(frame.hover, selected, (focus & SELECTED) != 0u);
    let halo = tint.a * (1.0 - smoothstep(0.0, frame.glow, max(m.distance, 0.0)));
    return base + vec4f(tint.rgb * halo, halo) * (1.0 - base.a);
}

fn shadow(m: MarkerColor) -> vec4f {
    return vec4f(0.0, 0.0, 0.0, 0.3 * (1.0 - smoothstep(-2.0, 6.0, m.distance)));
}
