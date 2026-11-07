// Markers, drawn as signed distance fields in CSS pixels. A custom marker supplies `fn marker`.

import package::lib::types::{
    SELECTED, HOVERED, SHAPE_RECTANGLE, SHAPE_ROUNDED, SHAPE_DIAMOND, MARKER_BLOCK,
    THEME_CORNER,
};
import package::lib::bind::{frame, mark, program, theme_word};
import package::lib::mark::coverage;
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

// The theme's corner radius of block markers, in CSS pixels.
fn theme_corner() -> f32 {
    return bitcast<f32>(theme_word(THEME_CORNER));
}

// Signed distance from a marker's outline. Blocks are rounded boxes with the theme's corner radius
// unless the marker sets its own. Other markers use their shape.
fn outline_distance(p: vec2f, half: vec2f) -> f32 {
    if mark.marker == MARKER_BLOCK {
        let corner = select(mark.corner, theme_corner(), mark.corner < 0.0);
        return box_distance(p, half, min(corner, min(half.x, half.y)));
    }
    return shape_distance(mark.shape, p, half);
}

// `color` covering where `distance` is negative, antialiased over a pixel.
fn filled(color: vec4f, distance: f32) -> MarkerColor {
    return MarkerColor(vec4f(color.rgb, color.a * coverage(distance)), distance);
}

// `top` composited over `bottom`.
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

// A pie's slice colors are the mark's palette.
fn slice_color(i: u32) -> vec4f {
    return unpack4x8unorm(program(mark.palette + i));
}

fn pie(p: vec2f, radius: f32, slices: array<f32, 8>, count: u32, hole: f32) -> MarkerColor {
    var total = 0.0;
    for (var i = 0u; i < count; i++) {
        total += max(slices[i], 0.0);
    }
    let angle = fract(atan2(p.x, p.y) / TAU + 1.0) * total;
    var start = 0.0;
    var color = slice_color(0u);
    for (var i = 0u; i < count; i++) {
        let end = start + max(slices[i], 0.0);
        color = select(color, slice_color(i), angle >= start && angle < end);
        start = end;
    }
    let d = length(p);
    return filled(color, max(d - radius, radius * hole - d));
}

// A ring of the status color just outside the marker's outline.
fn status_ring(m: MarkerColor, status: vec4f) -> MarkerColor {
    return MarkerColor(over(filled(status, abs(m.distance - 1.5) - 1.25), m).color, m.distance);
}

// `m` premultiplied.
fn premultiplied(m: MarkerColor) -> vec4f {
    return vec4f(m.color.rgb * m.color.a, m.color.a);
}

// A premultiplied color with a glow around its shape for focus bits `focus`: the selection color
// or the hover color. A row lit only as one reference from a selected or hovered row draws without
// a glow, so many of them never merge into one.
fn glow(m: MarkerColor, focus: u32) -> vec4f {
    let base = premultiplied(m);
    if (focus & (SELECTED | HOVERED)) == 0u || frame.glow <= 0.0 {
        return base;
    }
    let own = vec4f(m.color.rgb, frame.selected.a);
    let selected = select(frame.selected, own, frame.selected.r < 0.0);
    let tint = select(frame.hover, selected, (focus & SELECTED) != 0u);
    let halo = tint.a * (1.0 - smoothstep(0.0, frame.glow, max(m.distance, 0.0)));
    return base + vec4f(tint.rgb * halo, halo) * (1.0 - base.a);
}
