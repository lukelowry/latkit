// Strokes: one instanced quad per segment of every row's path, for edges and lines alike. A quad
// covers the stroke, any arrowhead, and one pixel of antialiased edge. Where a path runs on through
// a segment's end, its quad stops a pixel past the line splitting that end with the next segment.
// The last segment of each part of a path draws the arrowhead. A mark's comets draw after its rows,
// through the copy of its uniform for `DRAW_COMETS`, each segment's quad spanning only the comets on
// it this frame, so comets cost the pixels they cover. A segment no comet reaches draws nothing.
// The focus variant redraws the lit rows' segments over everything, comets included, with quads
// enlarged for their glow. The shaded variants call an application's `shade` for each pixel.

import package::lib::types::{ARROWS, PATH_TRACE, ALONG_UNITS, DRAW_OPAQUE, DRAW_COMETS};
import package::lib::path::PATH;
import package::lib::bind::{frame, mark, eye};
import package::lib::project::{to_clip, nearer, culled};
import package::lib::path::{
    segment, segment_points, on_screen, stroke_style, ends_part, path_count, path_length, path_total,
    path_position, marker_reach,
};
import package::lib::hooks::{MarkerColor, ShadeFragment};
import package::lib::marker::glow;
import package::lib::shade::shade_fragment;
import package::lib::focus::focus_of;
import package::lib::mark::{coverage, fringe, px_per_length};
import package::lib::stroke::{Stroke, gap, stroke_paint, painted, stroke_distance, owns, rims, comets_on, COMET_RIM};
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
    // x: bit 0 is an arrowhead, bit 1 dashes, bits 2 and 3 a shared end at `a` and at `b`, bit 4
    // comets with a rim. y: focus bits for the glow. z: the held row, whose inputs a shade reads.
    @location(3) @interpolate(flat) bits: vec3u,
    // Distance along at `a` and at `b` in position units, how far the row's comets have traveled,
    // and how far past `b` its arrowhead lies (see `Stroke`).
    @location(4) @interpolate(flat) comet: vec4f,
    // The normals of the lines splitting the pixels at `a` and at `b` with the segments beyond (see
    // `Joints`).
    @location(5) @interpolate(flat) split: vec4f,
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
    let points = segment_points(s);
    let on = on_screen(points);
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
    // A segment shorter than half a pixel on screen, such as one between vertices at one place,
    // points nowhere, so it has no head.
    let arrow = (PATH != PATH_TRACE) & ((mark.flags & ARROWS) != 0u) & ends_part(s) & (length(b - a) >= 0.5);
    let flows = PAINTED & (style.flow != 0.0) & (frame.flow.a > 0.0);
    // The comets draw paints only comets, and the lit draw paints them with its rows. Rows paint none.
    let comets_draw = !LIT_DRAW & (mark.draw == DRAW_COMETS);
    if comets_draw & !flows {
        out.clip = culled();
        return out;
    }
    let comets = select(0.0, 0.5 * max(frame.flow_width, width) + COMET_RIM, flows & (lit | comets_draw));
    // How far the stroke, its comets, and any glow reach from its middle. An arrowhead reaches
    // further, but comets never cover one.
    let across = select(max(0.5 * width, comets), comets, comets_draw) + select(0.0, frame.glow, lit) + fringe();
    let reach = across + select(0.0, frame.arrow + width, arrow & !comets_draw);
    // A segment's distance along ends where its list says, so it starts its own length before (at 0
    // without a list), and its drawn part covers part of the path's segment it draws or runs
    // beside: in position units, `kept` of its length between its points, else in CSS pixels,
    // `visible` of its `chord` on screen, which is what its list measured. A fan stands for an end
    // of that segment (see `on_screen`). The list gives a fan no length, so a fan into the first
    // vertex starts at 0, and one into the last, listed after its path, starts a segment back. A
    // trace measures along x on screen. Comets in position units place themselves by `along`, and
    // everything else by `phase`, in CSS pixels: where the mark measures in units, a dash converts
    // `along` at the camera's center. Where comets flow toward an arrowhead, `tip` is how far past
    // `b` the head's tip lies: 0 on its own segment, and before it, the rest of the path less the
    // farthest its marker reaches.
    var along = vec2f(0.0);
    var phase = vec2f(0.0);
    var tip = select(-1.0, 0.0, arrow);
    if PAINTED {
        if style.dash | (style.flow != 0.0) {
            let pixels = length(b - a);
            let units = (mark.flags & ALONG_UNITS) != 0u;
            let listed = mark.per_row == NONE;
            let span = select(on.chord, path_length(ends.a, ends.b), units);
            let start = select(0.0, s.along - select(span, 0.0, on.fan == 1u), listed);
            along = start + span * select(on.visible, on.kept, units);
            phase = select(along, along * px_per_length(), units);
            if PATH == PATH_TRACE {
                phase = vec2f(a.x, a.x + pixels);
            }
            if flows & listed & !arrow & ((mark.flags & ARROWS) != 0u) {
                let px = select(1.0, pixels / max(abs(along.y - along.x), 1e-12), units);
                tip = max((path_total(s.item) - along.y) * px - marker_reach(points.vertex_b), 0.0);
            }
        }
    }
    // Comets move on from where their row's travel was last written, at its flow.
    let travel = select(0.0, style.travel + style.flow * frame.flow_time, PAINTED);
    // Where the path runs on through an end, this segment shares that end's pixels with the next
    // (see `Joints`), unless the turn there is too sharp for the two segments' lengths. Its quad then
    // stops a pixel past the split line, except behind an arrowhead's segment, where the head's base
    // can reach. The comets draw's quad spans only the comets on the segment, as fractions of it: it
    // reaches past an end as the rows' does only where a comet does.
    let joints = on.joints;
    let shares = joints.through & (joints.turn * across <= joints.room);
    let past = select(vec2f(reach), across * joints.turn + fringe(), shares & vec2<bool>(arrow & !comets_draw, true));
    var span = vec2f(0.0, 1.0);
    if comets_draw {
        let units = (mark.flags & ALONG_UNITS) != 0u;
        let c = select(phase, along, units);
        let px = select(1.0, length(b - a) / max(abs(c.y - c.x), 1e-12), units);
        let on_it = comets_on(c, px, travel, style.flow, comets + fringe());
        if on_it.z == 0.0 {
            out.clip = culled();
            return out;
        }
        span = on_it.xy;
    }
    let t = f32(corner & 1u);
    let side = f32(corner >> 1u) * 2.0 - 1.0;
    let start = a - dir * past.x;
    let end_a = select(mix(a, b, span.x), start, span.x <= 0.0);
    let end_b = select(mix(a, b, span.y), b + dir * past.y, span.y >= 1.0);
    let line = mix(end_a, end_b, t);
    let screen = line + normal * side * reach;
    // A comets quad takes the depth the rows' quad has where its corner lies, so comets meet their
    // own line's depth, and stand a hair in front of it against rounding.
    let u = dot(line - start, dir) / max(length(b - a) + past.x + past.y, 1e-6);
    let w = mix(ca.w, cb.w, u);
    let depth = mix(ca.z / ca.w, cb.z / cb.w, u) * w;
    let at = select(select(ca, cb, t > 0.5), vec4f(0.0, 0.0, min(depth * 1.0005, w), w), comets_draw);
    out.clip = nearer(to_clip(screen, at));
    out.ends = vec4f(a, b);
    // This corner's fraction along the whole segment, at the start or end of the drawn part.
    let f = mix(on.kept.x, on.kept.y, mix(span.x, span.y, t));
    var color = style.color;
    if style.blends {
        color *= mix(ends.a.color, ends.b.color, f);
    }
    let light = daylight(mix(path_position(ends.a).xy, path_position(ends.b).xy, f));
    out.color = vec4f(color.rgb * light, color.a);
    out.style = vec4f(width, phase, select(0.0, style.flow, PAINTED));
    out.comet = vec4f(along, travel, tip);
    out.split = joints.split;
    let rim = flows & rims(color.rgb);
    out.bits.x = u32(arrow) | (u32(PAINTED & style.dash) << 1u) | (u32(shares.x) << 2u) | (u32(shares.y) << 3u)
        | (u32(rim) << 4u);
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
    let shares = vec2<bool>((v.bits.x & 4u) != 0u, (v.bits.x & 8u) != 0u);
    if !PAINTED {
        return Stroke(v.ends.xy, v.ends.zw, vec2f(0.0), vec2f(0.0), v.style.x, v.color, 0.0, 0.0, false, arrow, v.split, shares, false, -1.0);
    }
    let dash = (v.bits.x & 2u) != 0u;
    let rim = (v.bits.x & 16u) != 0u;
    return Stroke(v.ends.xy, v.ends.zw, v.style.yz, v.comet.xy, v.style.x, v.color, v.style.w, v.comet.z, dash, arrow, v.split, shares, rim, v.comet.w);
}

// Where depth varies, a mark draws twice with this one program: first the pixels an opaque row's
// line covers fully, outside dash gaps, keeping their depth, through the copy of its uniform for
// `DRAW_OPAQUE`, then every pixel. Antialiased edges, lines too thin to cover a pixel, and
// translucent rows (dimmed by a selection, fading, or of a translucent color) draw in the second
// pass, over the opaque pixels. Comets draw after the rows, through the copy for `DRAW_COMETS`: on
// their own lines' depth, and wherever nothing nearer was drawn. The lit draw paints rows and
// comets at once.
fn fragment_color(v: Varyings, opaque: bool) -> vec4f {
    let s = segment_of(v);
    let p = pixel(v);
    // Past a shared end, the segment beyond draws the line (see `owns`). Only an arrowhead is drawn
    // whole, by its own segment.
    if !s.arrow & !owns(p, s) {
        discard;
    }
    // The opaque test, color, and focus glow all use this same distance. Evaluating it once
    // avoids repeating the segment projection and arrowhead geometry for each covered pixel.
    let d = stroke_distance(p, s);
    let comets = !LIT_DRAW & (mark.draw == DRAW_COMETS);
    let color = stroke_paint(d, s, !comets, LIT_DRAW | comets);
    if comets & (color.a <= 0.0) {
        discard;
    }
    @if(!shaded) {
        if LIT_DRAW {
            let straight = vec4f(color.rgb / max(color.a, 1e-6), color.a);
            return output(glow(MarkerColor(straight, d.x), v.bits.y));
        }
        if opaque & ((s.color.a < OPAQUE) | (coverage(d.x) < 1.0) | gap(d, s)) {
            discard;
        }
        return output(painted(color));
    }
    @if(shaded) {
        // The shade sees the painted color, straight, and may change its alpha, which the opaque
        // test then reads.
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
    return fragment_color(v, !LIT_DRAW & (mark.draw == DRAW_OPAQUE));
}
