// Edges: one instanced quad per row, a stroke between the vertices its ends name.

import package::lib::types::{NONE, VISIBLE, DASH, PINNED, PLACED, ENDS_COLOR, EDGE_COLOR, EDGE_WIDTH};
import package::lib::bind::{frame, mark};
import package::lib::state::{row_at, edge_at, vertex_slot};
import package::lib::project::{project, to_screen, to_clip, nearer, facing, culled};
import package::lib::focus::faded;
import package::lib::motion::{previous_row, previous_word, previous_float, ease_color, ease};
import package::lib::marker::{MarkerColor, glow};
import package::lib::stroke::{Stroke, stroke, stroke_distance};
import package::lib::color::output;
import package::lib::mark::px;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) p: vec2f,
    @location(1) @interpolate(flat) a: vec2f,
    @location(2) @interpolate(flat) b: vec2f,
    @location(3) @interpolate(flat) row: u32,
    @location(4) color: vec4f,
    // Width, distance along at `a`, dash, flow.
    @location(5) @interpolate(flat) style: vec4f,
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) row: u32) -> Varyings {
    let e = edge_at(row_at(row));
    var out: Varyings;
    out.row = row;
    if e.a == NONE || e.b == NONE || (e.flags & VISIBLE) == 0u {
        out.clip = culled();
        return out;
    }
    let va = vertex_slot(e.a);
    let vb = vertex_slot(e.b);
    let t = f32(corner & 1u);
    var width = px(e.width, EDGE_WIDTH);
    var color = unpack4x8unorm(e.color);
    if (mark.flags & ENDS_COLOR) != 0u {
        color = mix(unpack4x8unorm(va.color), unpack4x8unorm(vb.color), t);
    }
    let was = previous_row(row);
    if was != NONE {
        width = ease(px(previous_float(was, EDGE_WIDTH), EDGE_WIDTH), width);
        if (mark.flags & ENDS_COLOR) == 0u {
            color = ease_color(previous_word(was, EDGE_COLOR), e.color);
        }
    }
    let ca = project(va.hi, va.lo, va.elevation);
    let cb = project(vb.hi, vb.lo, vb.elevation);
    let a = to_screen(ca);
    let b = to_screen(cb);
    let dir = normalize(b - a + vec2f(1e-6, 0.0));
    let normal = vec2f(-dir.y, dir.x);
    let reach = 0.5 * width + frame.glow + 1.0;
    let side = f32(corner >> 1u) * 2.0 - 1.0;
    let screen = mix(a - dir * reach, b + dir * reach, t) + normal * side * reach;
    out.clip = nearer(to_clip(screen, select(ca, cb, t > 0.5)));
    out.p = screen;
    out.a = a;
    out.b = b;
    out.color = vec4f(color.rgb, color.a * faded(row));
    out.style = vec4f(width, 0.0, f32((e.flags & DASH) != 0u), e.flow);
    let placed = (va.flags & (PINNED | PLACED)) != 0u && (vb.flags & (PINNED | PLACED)) != 0u;
    if !placed || (!facing(va.hi, va.lo) && !facing(vb.hi, vb.lo)) || ca.w <= 0.0 || cb.w <= 0.0 {
        out.clip = culled();
    }
    return out;
}

fn segment(v: Varyings) -> Stroke {
    return Stroke(v.a, v.b, v.style.y, v.style.x, v.color, v.style.w, v.style.z > 0.5);
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let s = segment(v);
    return output(glow(MarkerColor(stroke(v.p, s), stroke_distance(v.p, s).x), v.row));
}
