// Extents for fitting: the least and greatest x, y, and z of each mark's shown instances, in
// position units, and the widest margin its markers keep in CSS pixels, as order-preserving words.
// It uses the same geometry as the draws: a vertex's box, a stroke's points, and an area's triangle
// corners. While a fit measures chosen rows, only rows marked `FIT` count. A record is eight words,
// written by two draws of one color target each: `params.value` 0 writes the least x, y, and z and
// the greatest x, and 1 the greatest y and z and the margin.

import package::lib::types::{
    NONE, FIT, PATH_ENDS, PATH_BENDS, PATH_TRACE, PATH_GEOMETRY, EXTENT_WORDS, VERTEX_POSITION, HALF_UNITS, OWN_HEIGHT, WordStep, SCAN_BLOCK,
};
import package::lib::bind::{frame, mark};
import package::lib::focus::focus_of;
import package::lib::reduce::ordered;
import package::lib::state::{row_at, vertex_at};
import package::lib::points::{placed, vertex_half};
import package::lib::path::{PATH, segment, segment_ends, stroke_style, stroke_instances, path_position};
import package::lib::triangles::{area_source, area_bits, triangle_instances};
import package::lib::drawn::held_row;
import package::lib::trace::{trace_cursor, trace_read};
import package::lib::read::missing_bits;

import package::lib::words::{fullscreen, word_index};
@group(2) @binding(19) var<uniform> params: WordStep;
var<private> least: vec3u;
var<private> most: vec3u;
var<private> margin: u32;
@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return fullscreen(i); }
fn output() -> vec4u {
    if params.value == 0u { return vec4u(least, most.x); }
    return vec4u(most.yz, margin, 0u);
}

fn extend(p: vec3f) {
    let order = vec3u(ordered(p.x), ordered(p.y), ordered(p.z));
    least = max(least, ~order);
    most = max(most, order);
}

fn counted(row: u32) -> bool {
    return frame.fitting == 0u || (focus_of(row) & FIT) != 0u;
}

fn point(i: u32) {
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
    margin = max(margin, ordered(select(max(pixels.x, pixels.y), v.range.x, units)));
}

fn trace_position(sample: vec3u) {
    if !missing_bits(sample.z) {
        extend(vec3f(bitcast<f32>(sample.x) + bitcast<f32>(sample.y), bitcast<f32>(sample.z), 0.0));
    }
}

// Bounds are order-independent. Adjacent invocations read adjacent rows of a sample page,
// and each visible point contributes once rather than once for each adjoining segment.
fn trace(i: u32) {
    if i >= mark.rows * mark.per_row || mark.rows == 0u { return; }
    let row = held_row(i % mark.rows);
    if !counted(row) || !stroke_style(row).shown { return; }
    let point = i / mark.rows;
    let cursor = trace_cursor(row);
    trace_position(trace_read(cursor, point));
    if point + 1u == mark.per_row { trace_position(trace_read(cursor, point + 1u)); }
}

fn stroke(i: u32) {
    if PATH == PATH_TRACE { trace(i); return; }
    // Keep constant exits separate from runtime tests so unreachable geometry is removed
    // before translation, rather than leaving the driver to simplify a short-circuit branch.
    if PATH == PATH_ENDS { return; }
    if PATH == PATH_BENDS { return; }
    if i >= stroke_instances() { return; }
    let s = segment(i);
    if s.item >= mark.rows || !counted(s.row) || !stroke_style(s.row).shown {
        return;
    }
    let ends = segment_ends(s);
    if ends.a.shown { extend(path_position(ends.a)); }
    if ends.b.shown { extend(path_position(ends.b)); }
}

fn area(i: u32) {
    if PATH != PATH_GEOMETRY { return; }
    if i >= triangle_instances() { return; }
    let s = segment(i);
    if s.item >= mark.rows || !counted(s.row) {
        return;
    }
    let source = area_source(s.row);
    for (var k = 0u; k < 3u; k++) {
        let p = area_bits(source, 3u * s.index + 1u + k);
        if !missing_bits(p.x) && !missing_bits(p.y) {
            extend(vec3f(bitcast<vec2f>(p), 0.0));
        }
    }
}

@fragment
fn points(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let record = (word_index(position, params.layer) - params.destination) / 4u;
    let records = (params.count + SCAN_BLOCK - 1u) / SCAN_BLOCK;
    if record >= records { return output(); }
    for (var i = record + params.source; i < params.count; i += records) { point(i); }
    return output();
}

@fragment
fn strokes(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let record = (word_index(position, params.layer) - params.destination) / 4u;
    let records = (params.count + SCAN_BLOCK - 1u) / SCAN_BLOCK;
    if record >= records { return output(); }
    for (var i = record + params.source; i < params.count; i += records) { stroke(i); }
    return output();
}

@fragment
fn areas(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let record = (word_index(position, params.layer) - params.destination) / 4u;
    let records = (params.count + SCAN_BLOCK - 1u) / SCAN_BLOCK;
    if record >= records { return output(); }
    for (var i = record + params.source; i < params.count; i += records) { area(i); }
    return output();
}
