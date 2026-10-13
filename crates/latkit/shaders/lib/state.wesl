// Evaluated rows: words of the `state` buffer.

import package::lib::types::{
    NONE, VERTEX_WORDS, VERTEX_POSITION, VERTEX_COLOR, VERTEX_STATUS, VERTEX_HALF, VERTEX_ELEVATION,
    VERTEX_FLAGS, EDGE_FROM, EDGE_TO, EDGE_COLOR, EDGE_WIDTH, EDGE_FLOW, EDGE_FLAGS,
    FACE_A, FACE_B, FACE_C, FACE_COLOR, FACE_FLAGS, LINE_COLOR, LINE_WIDTH, LINE_FLAGS,
};
import package::lib::bind::{state, mark};

struct Vertex {
    hi: vec2f,
    lo: vec2f,
    color: u32,
    status: u32,
    half: vec2f,
    elevation: f32,
    flags: u32,
}

struct Edge {
    a: u32,
    b: u32,
    color: u32,
    width: f32,
    flow: f32,
    flags: u32,
}

struct Face {
    corners: vec3u,
    color: u32,
    flags: u32,
}

struct Line {
    color: u32,
    width: f32,
    flags: u32,
}

fn float_at(at: u32) -> f32 {
    return bitcast<f32>(state[at]);
}

// The first word of `row` of the current mark.
fn row_at(row: u32) -> u32 {
    return mark.state + row * mark.stride;
}

fn vertex_at(at: u32) -> Vertex {
    let p = at + VERTEX_POSITION;
    return Vertex(
        vec2f(float_at(p), float_at(p + 1u)),
        vec2f(float_at(p + 2u), float_at(p + 3u)),
        state[at + VERTEX_COLOR],
        state[at + VERTEX_STATUS],
        vec2f(float_at(at + VERTEX_HALF), float_at(at + VERTEX_HALF + 1u)),
        float_at(at + VERTEX_ELEVATION),
        state[at + VERTEX_FLAGS],
    );
}

// The vertex in graph slot `slot`, from any vertex mark.
fn vertex_slot(slot: u32) -> Vertex {
    return vertex_at(mark.vertices + slot * VERTEX_WORDS);
}

fn edge_at(at: u32) -> Edge {
    return Edge(
        state[at + EDGE_FROM],
        state[at + EDGE_TO],
        state[at + EDGE_COLOR],
        float_at(at + EDGE_WIDTH),
        float_at(at + EDGE_FLOW),
        state[at + EDGE_FLAGS],
    );
}

fn face_at(at: u32) -> Face {
    let corners = vec3u(state[at + FACE_A], state[at + FACE_B], state[at + FACE_C]);
    return Face(corners, state[at + FACE_COLOR], state[at + FACE_FLAGS]);
}

fn line_at(at: u32) -> Line {
    return Line(state[at + LINE_COLOR], float_at(at + LINE_WIDTH), state[at + LINE_FLAGS]);
}

fn has_slot(slot: u32) -> bool {
    return slot != NONE;
}
