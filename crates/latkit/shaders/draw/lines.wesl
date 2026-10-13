// Lines: one instanced quad per segment of each row's trace, between consecutive frames in view.

import package::lib::types::{VISIBLE, DASH, LINE_WIDTH};
import package::lib::bind::{frame, mark};
import package::lib::state::{row_at, line_at};
import package::lib::project::{project, to_screen, to_clip, nearer, culled};
import package::lib::read::missing_bits;
import package::lib::trace::{trace_first, trace_frames, trace_axis, trace_value};
import package::lib::focus::faded;
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
    // Width, distance along at `a`, dash.
    @location(5) @interpolate(flat) style: vec4f,
}

// A point of the trace: its coordinate across, its value up.
fn point(index: u32, value: u32) -> vec4f {
    let x = trace_axis(index);
    return project(vec2f(x.x, bitcast<f32>(value)), vec2f(x.y, 0.0), 0.0);
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    var out: Varyings;
    let segments = max(trace_frames(), 1u) - 1u;
    let row = instance / max(segments, 1u);
    let first = trace_first() + instance % max(segments, 1u);
    out.row = row;
    let l = line_at(row_at(row));
    let va = trace_value(row, first);
    let vb = trace_value(row, first + 1u);
    if segments == 0u || (l.flags & VISIBLE) == 0u || missing_bits(va) || missing_bits(vb) {
        out.clip = culled();
        return out;
    }
    let ca = point(first, va);
    let cb = point(first + 1u, vb);
    let a = to_screen(ca);
    let b = to_screen(cb);
    let width = px(l.width, LINE_WIDTH);
    let dir = normalize(b - a + vec2f(1e-6, 0.0));
    let normal = vec2f(-dir.y, dir.x);
    let reach = 0.5 * width + frame.glow + 1.0;
    let t = f32(corner & 1u);
    let side = f32(corner >> 1u) * 2.0 - 1.0;
    let screen = mix(a - dir * reach, b + dir * reach, t) + normal * side * reach;
    out.clip = nearer(to_clip(screen, select(ca, cb, t > 0.5)));
    out.p = screen;
    out.a = a;
    out.b = b;
    let color = unpack4x8unorm(l.color);
    out.color = vec4f(color.rgb, color.a * faded(row));
    out.style = vec4f(width, 0.0, f32((l.flags & DASH) != 0u), 0.0);
    return out;
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let s = Stroke(v.a, v.b, v.style.y, v.style.x, v.color, 0.0, v.style.z > 0.5);
    return output(glow(MarkerColor(stroke(v.p, s), stroke_distance(v.p, s).x), v.row));
}
