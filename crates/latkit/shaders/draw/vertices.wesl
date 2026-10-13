// Vertices: one instanced quad per row, shaded by its marker.

import package::lib::types::{
    NONE, VISIBLE, PINNED, PLACED, SIZED, VERTEX_POSITION, VERTEX_COLOR, VERTEX_HALF, VERTEX_ELEVATION,
};
import package::lib::bind::{frame, mark};
import package::lib::state::{row_at, vertex_at};
import package::lib::project::{project, to_screen, to_clip, nearer, facing, culled};
import package::lib::focus::{is_hovered, faded};
import package::lib::motion::{previous_row, previous_word, previous_float, ease_color, ease, ease_offset};
import package::lib::marker::{MarkerColor, MarkerFragment, builtin_marker, glow, shadow};
import package::lib::color::output;
import package::lib::mark::px;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) p: vec2f,
    @location(1) @interpolate(flat) row: u32,
    @location(2) color: vec4f,
    @location(3) @interpolate(flat) half: vec2f,
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) row: u32) -> Varyings {
    let v = vertex_at(row_at(row));
    var hi = v.hi;
    var half = vec2f(px(v.half.x, VERTEX_HALF), px(v.half.x, VERTEX_HALF));
    if (mark.flags & SIZED) != 0u {
        half.y = px(v.half.y, VERTEX_HALF + 1u);
    }
    var color = unpack4x8unorm(v.color);
    let was = previous_row(row);
    if was != NONE {
        let was_hi = vec2f(previous_float(was, VERTEX_POSITION), previous_float(was, VERTEX_POSITION + 1u));
        let was_lo = vec2f(previous_float(was, VERTEX_POSITION + 2u), previous_float(was, VERTEX_POSITION + 3u));
        hi += ease_offset(was_hi, was_lo, v.hi, v.lo);
        half.x = ease(px(previous_float(was, VERTEX_HALF), VERTEX_HALF), half.x);
        half.y = ease(select(half.x, px(previous_float(was, VERTEX_HALF + 1u), VERTEX_HALF + 1u), (mark.flags & SIZED) != 0u), half.y);
        color = ease_color(previous_word(was, VERTEX_COLOR), v.color);
    } else if mark.previous != NONE {
        half *= mark.motion;
    }
    half *= select(1.0, frame.hover_scale, is_hovered(row));
    let anchor = project(hi, v.lo, v.elevation);
    let reach = half + frame.glow + 1.0;
    let quad = vec2f(f32(corner & 1u), f32(corner >> 1u)) * 2.0 - 1.0;
    var out: Varyings;
    out.clip = nearer(to_clip(to_screen(anchor) + quad * reach, anchor));
    out.p = quad * reach * vec2f(1.0, -1.0);
    out.row = row;
    out.color = vec4f(color.rgb, color.a * faded(row));
    out.half = max(half, vec2f(0.5));
    let placed = (v.flags & (PINNED | PLACED)) != 0u;
    if (v.flags & VISIBLE) == 0u || !placed || !facing(v.hi, v.lo) || anchor.w <= 0.0 {
        out.clip = culled();
    }
    return out;
}

@if(!custom)
fn marker(f: MarkerFragment) -> MarkerColor {
    return builtin_marker(f);
}

fn shaded(v: Varyings) -> MarkerColor {
    return marker(MarkerFragment(v.p, v.half, v.color, array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)));
}

@if(!shadow)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    return output(glow(shaded(v), v.row));
}

@if(shadow)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    return output(shadow(shaded(v)));
}
