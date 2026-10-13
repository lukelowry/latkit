// The extent of a vertex mark's placed, visible rows in position units: four ordered words per mark,
// least x and y as complements, then greatest x and y. Frames fits to them.

import package::lib::types::{VISIBLE, PINNED, PLACED, VERTEX_POSITION, VERTEX_FLAGS};
import package::lib::bind::{mark, state};
import package::lib::reduce::ordered;

@group(2) @binding(2) var<storage, read_write> extents: array<atomic<u32>>;

@compute @workgroup_size(256)
fn bounds(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= mark.rows {
        return;
    }
    let at = mark.state + id.x * mark.stride;
    let flags = state[at + VERTEX_FLAGS];
    if (flags & VISIBLE) == 0u || (flags & (PINNED | PLACED)) == 0u {
        return;
    }
    let p = at + VERTEX_POSITION;
    let x = bitcast<f32>(state[p]) + bitcast<f32>(state[p + 2u]);
    let y = bitcast<f32>(state[p + 1u]) + bitcast<f32>(state[p + 3u]);
    let e = 4u * mark.index;
    atomicMax(&extents[e], ~ordered(x));
    atomicMax(&extents[e + 1u], ~ordered(y));
    atomicMax(&extents[e + 2u], ordered(x));
    atomicMax(&extents[e + 3u], ordered(y));
}
