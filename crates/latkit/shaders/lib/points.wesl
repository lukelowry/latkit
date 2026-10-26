// Points: a vertex row's marker position, size, and color. Draws, probes, bounds, and labels all
// read a point through `point`.

import package::lib::types::{
    NONE, VISIBLE, PLACED, SIZED, STATUS, SHADOW, HOVERED, VERTEX_HALF, VERTEX_WORDS, SIDE_LEFT, SIDE_RIGHT,
    SIDE_TOP, PORT_WORDS, PORT_CODE, PORT_SHAPE, PORT_COLUMN, HALF_UNITS, OWN_HEIGHT,
};
import package::lib::bind::{frame, mark, program};
import package::lib::state::{row_at, vertex_at, Vertex};
import package::lib::project::{world, clip_of, shows, to_screen};
import package::lib::focus::{focus_of, faded, growth};
import package::lib::read::bits_value;
import package::lib::mark::{px, px_per_length, fringe, within};
import package::lib::marker::{theme_port_size, theme_lift};
import package::lib::drawn::drawn_row;

struct Point {
    clip: vec4f,
    world: vec3f,
    // Its position, in position units.
    position: vec2f,
    // Half the marker's width and height, CSS pixels.
    half: vec2f,
    color: vec4f,
    status: vec4f,
    depth: f32,
    row: u32,
    // Its focus bits: selected, hovered, an end of a lit edge.
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
    var half = vec2f(px(v.half.x, VERTEX_HALF));
    if (mark.flags & SIZED) != 0u {
        half.y = px(v.half.y, VERTEX_HALF + 1u);
    }
    half = within(half, vec2f(mark.size_min, mark.size_max));
    let focus = focus_of(row);
    let grows = (mark.units & (1u << VERTEX_HALF)) == 0u && (focus & HOVERED) != 0u;
    half *= select(1.0, frame.grow, grows) * growth(v.flags);
    let color = unpack4x8unorm(v.color);
    var p: Point;
    p.world = world(v.hi, v.lo, v.elevation);
    p.position = v.hi + v.lo;
    p.clip = clip_of(p.world);
    p.half = max(half, vec2f(0.0));
    p.color = vec4f(color.rgb, color.a * faded(row, v.flags));
    p.status = unpack4x8unorm(v.status);
    p.depth = v.depth;
    p.row = row;
    p.focus = focus;
    p.shown = (v.flags & VISIBLE) != 0u && placed(v) && shows(p.world) && p.clip.w > 0.0;
    return p;
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

// A port's offset from the center of a marker of half size `half`, in CSS pixels with y down. The
// code holds the side in its low two bits, then the port's index on that side and the number of
// ports there.
fn port_place(half: vec2f, code: u32) -> vec2f {
    let along = (f32((code >> 2u) & 255u) + 1.0) / (f32((code >> 10u) & 255u) + 1.0) * 2.0 - 1.0;
    switch code & 3u {
        case SIDE_LEFT: { return vec2f(-half.x, along * half.y); }
        case SIDE_RIGHT: { return vec2f(half.x, along * half.y); }
        case SIDE_TOP: { return vec2f(along * half.x, -half.y); }
        default: { return vec2f(along * half.x, half.y); }
    }
}

// The unit direction from a port into its marker, y down.
fn port_inward(code: u32) -> vec2f {
    switch code & 3u {
        case SIDE_LEFT: { return vec2f(1.0, 0.0); }
        case SIDE_RIGHT: { return vec2f(-1.0, 0.0); }
        case SIDE_TOP: { return vec2f(0.0, 1.0); }
        default: { return vec2f(0.0, -1.0); }
    }
}

struct Port {
    center: vec2f,
    // Half its size in CSS pixels, at most a quarter of the marker's shorter side, so a small
    // marker still shows under its ports.
    half: f32,
    shape: u32,
    code: u32,
    // Whether its reference names a net. An unconnected port draws hollow.
    wired: bool,
}

// Port `k` of the current vertex mark on point `p`'s marker, on screen.
fn port_at(p: Point, k: u32) -> Port {
    let info = mark.port_info + k * PORT_WORDS;
    let code = program[info + PORT_CODE];
    let center = to_screen(p.clip) + port_place(p.half, code);
    let half = min(0.5 * theme_port_size(), 0.5 * min(p.half.x, p.half.y));
    let column = program[info + PORT_COLUMN];
    let wired = column != NONE && bits_value(column, p.row) != NONE;
    return Port(center, half, program[info + PORT_SHAPE], code, wired);
}

// How far a point's quad extends from its center, in CSS pixels. It covers the marker, its status
// ring or its shadow on a diagram's sheet, one target pixel of antialiased edge, and when `lit` (in
// the focus draw), its glow.
fn reach(p: Point, lit: bool) -> vec2f {
    let ring = select(0.0, 3.0 * frame.unit, (mark.flags & STATUS) != 0u && p.status.a > 0.0);
    let shadow = select(0.0, 2.0 * theme_lift(), (mark.flags & SHADOW) != 0u);
    return p.half + max(ring, shadow) + select(0.0, frame.glow, lit) + fringe();
}
