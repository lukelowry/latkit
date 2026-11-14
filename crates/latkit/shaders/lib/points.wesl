// Points: a vertex row's marker position, size, and color. Draws, probes, bounds, and labels all
// read a point through `point`.

import package::lib::types::{VISIBLE, PLACED, SIZED, STATUS, HOVERED, VERTEX_HALF, HALF_UNITS, OWN_HEIGHT};
import package::lib::bind::{frame, mark};
import package::lib::state::{row_at, vertex_at, Vertex};
import package::lib::project::{world, clip_of, toward_eye, shows};
import package::lib::focus::{focus_of, faded, growth};
import package::lib::mark::{px, px_per_length, fringe, within};
import package::lib::drawn::drawn_row;

struct Point {
    clip: vec4f,
    // The depth its marker draws at, as clip z over w: its nearest side's, its radius toward the
    // camera, so where marks hide each other an edge meeting its center ends inside it.
    drawn_z: f32,
    world: vec3f,
    // Its position, in position units.
    position: vec2f,
    // Half the marker's width and height, CSS pixels.
    half: vec2f,
    color: vec4f,
    status: vec4f,
    row: u32,
    // Its focus bits: selected, hovered, or one reference from a lit row.
    focus: u32,
    shown: bool,
}

fn placed(v: Vertex) -> bool {
    return (v.flags & PLACED) != 0u;
}

// The marker of the current vertex mark's held row `row`. A hovered marker sized in pixels grows.
// One sized in units is part of the drawing, so it only glows.
fn point(row: u32) -> Point {
    let v = vertex_at(row_at(row));
    var p: Point;
    p.row = row;
    p.world = world(v.hi, v.lo, v.elevation);
    p.position = v.hi + v.lo;
    p.clip = clip_of(p.world);
    // Hidden rows keep their position for locating. Their marker, focus, and front depth draw
    // nothing, but are read anyway: a read no branch guards keeps the compiled shader small (see
    // `lib/read.wesl`).
    p.shown = ((v.flags & VISIBLE) != 0u) & placed(v) & shows(p.world) & (p.clip.w > 0.0);
    var half = vec2f(px(v.half.x, VERTEX_HALF));
    half.y = select(half.x, px(v.half.y, VERTEX_HALF + 1u), (mark.flags & SIZED) != 0u);
    half = within(half, vec2f(mark.size_min, mark.size_max));
    let focus = focus_of(row);
    let grows = ((mark.units & (1u << VERTEX_HALF)) == 0u) & ((focus & HOVERED) != 0u);
    half *= select(1.0, frame.grow, grows) * growth(v.flags);
    let color = unpack4x8unorm(v.color);
    let front = toward_eye(p.clip, p.world, max(half.x, half.y));
    p.drawn_z = front.z / front.w;
    p.half = max(half, vec2f(0.0));
    p.color = vec4f(color.rgb, color.a * faded(row, v.flags));
    p.status = unpack4x8unorm(v.status);
    p.focus = focus;
    return p;
}

// `p`'s clip position at the depth its marker draws at.
fn drawn_clip(p: Point) -> vec4f {
    return vec4f(p.clip.xy, p.drawn_z * p.clip.w, p.clip.w);
}

// The marker of drawn row `item`, faded and scaled while its tile fades in or out.
fn shown_point(item: u32) -> Point {
    let d = drawn_row(item);
    var p = point(d.row);
    p.color.a *= d.presence;
    p.half *= d.growth;
    return p;
}

// Half the size of a vertex's marker in CSS pixels, for a vertex of any mark. Its flags say whether
// its size is in position units and whether it has its own height.
fn vertex_half(v: Vertex) -> vec2f {
    var half = vec2f(v.half.x, select(v.half.x, v.half.y, (v.flags & OWN_HEIGHT) != 0u));
    if (v.flags & HALF_UNITS) != 0u {
        half *= px_per_length();
    }
    return within(half, v.range);
}

// How far a point's quad extends from its center, in CSS pixels. It covers the marker, its status
// ring, one target pixel of antialiased edge, and when `lit` (in the focus draw), its glow.
fn reach(p: Point, lit: bool) -> vec2f {
    let ring = select(0.0, 3.0, (mark.flags & STATUS) != 0u && p.status.a > 0.0);
    return p.half + ring + select(0.0, frame.glow, lit) + fringe();
}
