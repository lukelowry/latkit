// What marks draw, measured for fitting: the least and greatest x, y, and z of each mark's placed,
// visible rows in position units, as ordered words. While a fit measures chosen rows, only rows
// marked FIT count.

import package::lib::types::{
    VISIBLE, PINNED, PLACED, FIT, VERTEX_POSITION, VERTEX_ELEVATION, VERTEX_FLAGS, EXTENT_WORDS,
};
import package::lib::bind::{frame, mark, state};
import package::lib::focus::focus_of;
import package::lib::reduce::ordered;
import package::lib::read::missing_bits;
import package::lib::state::{row_at, line_at};
import package::lib::trace::{trace_first, trace_frames, trace_axis, trace_value};

@group(2) @binding(2) var<storage, read_write> extents: array<atomic<u32>>;

fn extend(p: vec3f) {
    let e = EXTENT_WORDS * mark.index;
    atomicMax(&extents[e], ~ordered(p.x));
    atomicMax(&extents[e + 1u], ~ordered(p.y));
    atomicMax(&extents[e + 2u], ~ordered(p.z));
    atomicMax(&extents[e + 3u], ordered(p.x));
    atomicMax(&extents[e + 4u], ordered(p.y));
    atomicMax(&extents[e + 5u], ordered(p.z));
}

@compute @workgroup_size(256)
fn vertices(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= mark.rows || (frame.fitting != 0u && (focus_of(id.x) & FIT) == 0u) {
        return;
    }
    let at = row_at(id.x);
    let flags = state[at + VERTEX_FLAGS];
    if (flags & VISIBLE) == 0u || (flags & (PINNED | PLACED)) == 0u {
        return;
    }
    let p = at + VERTEX_POSITION;
    let x = bitcast<f32>(state[p]) + bitcast<f32>(state[p + 2u]);
    let y = bitcast<f32>(state[p + 1u]) + bitcast<f32>(state[p + 3u]);
    extend(vec3f(x, y, bitcast<f32>(state[at + VERTEX_ELEVATION])));
}

@compute @workgroup_size(256)
fn traces(@builtin(global_invocation_id) id: vec3u) {
    let frames = trace_frames();
    if frames == 0u || id.x >= mark.rows * frames {
        return;
    }
    let row = id.x / frames;
    let index = trace_first() + id.x % frames;
    let value = trace_value(row, index);
    if (line_at(row_at(row)).flags & VISIBLE) == 0u || missing_bits(value) {
        return;
    }
    let x = trace_axis(index);
    extend(vec3f(x.x + x.y, bitcast<f32>(value), 0.0));
}
