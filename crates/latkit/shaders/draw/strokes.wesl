// Strokes: one instanced quad per segment of every row's path, for edges and lines alike. The cast
// variant draws the same quads through the light's eye into the shadow map.

import package::lib::types::{ARROWS, PATH_TRACE};
import package::lib::bind::{frame, mark};
import package::lib::project::{to_clip, nearer, culled};
import package::lib::path::{segment, segment_screen, stroke_style, ends_colored, path_count};
import package::lib::marker::{MarkerColor, glow};
import package::lib::stroke::{Stroke, stroke, stroke_distance};
import package::lib::shade::caster;
import package::lib::color::output;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) p: vec2f,
    @location(1) @interpolate(flat) a: vec2f,
    @location(2) @interpolate(flat) b: vec2f,
    @location(3) @interpolate(flat) row: u32,
    @location(4) color: vec4f,
    // Width, distance along at `a`, dash, flow.
    @location(5) @interpolate(flat) style: vec4f,
    @location(6) height: f32,
    // Whether the segment ends in an arrowhead.
    @location(7) @interpolate(flat) arrow: u32,
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    var out: Varyings;
    let s = segment(instance);
    out.row = s.row;
    let style = stroke_style(s.row);
    let on = segment_screen(s);
    let ends = on.ends;
    if !style.shown || !on.shown {
        out.clip = culled();
        return out;
    }
    let ca = on.ca;
    let cb = on.cb;
    let a = on.a;
    let b = on.b;
    let dir = normalize(b - a + vec2f(1e-6, 0.0));
    let normal = vec2f(-dir.y, dir.x);
    let arrow = (mark.flags & ARROWS) != 0u && s.index + 1u == path_count(s.row);
    let head = select(0.0, frame.arrow + style.width, arrow);
    let reach = 0.5 * style.width + head + frame.glow + 1.0;
    let t = f32(corner & 1u);
    let side = f32(corner >> 1u) * 2.0 - 1.0;
    let screen = mix(a - dir * reach, b + dir * reach, t) + normal * side * reach;
    out.clip = nearer(to_clip(screen, select(ca, cb, t > 0.5)));
    out.p = screen;
    out.a = a;
    out.b = b;
    var color = style.color;
    if ends_colored() {
        color *= mix(ends[0].color, ends[1].color, t);
    }
    out.color = color;
    out.style = vec4f(style.width, select(0.0, a.x, mark.source == PATH_TRACE), f32(style.dash), style.flow);
    out.height = mix(ends[0].world.z, ends[1].world.z, t);
    out.arrow = u32(arrow);
    return out;
}

fn segment_of(v: Varyings) -> Stroke {
    return Stroke(v.a, v.b, v.style.y, v.style.x, v.color, v.style.w, v.style.z > 0.5, v.arrow != 0u);
}

@if(!casts)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let s = segment_of(v);
    return output(glow(MarkerColor(stroke(v.p, s), stroke_distance(v.p, s).x), v.row));
}

@if(casts)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let c = stroke(v.p, segment_of(v));
    if c.a <= 0.01 {
        discard;
    }
    return caster(c.a, v.height);
}
