// Strokes: one instanced quad per segment of every row's path, for edges and lines alike. A quad
// covers the stroke, or its comets where they are wider, any arrowhead, and one pixel of
// antialiased edge. The last segment of each part of a path draws the arrowhead. The focus variant
// redraws the lit rows' segments over everything, with quads enlarged for their glow. The shaded
// variants call an application's `shade` for each pixel.

import package::lib::types::{ARROWS, PATH_TRACE};
import package::lib::path::PATH;
import package::lib::bind::{frame, mark, eye};
import package::lib::project::{to_clip, nearer, culled};
import package::lib::path::{
    segment, segment_screen, stroke_style, ends_part, path_count, path_length, path_position,
};
import package::lib::hooks::{MarkerColor, ShadeFragment};
import package::lib::marker::glow;
import package::lib::shade::shade_fragment;
import package::lib::focus::focus_of;
import package::lib::mark::{coverage, fringe, px_per_length};
import package::lib::stroke::{Stroke, gap, stroke_paint, painted, stroke_distance};
import package::lib::daylight::daylight;
import package::lib::color::{output, OPAQUE};
import package::lib::lists::list_total;

// A scene whose dash and flow expressions are constant zero needs no phase or comet payload.
// Changing either expression requests the corresponding specialized program.
override PAINTED: bool = true;

struct Varyings {
    // The corner in clip space. In the fragment, the target pixel, which `pixel` reads. Invariant,
    // so the opaque pass and the other draws compute the same depth.
    @invariant @builtin(position) clip: vec4f,
    // Pack related values into complete varying slots; WebGL drivers may reserve a whole slot
    // even for a scalar. Both endpoints share one slot, and arrow/focus bits share another.
    @location(0) @interpolate(flat) ends: vec4f,
    @location(1) color: vec4f,
    // Width, distance along at `a` and at `b` in CSS pixels, and flow.
    @location(2) @interpolate(flat) style: vec4f,
    // x: bit 0 is an arrowhead, bit 1 dashes. y: focus bits for the glow. z: the held row, whose
    // inputs a shade reads.
    @location(3) @interpolate(flat) bits: vec3u,
    // Distance along at `a` and at `b` in position units, and how far the row's comets have
    // traveled.
    @location(4) @interpolate(flat) comet: vec3f,
}

// Focused geometry stays specialized so normal draws do not pay for its extra list traversal.
@if(focused)
const LIT_DRAW: bool = true;
@if(!focused)
const LIT_DRAW: bool = false;

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    var out: Varyings;
    let lit = LIT_DRAW;
    if !LIT_DRAW {
        if (mark.per_row == NONE) & (instance >= list_total(mark.list)) {
            out.clip = culled();
            return out;
        }
    }
    let s = segment(instance);
    if LIT_DRAW {
        if (s.item >= mark.rows) | (s.index >= path_count(s.item)) {
            out.clip = culled();
            return out;
        }
    }
    // A stroke fades and scales with its row's tile.
    var style = stroke_style(s.row);
    style.color.a *= s.presence;
    style.width *= s.growth;
    let on = segment_screen(s);
    let ends = on.ends;
    if !style.shown | !on.shown {
        out.clip = culled();
        return out;
    }
    let ca = on.ca;
    let cb = on.cb;
    let a = on.a;
    let b = on.b;
    let width = style.width;
    let dir = normalize(b - a + vec2f(1e-6, 0.0));
    let normal = vec2f(-dir.y, dir.x);
    let arrow = (PATH != PATH_TRACE) & ((mark.flags & ARROWS) != 0u) & ends_part(s);
    let head = select(0.0, frame.arrow + width, arrow);
    let comets = select(0.0, 0.5 * frame.flow_width, PAINTED & (style.flow != 0.0) & (frame.flow.a > 0.0));
    let reach = max(0.5 * width, comets) + head + select(0.0, frame.glow, lit) + fringe();
    let t = f32(corner & 1u);
    let side = f32(corner >> 1u) * 2.0 - 1.0;
    let screen = mix(a - dir * reach, b + dir * reach, t) + normal * side * reach;
    out.clip = nearer(to_clip(screen, select(ca, cb, t > 0.5)));
    out.ends = vec4f(a, b);
    // This corner's fraction along the whole segment, at the start or end of the drawn part.
    let f = mix(on.kept.x, on.kept.y, t);
    var color = style.color;
    if style.blends {
        color *= mix(ends.a.color, ends.b.color, f);
    }
    let light = daylight(mix(path_position(ends.a).xy, path_position(ends.b).xy, f));
    out.color = vec4f(color.rgb * light, color.a);
    // In position units, a segment's distance along starts where its list says (0 without a list),
    // and its ends stop short where the stroke does. On screen, a trace measures along x, a listed
    // path converts its distance along to pixels, and any other segment starts at 0.
    var along = vec2f(0.0);
    var phase = vec2f(0.0);
    if PAINTED {
        if style.dash | (style.flow != 0.0) {
            along = s.along + path_length(ends.a, ends.b) * on.kept;
            let pixels = length(b - a);
            phase = vec2f(0.0, pixels);
            if PATH == PATH_TRACE {
                phase = vec2f(a.x, a.x + pixels);
            } else if mark.per_row == NONE {
                phase = along * px_per_length();
            }
        }
    }
    out.style = vec4f(width, phase, select(0.0, style.flow, PAINTED));
    out.comet = vec3f(along, select(0.0, style.travel, PAINTED));
    out.bits.x = u32(arrow) | (u32(PAINTED & style.dash) << 1u);
    if lit { out.bits.y = focus_of(s.row); }
    out.bits.z = s.row;
    return out;
}

// The fragment's position in CSS pixels, in the same screen space as `a` and `b`. It comes from the
// fragment's own position, never an interpolated value. Interpolation skews across a quad whose
// ends lie at very different depths, and a renderer that clips the quad at the screen's edge (as
// lavapipe does) shifts it.
fn pixel(v: Varyings) -> vec2f {
    return v.clip.xy / eye.pixel_ratio;
}

fn segment_of(v: Varyings) -> Stroke {
    // A select, not `&`: Metal can write this inline in the struct's brace initializer, where
    // C++'s int result of `bool & bool` does not narrow back to bool.
    let arrow = select(false, (v.bits.x & 1u) != 0u, PATH != PATH_TRACE);
    if !PAINTED {
        return Stroke(v.ends.xy, v.ends.zw, vec2f(0.0), vec2f(0.0), v.style.x, v.color, 0.0, 0.0, false, arrow);
    }
    let dash = (v.bits.x & 2u) != 0u;
    return Stroke(v.ends.xy, v.ends.zw, v.style.yz, v.comet.xy, v.style.x, v.color, v.style.w, v.comet.z, dash, arrow);
}

// Where depth varies, a mark draws twice with this one program: first the pixels an opaque row's
// line covers fully, outside dash gaps, keeping their depth, through the copy of its uniform whose
// `opaque` is set, then every pixel. Antialiased edges, lines too thin to cover a pixel, and
// translucent rows (dimmed by a selection, fading, or of a translucent color) draw in the second
// pass, over the opaque pixels.
fn fragment_color(v: Varyings, opaque: bool) -> vec4f {
    let s = segment_of(v);
    // The opaque test, color, and focus glow all use this same distance. Evaluating it once
    // avoids repeating the segment projection and arrowhead geometry for each covered pixel.
    let d = stroke_distance(pixel(v), s);
    @if(!shaded) {
        if LIT_DRAW {
            let color = stroke_paint(d, s);
            let straight = vec4f(color.rgb / max(color.a, 1e-6), color.a);
            return output(glow(MarkerColor(straight, d.x), v.bits.y));
        }
        if opaque & ((s.color.a < OPAQUE) | (coverage(d.x) < 1.0) | gap(d, s)) {
            discard;
        }
        return output(painted(stroke_paint(d, s)));
    }
    @if(shaded) {
        // The shade sees the painted color, straight, and may change its alpha, which the opaque
        // test then reads.
        let color = stroke_paint(d, s);
        let straight = shade(stroke_fragment(vec4f(color.rgb / max(color.a, 1e-6), color.a), v, s));
        if LIT_DRAW {
            return output(glow(MarkerColor(straight, d.x), v.bits.y));
        }
        if opaque & (straight.a < OPAQUE) {
            discard;
        }
        return output(painted(vec4f(straight.rgb * straight.a, straight.a)));
    }
}

// The pixel of segment `s` that `v` draws, colored `color` (straight), as the mark's shade sees it:
// along the segment from its start, and across from its middle.
@if(shaded)
fn stroke_fragment(color: vec4f, v: Varyings, s: Stroke) -> ShadeFragment {
    let dir = normalize(s.b - s.a + vec2f(1e-6, 0.0));
    let q = pixel(v) - s.a;
    return shade_fragment(color, v.clip.xy, vec2f(dot(q, dir), dot(q, vec2f(-dir.y, dir.x))), v.bits.z);
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    return fragment_color(v, !LIT_DRAW & (mark.opaque != 0u));
}
