// Points: one instanced quad per vertex row, shaded by its marker. A quad covers its marker and any
// status ring, plus one pixel of antialiased edge. The focus variant redraws the lit rows over
// everything, with quads enlarged for their glow. Where depth varies, the opaque variant draws each
// marker's opaque pixels before any pixel blends, keeping their depth, so the nearest marker shows.

import package::lib::types::{STATUS, MARKER_SHAPE, MARKER_GAUGE, MARKER_PIE, MARKER_ICON};
import package::lib::bind::{mark, word, ramp, program, focused};
import package::lib::state::extra_at;
import package::lib::project::{to_screen, to_clip, nearer, culled};
import package::lib::points::{Point, shown_point, reach, drawn_clip};
import package::lib::marker::{
    MarkerColor, MarkerFragment, gauge, pie, filled, outline_distance, status_ring, glow, premultiplied,
};
import package::lib::daylight::daylight;
import package::lib::drawn::drawn_instance;
import package::lib::color::{output, OPAQUE};

@group(2) @binding(15) var icons: texture_2d_array<f32>;

// Marker kind belongs to the scene, not to a row. Ordinary shapes need neither input arrays
// nor the image, gauge, and pie shader branches. Blocks share the ordinary shape program.
@if(!custom)
override MARKER: u32 = MARKER_SHAPE;

struct Varyings {
    // Invariant, so the opaque variant and the other draws compute the same depth.
    @invariant @builtin(position) clip: vec4f,
    @location(0) p: vec2f,
    @location(1) @interpolate(flat) row: u32,
    @location(2) color: vec4f,
    @location(3) @interpolate(flat) half: vec2f,
    @location(4) @interpolate(flat) status: vec4f,
    // The row's focus bits, which choose the focus draw's glow.
    @location(5) @interpolate(flat) focus: u32,
}

// Whether this variant draws lit rows, with quads enlarged for their glow.
@if(focused)
const LIT_DRAW: bool = true;
@if(!focused)
const LIT_DRAW: bool = false;

// The point drawn at `instance`.
@if(!focused)
fn drawn(instance: u32) -> Point {
    return shown_point(drawn_instance(instance));
}

@if(focused)
fn drawn(instance: u32) -> Point {
    return shown_point(focused(mark.focused + instance));
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    let p = drawn(instance);
    var out: Varyings;
    if !p.shown {
        out.clip = culled();
        return out;
    }
    let extent = reach(p, LIT_DRAW);
    let quad = vec2f(f32(corner & 1u), f32(corner >> 1u)) * 2.0 - 1.0;
    out.clip = nearer(to_clip(to_screen(p.clip) + quad * extent, drawn_clip(p)));
    out.p = quad * extent * vec2f(1.0, -1.0);
    out.row = p.row;
    out.color = vec4f(p.color.rgb * daylight(p.position), p.color.a);
    out.half = max(p.half, vec2f(0.5));
    out.status = p.status;
    out.focus = p.focus;
    return out;
}

fn inputs(row: u32) -> array<f32, 8> {
    var input = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    @if(!custom)
    if MARKER == MARKER_SHAPE { return input; }
    for (var i = 0u; i < min(mark.inputs, 8u); i++) {
        input[i] = bitcast<f32>(word(extra_at(row, mark.input + i)));
    }
    return input;
}

// An icon: image `f.input[0]` of the mark's images, fitted to the marker's box and faded with its
// row. The palette holds the image count, then each image's layer in the icon atlas.
fn icon(f: MarkerFragment) -> MarkerColor {
    let uv = vec2f(f.p.x, -f.p.y) / (2.0 * f.half) + 0.5;
    let count = max(program(mark.palette), 1u);
    let layer = program(mark.palette + 1u + min(u32(max(f.input[0], 0.0)), count - 1u));
    let texel = textureSampleLevel(icons, ramp, uv, layer, 0.0);
    let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
    let d = outline_distance(f.p, f.half);
    return MarkerColor(vec4f(texel.rgb, texel.a * f.color.a * f32(inside)), d);
}

@if(!custom)
fn marker(f: MarkerFragment) -> MarkerColor {
    switch MARKER {
        case MARKER_ICON: { return icon(f); }
        case MARKER_GAUGE: { return gauge(f.p, f.half, f.color, mark.shape, f.input[0]); }
        case MARKER_PIE: { return pie(f.p, min(f.half.x, f.half.y), f.input, mark.inputs, mark.hole); }
        default: { return filled(f.color, outline_distance(f.p, f.half)); }
    }
}

fn shaded(v: Varyings) -> MarkerColor {
    let f = MarkerFragment(v.p, v.half, v.color, inputs(v.row));
    var m = marker(f);
    if (mark.flags & STATUS) != 0u && v.status.a > 0.0 {
        m = status_ring(m, vec4f(v.status.rgb, v.status.a * v.color.a));
    }
    return m;
}

// The opaque variant draws a marker's opaque pixels and keeps their depth. Its antialiased edge,
// any part too small to cover a pixel, an icon's clear pixels, a custom marker's holes, and
// translucent rows (dimmed by a selection, fading, or of a translucent color) draw after, over them.
// The vertex stage is shared. Separate fragment entries keep discard out of the normal draw,
// allowing early depth rejection without carrying draw-mode uniforms for every mark.
@if(!focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    return output(premultiplied(shaded(v)));
}

@if(!focused)
@fragment
fn opaque(v: Varyings) -> @location(0) vec4f {
    let c = premultiplied(shaded(v));
    if c.a < OPAQUE {
        discard;
    }
    return output(c);
}

@if(focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    return output(glow(shaded(v), v.focus));
}
