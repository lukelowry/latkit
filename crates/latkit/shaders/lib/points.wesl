// Points: where a vertex row's marker stands, how large, and in what color. Draws, casts, probes,
// and bounds all read a point through `point`.

import package::lib::types::{
    NONE, VISIBLE, PINNED, PLACED, SIZED, STATUS, VERTEX_HALF, VERTEX_WORDS, SIDE_LEFT, SIDE_RIGHT, SIDE_TOP,
    PORT_WORDS, PORT_CODE, PORT_SHAPE, PORT_SIZE, HALF_UNITS, OWN_HEIGHT,
};
import package::lib::bind::{frame, eye, mark, program};
import package::lib::state::{vertex_slot, resolved, Vertex};
import package::lib::project::{project, world, facing, to_screen};
import package::lib::focus::{is_hovered, faded};
import package::lib::mark::px;

struct Point {
    clip: vec4f,
    world: vec3f,
    // Half the marker's width and height, CSS pixels.
    half: vec2f,
    color: vec4f,
    status: vec4f,
    row: u32,
    shown: bool,
}

fn placed(v: Vertex) -> bool {
    return (v.flags & (PINNED | PLACED)) != 0u;
}

// The marker of row `row` of the current vertex mark.
fn point(row: u32) -> Point {
    let slot = mark.state / VERTEX_WORDS + row;
    let v = vertex_slot(slot);
    var half = vec2f(px(v.half.x, VERTEX_HALF));
    if (mark.flags & SIZED) != 0u {
        half.y = px(v.half.y, VERTEX_HALF + 1u);
    }
    half *= select(1.0, frame.hover_scale, is_hovered(row));
    let color = unpack4x8unorm(v.color);
    var p: Point;
    p.world = world(v.hi, v.lo, v.elevation);
    p.clip = project(v.hi, v.lo, v.elevation);
    p.half = max(half, vec2f(0.0));
    p.color = vec4f(color.rgb, color.a * faded(row, v.flags));
    p.status = unpack4x8unorm(v.status);
    p.row = row;
    // A row inside a group folded all the way shows as the group.
    p.shown = (v.flags & VISIBLE) != 0u && placed(v) && facing(v.hi, v.lo) && p.clip.w > 0.0 && resolved(slot) == slot;
    return p;
}

// Half the marker of the vertex in any slot, CSS pixels: its flags say whether its size is in
// position units and whether it has its own height.
fn vertex_half(v: Vertex) -> vec2f {
    var half = vec2f(v.half.x, select(v.half.x, v.half.y, (v.flags & OWN_HEIGHT) != 0u));
    if (v.flags & HALF_UNITS) != 0u {
        half *= eye.px_per_unit.x;
    }
    return half;
}

// Where a port sits on a marker of half size `half`, CSS pixels from its center, y down: its side in
// the code's low two bits, then its place among the ports on that side and how many share it.
fn port_place(half: vec2f, code: u32) -> vec2f {
    let along = (f32((code >> 2u) & 255u) + 1.0) / (f32((code >> 10u) & 255u) + 1.0) * 2.0 - 1.0;
    switch code & 3u {
        case SIDE_LEFT: { return vec2f(-half.x, along * half.y); }
        case SIDE_RIGHT: { return vec2f(half.x, along * half.y); }
        case SIDE_TOP: { return vec2f(along * half.x, -half.y); }
        default: { return vec2f(along * half.x, half.y); }
    }
}

struct Port {
    center: vec2f,
    // Half its size, CSS pixels: never past a quarter of its marker's shorter side, so a small
    // marker still shows under its ports.
    half: f32,
    shape: u32,
}

// Port `k` of the current vertex mark on point `p`'s marker, on screen.
fn port_at(p: Point, k: u32) -> Port {
    let info = mark.port_info + k * PORT_WORDS;
    let center = to_screen(p.clip) + port_place(p.half, program[info + PORT_CODE]);
    let half = min(0.5 * PORT_SIZE, 0.5 * min(p.half.x, p.half.y));
    return Port(center, half, program[info + PORT_SHAPE]);
}

// CSS pixels a point's quad reaches past its center: the marker, its status ring, and its glow.
fn reach(p: Point) -> vec2f {
    let ring = select(0.0, 3.0, (mark.flags & STATUS) != 0u);
    return p.half + ring + frame.glow + 1.0;
}
