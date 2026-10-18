// What marks draw, measured for fitting: the least and greatest x, y, and z of each mark's shown
// instances in position units, as ordered words, through the same geometry the draws use: a vertex
// as its box, a stroke as its points, an area as its triangles' corners. While a fit measures chosen
// rows, only rows marked FIT count.

import package::lib::types::{NONE, FIT, PATH_ENDS, PATH_GEOMETRY, EXTENT_WORDS, VERTEX_POSITION, HALF_UNITS};
import package::lib::bind::{frame, eye, mark, state};
import package::lib::focus::focus_of;
import package::lib::reduce::ordered;
import package::lib::state::{row_at, vertex_at};
import package::lib::points::{placed, vertex_half};
import package::lib::path::{PATH, segment, segment_ends, stroke_style, stroke_instances};
import package::lib::triangles::{triangle_corner, triangle_row, triangle_instances};

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
    if id.x >= mark.rows || !counted(id.x) {
        return;
    }
    let v = vertex_at(row_at(id.x));
    if (v.flags & 1u) == 0u || !placed(v) {
        return;
    }
    // A marker sized in units is part of the box. One sized in pixels is that size at any zoom, so
    // it counts as its position, and the fit's padding holds its pixels: measured at the zoom shown,
    // its pixels would stand for any number of units.
    let units = (v.flags & HALF_UNITS) != 0u;
    let half = select(vec2f(0.0), vertex_half(v) / eye.px_per_unit.x, units);
    let p = v.hi + v.lo;
    extend(vec3f(p - half, v.elevation));
    extend(vec3f(p + half, v.elevation));
}

@compute @workgroup_size(256)
fn strokes(@builtin(global_invocation_id) id: vec3u) {
    if PATH == PATH_ENDS || id.x >= stroke_instances() {
        return;
    }
    let s = segment(id.x);
    if s.row >= mark.rows || !counted(s.row) || !stroke_style(s.row).shown {
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
    if PATH != PATH_GEOMETRY || id.x >= triangle_instances() {
        return;
    }
    let row = triangle_row(id.x);
    if row >= mark.rows || !counted(row) {
        return;
    }
    for (var k = 0u; k < 3u; k++) {
        let c = triangle_corner(id.x, k);
        if c.shown {
            extend(c.position);
        }
    }
}
