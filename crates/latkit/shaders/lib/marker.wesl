// Markers are signed distance fields in CSS pixels; a custom marker supplies `fn marker`.

import package::lib::types::{
    SELECTED, HOVERED, SHAPE_RECTANGLE, SHAPE_ROUNDED, SHAPE_DIAMOND, MARKER_GAUGE, MARKER_PIE, MARKER_BLOCK,
    THEME_TEXT, THEME_OUTLINE, THEME_CORNER, THEME_PORT_SIZE, THEME_LIFT,
};
import package::lib::bind::{frame, eye, mark, program};
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

fn theme_word(slot: u32) -> u32 {
    return frame.theme[slot / 4u][slot % 4u];
}

// The theme's text color: what ports mix toward, so they read on light and dark grounds.
fn theme_text() -> vec3f {
    return unpack4x8unorm(theme_word(THEME_TEXT)).rgb;
}

// The border of a diagram's blocks and groups; clear for none.
fn theme_outline() -> vec4f {
    return unpack4x8unorm(theme_word(THEME_OUTLINE));
}

// A diagram's corner radius, a port's width, and how far a shadow falls: CSS pixels at this zoom.
fn theme_corner() -> f32 {
    return bitcast<f32>(theme_word(THEME_CORNER)) * frame.unit;
}

fn theme_port_size() -> f32 {
    return bitcast<f32>(theme_word(THEME_PORT_SIZE)) * frame.unit;
}

fn theme_lift() -> f32 {
    return bitcast<f32>(theme_word(THEME_LIFT)) * frame.unit;
}

// The outline a marker's distance is measured from: blocks are rounded boxes, their corners the
// theme's unless the marker sets its own, others their shape.
fn outline_distance(p: vec2f, half: vec2f) -> f32 {
    if mark.marker == MARKER_BLOCK {
        let corner = select(mark.corner * frame.unit, theme_corner(), mark.corner < 0.0);
        return box_distance(p, half, min(corner, min(half.x, half.y)));
    }
    return shape_distance(mark.shape, p, half);
}

// `color` covering where `distance` is negative, antialiased over a pixel.
fn filled(color: vec4f, distance: f32) -> MarkerColor {
    return MarkerColor(vec4f(color.rgb, color.a * coverage(distance)), distance);
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

// A pie's slice colors are the mark's palette.
fn slice_color(i: u32) -> vec4f {
    return unpack4x8unorm(program[mark.palette + i]);
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

fn builtin_marker(f: MarkerFragment) -> MarkerColor {
    switch mark.marker {
        case MARKER_GAUGE: { return gauge(f.p, f.half, f.color, mark.shape, f.input[0]); }
        case MARKER_PIE: { return pie(f.p, min(f.half.x, f.half.y), f.input, mark.inputs, mark.hole); }
        default: { return filled(f.color, outline_distance(f.p, f.half)); }
    }
}

// A group's container: a box with the theme's corners, filled in its color, tinted a step toward the
// text color for each group holding it, and bordered; its title sits in the room atop it.
fn container(f: MarkerFragment, depth: f32) -> MarkerColor {
    let fill = mix(f.color.rgb, theme_text(), min(0.06 * depth, 0.3));
    let d = box_distance(f.p, f.half, min(theme_corner(), 0.5 * min(f.half.x, f.half.y)));
    return border(filled(vec4f(fill, f.color.a), d), d, f.color.a);
}

// `m`, its outline `d` bordered inside in the theme's outline a unit wide, never under a pixel.
fn border(m: MarkerColor, d: f32, alpha: f32) -> MarkerColor {
    let outline = theme_outline();
    if outline.a <= 0.0 {
        return m;
    }
    let half = 0.5 * max(frame.unit, 1.0 / eye.pixel_ratio);
    return MarkerColor(over(filled(vec4f(outline.rgb, outline.a * alpha), abs(d + half) - half), m).color, m.distance);
}

// `m` over its shadow on the sheet: its outline `distance` lowered by the theme's lift, as soft
// again, in the theme's shadow color.
fn dropped(m: MarkerColor, distance: f32, alpha: f32) -> MarkerColor {
    let lift = max(theme_lift(), 0.5);
    let shade = frame.shade.color;
    let a = shade.a * alpha * (1.0 - smoothstep(-lift, lift, distance));
    return MarkerColor(over(m, MarkerColor(vec4f(shade.rgb, a), distance)).color, m.distance);
}

// A ring of the status color just outside the marker's outline, a part of the drawing in a diagram.
fn status_ring(m: MarkerColor, status: vec4f) -> MarkerColor {
    let u = frame.unit;
    return MarkerColor(over(filled(status, abs(m.distance - 1.5 * u) - 1.25 * u), m).color, m.distance);
}

// `m` premultiplied.
fn premultiplied(m: MarkerColor) -> vec4f {
    return vec4f(m.color.rgb * m.color.a, m.color.a);
}

// A premultiplied color with the glow of focus bits `focus` around its shape: the selection's, the
// hover's, or for the end of a lit edge the hover's, fainter.
fn glow(m: MarkerColor, focus: u32) -> vec4f {
    let base = premultiplied(m);
    if focus == 0u || frame.glow <= 0.0 {
        return base;
    }
    let own = vec4f(m.color.rgb, frame.selected.a);
    let selected = select(frame.selected, own, frame.selected.r < 0.0);
    var tint = select(frame.hover, selected, (focus & SELECTED) != 0u);
    if (focus & (SELECTED | HOVERED)) == 0u {
        tint.a *= 0.55;
    }
    let halo = tint.a * (1.0 - smoothstep(0.0, frame.glow, max(m.distance, 0.0)));
    return base + vec4f(tint.rgb * halo, halo) * (1.0 - base.a);
}
