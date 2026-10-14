// Evaluated rows: words of the `state` buffer. A row's kind words sit at `mark.state`, `mark.stride`
// apart, so vertex slots count every vertex mark's rows; its extra words (labels, marker inputs) sit
// at `mark.extra`, `mark.extras` apart.

import package::lib::types::{
    VERTEX_WORDS, VERTEX_POSITION, VERTEX_COLOR, VERTEX_STATUS, VERTEX_HALF, VERTEX_ELEVATION, VERTEX_DEPTH,
    VERTEX_FLAGS, EDGE_FROM, EDGE_TO, EDGE_COLOR, EDGE_WIDTH, EDGE_FLOW, EDGE_FLAGS, FACE_A, FACE_B, FACE_C,
    FACE_COLOR, FACE_FLAGS, LINE_COLOR, LINE_WIDTH, LINE_FLOW, LINE_FLAGS, AREA_COLOR, AREA_FLAGS,
};
import package::lib::bind::{state, mark};

struct Vertex {
    hi: vec2f,
    lo: vec2f,
    color: u32,
    status: u32,
    half: vec2f,
    elevation: f32,
    depth: f32,
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
    flow: f32,
    flags: u32,
}

struct Area {
    color: u32,
    flags: u32,
}

fn float_at(at: u32) -> f32 {
    return bitcast<f32>(state[at]);
}

// The first kind word of `row` of the current mark.
fn row_at(row: u32) -> u32 {
    return mark.state + row * mark.stride;
}

// Extra word `word` of `row` of the current mark.
fn extra_at(row: u32, word: u32) -> u32 {
    return mark.extra + row * mark.extras + word;
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
        float_at(at + VERTEX_DEPTH),
        state[at + VERTEX_FLAGS],
    );
}

// The vertex in graph slot `slot`, from any vertex mark.
fn vertex_slot(slot: u32) -> Vertex {
    return vertex_at(slot * VERTEX_WORDS);
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
    return Line(state[at + LINE_COLOR], float_at(at + LINE_WIDTH), float_at(at + LINE_FLOW), state[at + LINE_FLAGS]);
}

fn area_at(at: u32) -> Area {
    return Area(state[at + AREA_COLOR], state[at + AREA_FLAGS]);
}
