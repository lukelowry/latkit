// Stress: Jacobi rounds of sparse stress majorization over the vertices a layout places. Each vertex
// moves to where its terms would put it, weighted: its neighbors a gap away, and pivots at their
// graph distance. Pinned vertices stay where their data puts them, and hold the rest.
//
// The graph buffer holds a header (vertices, where terms start, where the two position arrays
// start), then each vertex's slot, place word, first term, and term count; then terms of a vertex,
// a distance, and a weight; then two arrays of positions the rounds pass between.

import package::lib::types::{PINNED, VERTEX_WORDS};
import package::lib::state::vertex_at;
import package::lib::places::{places, is_placed, place_word};

@group(2) @binding(17) var<storage, read_write> graph: array<u32>;

fn record(i: u32) -> vec4u {
    let at = 4u + 4u * i;
    return vec4u(graph[at], graph[at + 1u], graph[at + 2u], graph[at + 3u]);
}

// Vertex `i`'s position in position array `array` (header word 2 or 3), or its data's if pinned.
fn position_of(array: u32, i: u32) -> vec2f {
    let v = vertex_at(record(i).x * VERTEX_WORDS);
    if (v.flags & PINNED) != 0u {
        return v.hi + v.lo;
    }
    let at = graph[array] + 2u * i;
    return vec2f(bitcast<f32>(graph[at]), bitcast<f32>(graph[at + 1u]));
}

fn move_to(array: u32, i: u32, p: vec2f) {
    let at = graph[array] + 2u * i;
    graph[at] = bitcast<u32>(p.x);
    graph[at + 1u] = bitcast<u32>(p.y);
}

fn relax(before: u32, after: u32, i: u32) {
    if i >= graph[0] {
        return;
    }
    let r = record(i);
    let here = position_of(before, i);
    var sum = vec2f(0.0);
    var weights = 0.0;
    for (var t = r.z; t < r.z + r.w; t++) {
        let at = graph[1] + 3u * t;
        let there = position_of(before, graph[at]);
        let d = bitcast<f32>(graph[at + 1u]);
        let w = bitcast<f32>(graph[at + 2u]);
        let apart = here - there;
        let length_apart = length(apart);
        // Vertices at one point part along a direction of their own.
        let toward = select(vec2f(cos(f32(i)), sin(f32(i))), apart / length_apart, length_apart > 1e-6);
        sum += w * (there + d * toward);
        weights += w;
    }
    move_to(after, i, select(here, sum / weights, weights > 0.0));
}

@compute @workgroup_size(256)
fn forward(@builtin(global_invocation_id) id: vec3u) {
    relax(2u, 3u, id.x);
}

@compute @workgroup_size(256)
fn backward(@builtin(global_invocation_id) id: vec3u) {
    relax(3u, 2u, id.x);
}

// Starts each vertex where a graph placed it before, if one did.
@compute @workgroup_size(256)
fn seed(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= graph[0] {
        return;
    }
    let at = record(id.x).y;
    if is_placed(places[at], places[at + 1u]) {
        move_to(2u, id.x, vec2f(bitcast<f32>(places[at]), bitcast<f32>(places[at + 1u])));
    }
}

// Writes each vertex's position to its place.
@compute @workgroup_size(256)
fn settle(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= graph[0] {
        return;
    }
    let p = position_of(2u, id.x);
    let at = record(id.x).y;
    places[at] = place_word(p.x);
    places[at + 1u] = place_word(p.y);
}
