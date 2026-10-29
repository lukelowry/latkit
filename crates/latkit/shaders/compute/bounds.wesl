// Extents for fitting: the least and greatest x, y, and z of each mark's shown instances, in
// position units, and the widest margin its markers keep in CSS pixels, as order-preserving words.
// It uses the same geometry as the draws: a vertex's box, a stroke's points, and an area's triangle
// corners. While a fit measures chosen rows, only rows marked `FIT` count.

import package::lib::types::{
    NONE, FIT, PATH_ENDS, PATH_GEOMETRY, EXTENT_WORDS, VERTEX_POSITION, HALF_UNITS, OWN_HEIGHT, item,
};
import package::lib::bind::{frame, mark};
import package::lib::focus::focus_of;
import package::lib::reduce::ordered;
import package::lib::state::{row_at, vertex_at};
import package::lib::points::{placed, vertex_half};
import package::lib::path::{PATH, segment, segment_ends, stroke_style, stroke_instances};
import package::lib::triangles::{triangle_corner, triangle_instances};
import package::lib::drawn::held_row;

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

fn counted(row: u32) -> bool {
    return frame.fitting == 0u || (focus_of(row) & FIT) != 0u;
}

@compute @workgroup_size(256)
fn points(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.rows {
        return;
    }
    let row = held_row(i);
    if !counted(row) {
        return;
    }
    let v = vertex_at(row_at(row));
    if (v.flags & 1u) == 0u || !placed(v) {
        return;
    }
    // A marker sized in units is part of the box at its size in units. Pixels hold at any zoom, so
    // a marker sized in pixels and a marker's least size in pixels widen the margin instead.
    // Measured at the current zoom, pixels could correspond to any number of units.
    let units = (v.flags & HALF_UNITS) != 0u;
    let own = vec2f(v.half.x, select(v.half.x, v.half.y, (v.flags & OWN_HEIGHT) != 0u));
    let half = select(vec2f(0.0), own, units);
    let p = v.hi + v.lo;
    extend(vec3f(p - half, v.elevation));
    extend(vec3f(p + half, v.elevation));
    let pixels = vertex_half(v);
    atomicMax(&extents[EXTENT_WORDS * mark.index + 6u], ordered(select(max(pixels.x, pixels.y), v.range.x, units)));
}

@compute @workgroup_size(256)
fn strokes(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if PATH == PATH_ENDS || i >= stroke_instances() {
        return;
    }
    let s = segment(i);
    if s.item >= mark.rows || !counted(s.row) || !stroke_style(s.row).shown {
        return;
    }
    let ends = segment_ends(s);
    for (var i = 0u; i < 2u; i++) {
        if ends[i].shown {
            extend(ends[i].position);
        }
    }
}

@compute @workgroup_size(256)
fn areas(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if PATH != PATH_GEOMETRY || i >= triangle_instances() {
        return;
    }
    let s = segment(i);
    if s.item >= mark.rows || !counted(s.row) {
        return;
    }
    for (var k = 0u; k < 3u; k++) {
        let c = triangle_corner(i, k);
        if c.shown {
            extend(c.position);
        }
    }
}
