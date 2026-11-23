// Points: one instanced quad per vertex row, shaded by its marker. A quad covers its marker and any
// status ring, plus one pixel of antialiased edge. A quad's corners place its point on screen (see
// `lib/screen.wesl`). The focus variant redraws the lit rows over everything, with quads enlarged
// for their glow. Where depth varies, an opaque pass draws each marker's opaque pixels before any
// pixel blends, keeping their depth, so the nearest marker shows. The custom variants call an
// application's `marker`, and the shaded variants its `shade`.

import package::lib::types::{
    STATUS, MARKER_SHAPE, MARKER_GAUGE, MARKER_PIE, MARKER_ICON, MARKER_SYMBOL, DRAW_OPAQUE, ICON_SIZE,
    SYMBOL_MARGIN, SYMBOL_SPREAD,
};
import package::lib::bind::{mark, eye, ramp, program, focused, word};
import package::lib::points::{shown_point, Point};
import package::lib::drawn::drawn_instance;
import package::lib::state::{packed_inputs, extra_at};
import package::lib::mark::px_per_length;
import package::lib::hooks::{MarkerColor, MarkerFragment};
import package::lib::shade::shade_fragment;
import package::lib::project::{to_clip, nearer, culled, world, clip_of, to_screen};
import package::lib::screen::{ScreenPoint, screen_point, point_reach};
import package::lib::marker::{gauge, pie, filled, outline_distance, status_ring, glow, premultiplied};
import package::lib::color::{output, OPAQUE};

@group(2) @binding(15) var icons: texture_2d_array<f32>;

// Marker kind belongs to the scene, not to a row. Ordinary shapes need neither input arrays
// nor the image, gauge, and pie shader branches. Blocks share the ordinary shape program.
@if(!custom)
override MARKER: u32 = MARKER_SHAPE;

// Whether the mark's rows turn by a bearing, fixed when the pipeline is created. Only the pipelines
// of such marks hold the code, so other marks compile and draw as if there were none.
override TURNED: bool = false;

struct Varyings {
    // Invariant, so the opaque pass and the other draws compute the same depth.
    @invariant @builtin(position) clip: vec4f,
    @location(0) p: vec2f,
    @location(1) @interpolate(flat) row: u32,
    @location(2) color: vec4f,
    // The marker's half size, then the cosine and sine of its turn on screen, clockwise (see
    // `turn_of`): (1, 0) for a mark that turns none.
    @location(3) @interpolate(flat) shape: vec4f,
    @location(4) @interpolate(flat) status: vec4f,
    // The row's focus bits, which choose the focus draw's glow.
    @location(5) @interpolate(flat) focus: u32,
}

// Whether this variant draws lit rows, with quads enlarged for their glow.
@if(focused)
const LIT_DRAW: bool = true;
@if(!focused)
const LIT_DRAW: bool = false;

// Point `instance`: a drawn row's, or in the lit draw, a lit row's.
fn marker_at(instance: u32) -> Point {
    if LIT_DRAW {
        return shown_point(focused(mark.focused + instance), true);
    }
    return shown_point(drawn_instance(instance), false);
}

// The cosine and sine of how far the marker at `p` turns on screen, clockwise: its row's bearing
// from the ground's up there, which is north on the earth, so a marker turns with the view. The
// bearing follows the marker's inputs among the row's extra words.
fn turn_of(p: Point) -> vec2f {
    let after = (mark.inputs >> 8u) + (mark.inputs & 0xffu);
    let bearing = radians(bitcast<f32>(word(extra_at(p.row, after))));
    // Which way the ground's up points on screen: toward a point a few pixels up from here, which
    // on a plane whose y grows down, mirrored by the eye's matrix, has a lesser y.
    let mirrored = determinant(mat2x2f(eye.clip_from_world[0].xy, eye.clip_from_world[1].xy)) < 0.0;
    let step = select(8.0, -8.0, mirrored) / px_per_length();
    let here = to_screen(clip_of(world(p.position, vec2f(0.0), 0.0)));
    let above = to_screen(clip_of(world(p.position, vec2f(0.0, step), 0.0)));
    // Its sine and cosine, clockwise from the screen's up, which is toward smaller y.
    let up = normalize(vec2f(above.x - here.x, here.y - above.y) + vec2f(0.0, 1e-6));
    let c = cos(bearing);
    let s = sin(bearing);
    return vec2f(up.y * c - up.x * s, up.x * c + up.y * s);
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    let at = marker_at(instance);
    let p = screen_point(at);
    var out: Varyings;
    if !p.shown {
        out.clip = culled();
        return out;
    }
    var extent = point_reach(p, LIT_DRAW);
    @if(!custom) {
        // A symbol's ink may reach its margin past the box.
        if MARKER == MARKER_SYMBOL {
            extent += SYMBOL_MARGIN * p.half;
        }
    }
    out.shape = vec4f(max(p.half, vec2f(0.5)), 1.0, 0.0);
    if TURNED {
        // A turned marker may reach any way round its center.
        extent = vec2f(length(extent));
        out.shape = vec4f(out.shape.xy, turn_of(at));
    }
    let quad = vec2f(f32(corner & 1u), f32(corner >> 1u)) * 2.0 - 1.0;
    // Every corner shares the marker's depth, so their w is 1.
    out.clip = nearer(to_clip(p.center + quad * extent, vec4f(0.0, 0.0, p.depth, 1.0)));
    out.p = quad * extent * vec2f(1.0, -1.0);
    out.row = p.row;
    out.color = p.color;
    out.status = p.status;
    out.focus = p.focus;
    return out;
}

// The marker's inputs. A plain shape reads none.
fn inputs(row: u32) -> array<f32, 8> {
    @if(!custom)
    if MARKER == MARKER_SHAPE { return array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0); }
    return packed_inputs(row, mark.inputs);
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

// A symbol: path `f.input[0]` of the mark's paths, read from its distance field in the icon atlas,
// fitted to the square of the marker's smaller side with its margin around it, and drawn in the
// row's color: filled, or stroked at the width in `mark.hole`, in CSS pixels. The palette holds the
// path count, then each path's layer. Symbols have a program of their own. One function that
// returned a symbol's color in a branch and an icon's after it drew the icon's red channel for the
// symbol's, with the depth test on, under Direct3D on Intel graphics.
fn symbol(f: MarkerFragment) -> MarkerColor {
    let count = max(program(mark.palette), 1u);
    let layer = program(mark.palette + 1u + min(u32(max(f.input[0], 0.0)), count - 1u));
    let reach = (1.0 + SYMBOL_MARGIN) * min(f.half.x, f.half.y);
    let uv = vec2f(f.p.x, -f.p.y) / (2.0 * reach) + 0.5;
    let texel = textureSampleLevel(icons, ramp, uv, layer, 0.0).r;
    // The field's distance in CSS pixels at the marker's size, far outside past the field's edge.
    let d = (texel - 0.5) * 2.0 * SYMBOL_SPREAD * (2.0 * reach / ICON_SIZE);
    let within = all(abs(uv - 0.5) <= vec2f(0.5));
    return filled(f.color, select(1000.0, d - 0.5 * mark.hole, within));
}

@if(!custom)
fn marker(f: MarkerFragment) -> MarkerColor {
    switch MARKER {
        case MARKER_ICON: { return icon(f); }
        case MARKER_SYMBOL: { return symbol(f); }
        case MARKER_GAUGE: { return gauge(f.p, f.half, f.color, mark.shape, f.input[0]); }
        case MARKER_PIE: { return pie(f.p, min(f.half.x, f.half.y), f.input, mark.inputs & 0xffu, mark.hole); }
        default: { return filled(f.color, outline_distance(f.p, f.half)); }
    }
}

// The pixel's marker color, with any status ring, then shaded.
fn colored(v: Varyings) -> MarkerColor {
    var p = v.p;
    if TURNED {
        // A turned marker reads its pixel in its own frame.
        let turn = v.shape.zw;
        p = vec2f(turn.x * v.p.x - turn.y * v.p.y, turn.y * v.p.x + turn.x * v.p.y);
    }
    let f = MarkerFragment(p, v.shape.xy, v.color, inputs(v.row));
    var m = marker(f);
    if ((mark.flags & STATUS) != 0u) & (v.status.a > 0.0) {
        m = status_ring(m, vec4f(v.status.rgb, v.status.a * v.color.a));
    }
    @if(shaded) {
        m.color = shade(shade_fragment(m.color, v.clip.xy, v.p, v.row));
    }
    return m;
}

// Where depth varies, a mark draws twice with this one program: first its opaque pixels, keeping
// their depth, through the copy of its uniform whose `opaque` is set, then every pixel. Its
// antialiased edge, any part too small to cover a pixel, an icon's clear pixels, a custom marker's
// holes, and translucent rows (dimmed by a selection, fading, or of a translucent color) draw in
// the second pass, over the opaque pixels. That pass writes no depth, so the discard it never takes
// leaves early depth tests on.
@if(!focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let c = premultiplied(colored(v));
    if (mark.draw == DRAW_OPAQUE) & (c.a < OPAQUE) {
        discard;
    }
    return output(c);
}

@if(focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    return output(glow(colored(v), v.focus));
}
