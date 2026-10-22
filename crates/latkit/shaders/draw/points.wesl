// Points: one instanced quad per vertex row, shaded by its marker; a group's rows draw as
// containers. A quad covers its marker and a pixel of edge, no more, and a small one a later one
// covers in a crowded cell is left out. The focus variant draws the rows the mark's focus lights
// again, over everything, reaching out to their glow; a group only glows about its border, so what
// it holds still shows. The cast variant draws the same quads through the light's eye into the
// shadow map; the ports variant draws one quad per port of every row, on its side of the row's
// marker.

import package::lib::types::{STATUS, MARKER_ICON, MARKER_SHAPE, MARKER_BLOCK, GROUP, CASTS, SPACE_DIAGRAM};
import package::lib::bind::{frame, eye, mark, state, ramp, program, focused};
import package::lib::state::extra_at;
import package::lib::project::{to_screen, to_clip, nearer, culled};
import package::lib::points::{Point, point, reach, port_at};
import package::lib::marker::{
    MarkerColor, MarkerFragment, builtin_marker, container, border, dropped, outline_distance, box_distance,
    shape_distance, filled, over, status_ring, glow, premultiplied, theme_text, theme_corner, theme_lift,
};
import package::lib::shade::{caster, daylight};
import package::lib::mark::fringe;
import package::lib::color::output;

@group(2) @binding(15) var icons: texture_2d_array<f32>;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) p: vec2f,
    @location(1) @interpolate(flat) row: u32,
    @location(2) color: vec4f,
    @location(3) @interpolate(flat) half: vec2f,
    @location(4) @interpolate(flat) status: vec4f,
    @location(5) @interpolate(flat) height: f32,
    @location(6) @interpolate(flat) shape: u32,
    // A group's depth; for a port, 1 when its reference names a net.
    @location(7) @interpolate(flat) extra: f32,
    // The row's focus bits, which the focus draw glows by.
    @location(8) @interpolate(flat) focus: u32,
}

// What an instance draws: a row's marker, or with `ports` one of a row's ports.
struct Drawn {
    p: Point,
    center: vec2f,
    half: vec2f,
    reach: vec2f,
    shape: u32,
    extra: f32,
}

@if(!ports && !focused)
fn drawn(instance: u32) -> Drawn {
    let p = point(instance);
    return Drawn(p, to_screen(p.clip), p.half, reach(p, false), mark.shape, p.depth);
}

@if(focused)
fn drawn(instance: u32) -> Drawn {
    let p = point(focused[mark.focused + instance]);
    return Drawn(p, to_screen(p.clip), p.half, reach(p, true), mark.shape, p.depth);
}

@if(ports)
fn drawn(instance: u32) -> Drawn {
    let n = max(mark.ports, 1u);
    let p = point(instance / n);
    let port = port_at(p, instance % n);
    let half = vec2f(port.half);
    return Drawn(p, port.center, half, half + 1.5 * frame.unit + fringe(), port.shape, f32(port.wired));
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    let d = drawn(instance);
    let quad = vec2f(f32(corner & 1u), f32(corner >> 1u)) * 2.0 - 1.0;
    var out: Varyings;
    out.clip = nearer(to_clip(d.center + quad * d.reach, d.p.clip));
    out.p = quad * d.reach * vec2f(1.0, -1.0);
    out.row = d.p.row;
    out.color = vec4f(d.p.color.rgb * daylight(d.p.position), d.p.color.a);
    out.half = max(d.half, vec2f(0.5));
    out.status = d.p.status;
    out.height = d.p.world.z;
    out.shape = d.shape;
    out.extra = d.extra;
    out.focus = d.p.focus;
    if !d.p.shown {
        out.clip = culled();
    }
    return out;
}

fn inputs(row: u32) -> array<f32, 8> {
    var input = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for (var i = 0u; i < min(mark.inputs, 8u); i++) {
        input[i] = bitcast<f32>(state[extra_at(row, mark.input + i)]);
    }
    return input;
}

// An icon: image `index` of the mark's images, fitted in the marker's box, faded with its row. The
// palette holds how many images there are, then each one's layer of the icon atlas.
fn icon(f: MarkerFragment) -> MarkerColor {
    let uv = vec2f(f.p.x, -f.p.y) / (2.0 * f.half) + 0.5;
    let count = max(program[mark.palette], 1u);
    let layer = program[mark.palette + 1u + min(u32(max(f.input[0], 0.0)), count - 1u)];
    let texel = textureSampleLevel(icons, ramp, uv, layer, 0.0);
    let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
    let d = outline_distance(f.p, f.half);
    return MarkerColor(vec4f(texel.rgb, texel.a * f.color.a * f32(inside)), d);
}

@if(!custom)
fn marker(f: MarkerFragment) -> MarkerColor {
    if mark.marker == MARKER_ICON {
        return icon(f);
    }
    return builtin_marker(f);
}

// A port: its shape in its row's color mixed toward the theme's text, so it reads on the marker in
// either theme, ringed by the background so it reads apart from the marker; hollow while no net plugs
// into it. Its ring and outline are part of the drawing, as the port is.
@if(ports)
fn shaded(v: Varyings) -> MarkerColor {
    let u = frame.unit;
    let d = shape_distance(v.shape, v.p, v.half);
    let ink = vec4f(mix(v.color.rgb, theme_text(), 0.55), v.color.a);
    let ring = filled(vec4f(frame.background.rgb, v.color.a), d - 1.25 * u);
    if v.extra > 0.5 {
        return over(filled(ink, d), ring);
    }
    let line = 0.5 * max(1.25 * u, 1.0 / eye.pixel_ratio);
    let hollow = over(filled(ink, abs(d + line) - line), filled(vec4f(frame.background.rgb, v.color.a), d));
    return over(hollow, ring);
}

// Whether the mark draws a diagram's blocks: shapes and blocks on a diagram's sheet, which the theme
// borders, and shadows when they cast them.
fn sheet_blocks() -> bool {
    return frame.space == SPACE_DIAGRAM && (mark.marker == MARKER_SHAPE || mark.marker == MARKER_BLOCK);
}

@if(!ports)
fn shaded(v: Varyings) -> MarkerColor {
    let f = MarkerFragment(v.p, v.half, v.color, inputs(v.row));
    var m = marker(f);
    let group = (mark.flags & GROUP) != 0u;
    if group {
        m = container(f, v.extra);
    } else if sheet_blocks() {
        m = border(m, m.distance, v.color.a);
    }
    if (mark.flags & STATUS) != 0u && v.status.a > 0.0 {
        m = status_ring(m, vec4f(v.status.rgb, v.status.a * v.color.a));
    }
    if (mark.flags & CASTS) != 0u && frame.space == SPACE_DIAGRAM {
        // y is up in a marker: the shadow falls below, measured from its outline lowered.
        let below = v.p + vec2f(0.0, theme_lift());
        let distance = select(
            outline_distance(below, v.half),
            box_distance(below, v.half, min(theme_corner(), 0.5 * min(v.half.x, v.half.y))),
            group,
        );
        m = dropped(m, distance, v.color.a);
    }
    return m;
}

@if(!casts && !focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    return output(premultiplied(shaded(v)));
}

@if(focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let m = shaded(v);
    if (mark.flags & GROUP) != 0u {
        // Drawn over what it holds, a group's body would hide it: it glows on both sides of its border.
        return output(glow(MarkerColor(vec4f(0.0), abs(m.distance)), v.focus));
    }
    return output(glow(m, v.focus));
}

@if(casts)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let m = shaded(v);
    if m.color.a <= 0.01 {
        discard;
    }
    return caster(m.color.a, v.height);
}
