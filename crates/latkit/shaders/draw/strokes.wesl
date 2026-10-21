// Strokes: one instanced quad per segment of every row's path, for edges and lines alike, covering
// the stroke, or its comets where they are wider, and a pixel of edge; a small segment a later one covers in a crowded cell is left out. A
// segment that ends a part of its path carries the arrowhead; in a diagram, a segment of no length is
// a junction, drawn as a dot. The focus variant draws the pieces of the rows the mark's focus lights
// again, over everything, reaching out to their glow. The cast variant draws the same quads through
// the light's eye into the shadow map.

import package::lib::types::{ARROWS, PATH_TRACE, SPACE_DIAGRAM};
import package::lib::path::PATH;
import package::lib::bind::{frame, mark, eye};
import package::lib::project::{to_clip, nearer, culled};
import package::lib::path::{
    segment, segment_screen, stroke_style, ends_colored, ends_part, path_count, path_length, px_per_length,
};
import package::lib::marker::{MarkerColor, glow};
import package::lib::focus::focus_of;
import package::lib::mark::fringe;
import package::lib::stroke::{Stroke, covered, stroke, stroke_distance};
import package::lib::shade::{caster, daylight};
import package::lib::color::output;

struct Varyings {
    // The corner in clip space; in the fragment, the target pixel, which `pixel` reads.
    @builtin(position) clip: vec4f,
    @location(0) @interpolate(flat) a: vec2f,
    @location(1) @interpolate(flat) b: vec2f,
    @location(2) @interpolate(flat) row: u32,
    @location(3) color: vec4f,
    // Width, distance along at `a` and at `b`, flow.
    @location(4) @interpolate(flat) style: vec4f,
    @location(5) height: f32,
    // Whether the segment ends in an arrowhead, then whether it dashes.
    @location(6) @interpolate(flat) arrow: u32,
    // The row's focus bits, which the focus draw glows by.
    @location(7) @interpolate(flat) focus: u32,
    // Distance along at `a` and at `b` in length units, and how far the row's comets traveled.
    @location(8) @interpolate(flat) comet: vec3f,
}

// Whether this variant draws lit rows, its quads reaching out to their glow.
@if(focused)
const LIT_DRAW: bool = true;
@if(!focused)
const LIT_DRAW: bool = false;

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    var out: Varyings;
    let s = segment(instance);
    out.row = s.row;
    if LIT_DRAW && (s.row >= mark.rows || s.index >= path_count(s.row)) {
        out.clip = culled();
        return out;
    }
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
    let junction = frame.space == SPACE_DIAGRAM && length(b - a) < 1e-3;
    let width = select(style.width, 3.0 * style.width, junction);
    let dir = normalize(b - a + vec2f(1e-6, 0.0));
    let normal = vec2f(-dir.y, dir.x);
    let arrow = (mark.flags & ARROWS) != 0u && !junction && ends_part(s);
    let head = select(0.0, frame.arrow + width, arrow);
    let comets = select(0.0, 0.5 * frame.flow_width, style.flow != 0.0 && frame.flow.a > 0.0);
    let reach = max(0.5 * width, comets) + head + select(0.0, frame.glow, LIT_DRAW) + fringe();
    let t = f32(corner & 1u);
    let side = f32(corner >> 1u) * 2.0 - 1.0;
    let screen = mix(a - dir * reach, b + dir * reach, t) + normal * side * reach;
    out.clip = nearer(to_clip(screen, select(ca, cb, t > 0.5)));
    out.a = a;
    out.b = b;
    // How far along the whole segment this corner lies, of the part drawn.
    let f = mix(on.kept.x, on.kept.y, t);
    var color = style.color;
    if ends_colored() {
        color *= mix(ends[0].color, ends[1].color, f);
    }
    let light = daylight(mix(ends[0].position.xy, ends[1].position.xy, f));
    out.color = vec4f(color.rgb * light, color.a);
    // In length units, a path runs from its start, a listed one's segment from where its list says it
    // starts, its ends stopping short where the stroke does. On screen, a trace runs along x, a
    // listed path as it does in length units, and else a segment from where its stroke starts.
    let along = s.along + path_length(ends[0], ends[1]) * on.kept;
    let pixels = length(b - a);
    var phase = vec2f(0.0, pixels);
    if PATH == PATH_TRACE {
        phase = vec2f(a.x, a.x + pixels);
    } else if mark.per_row == NONE {
        phase = along * px_per_length();
    }
    out.style = vec4f(width, phase, style.flow);
    out.comet = vec3f(along, style.travel);
    out.height = mix(ends[0].world.z, ends[1].world.z, f);
    out.arrow = u32(arrow) | (u32(style.dash && !junction) << 1u);
    out.focus = focus_of(s.row);
    return out;
}

// The fragment's pixel in CSS pixels, a screen position as `a` and `b` are. Read from the fragment's
// own position, never interpolated: a quad whose ends lie at very different depths skews what is
// interpolated, and a renderer clipping the quad at the screen's edge, as lavapipe does, moves it.
fn pixel(v: Varyings) -> vec2f {
    return v.clip.xy / eye.pixel_ratio;
}

fn segment_of(v: Varyings) -> Stroke {
    let dash = (v.arrow & 2u) != 0u;
    return Stroke(v.a, v.b, v.style.yz, v.comet.xy, v.style.x, v.color, v.style.w, v.comet.z, dash, (v.arrow & 1u) != 0u);
}

@if(!casts && !focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let c = stroke(pixel(v), segment_of(v));
    return output(vec4f(c.rgb * c.a, c.a));
}

@if(focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let s = segment_of(v);
    let p = pixel(v);
    return output(glow(MarkerColor(stroke(p, s), stroke_distance(p, s).x), v.focus));
}

@if(casts)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let s = segment_of(v);
    let alpha = s.color.a * covered(stroke_distance(pixel(v), s), s);
    if alpha <= 0.01 {
        discard;
    }
    return caster(alpha, v.height);
}
