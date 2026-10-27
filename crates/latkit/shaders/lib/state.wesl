// Reading evaluated rows. Each mark keeps its per-row words in pages of `PAGE_ROWS` held rows,
// listed by the page table at `mark.state`. A row has `mark.stride` kind words, then `mark.extras`
// extra words (labels, marker inputs). An edge or face mark reads its vertices through the page
// tables of the vertex marks that draw them, which its ends list.

import package::lib::types::{
    NONE, PAGE_BITS, PAGE_MASK, END_WORDS, END_STATE, END_STRIDE, END_NORMALS, VERTEX_POSITION, VERTEX_COLOR,
    VERTEX_STATUS, VERTEX_HALF, VERTEX_ELEVATION, VERTEX_DEPTH, VERTEX_RANGE, VERTEX_FLAGS, EDGE_FROM, EDGE_TO,
    EDGE_COLOR, EDGE_WIDTH, EDGE_FLOW, EDGE_TRAVEL, EDGE_FLAGS, FACE_A, FACE_B, FACE_C, FACE_COLOR, FACE_FLAGS,
    LINE_COLOR, LINE_WIDTH, LINE_FLOW, LINE_TRAVEL, LINE_FLAGS, AREA_COLOR, AREA_FLAGS, MARK_EDGES, MARK_LINES,
    NORMAL_WORDS,
};
import package::lib::bind::{program, mark, word};

struct Vertex {
    hi: vec2f,
    lo: vec2f,
    color: u32,
    status: u32,
    half: vec2f,
    elevation: f32,
    depth: f32,
    // The range of CSS pixels its marker's half size is clamped to.
    range: vec2f,
    flags: u32,
}

struct Edge {
    a: u32,
    b: u32,
    color: u32,
    width: f32,
    flow: f32,
    travel: f32,
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
    travel: f32,
    flags: u32,
}

struct Area {
    color: u32,
    flags: u32,
}

// Packs a range of CSS pixels into one word: each end in 16 bits, in 1/16 pixel, up to 4095.9375
// pixels. An upper end of 65535 means no upper bound.
fn pack_range(range: vec2f) -> u32 {
    let ends = vec2u(round(clamp(range, vec2f(0.0), vec2f(4095.9375)) * 16.0));
    let top = select(ends.y, 65535u, range.y > 4095.9375);
    return ends.x | (top << 16u);
}

fn unpack_range(word: u32) -> vec2f {
    let ends = vec2f(f32(word & 65535u), f32(word >> 16u)) / 16.0;
    // The top value means no upper bound.
    return vec2f(ends.x, select(ends.y, 3.4e38, (word >> 16u) == 65535u));
}

fn float_at(at: u32) -> f32 {
    return bitcast<f32>(word(at));
}

// Where `row`'s words start in the pages, given page table `table` and `stride` words per row.
fn record_at(table: u32, stride: u32, row: u32) -> u32 {
    return program[table + (row >> PAGE_BITS)] + (row & PAGE_MASK) * stride;
}

// Where the first kind word of the current mark's `row` lies in the pages.
fn row_at(row: u32) -> u32 {
    return record_at(mark.state, mark.stride + mark.extras, row);
}

// Where extra word `w` of the current mark's `row` lies in the pages.
fn extra_at(row: u32, w: u32) -> u32 {
    return row_at(row) + mark.stride + w;
}

fn vertex_at(at: u32) -> Vertex {
    let p = at + VERTEX_POSITION;
    return Vertex(
        vec2f(float_at(p), float_at(p + 1u)),
        vec2f(float_at(p + 2u), float_at(p + 3u)),
        word(at + VERTEX_COLOR),
        word(at + VERTEX_STATUS),
        vec2f(float_at(at + VERTEX_HALF), float_at(at + VERTEX_HALF + 1u)),
        float_at(at + VERTEX_ELEVATION),
        float_at(at + VERTEX_DEPTH),
        unpack_range(word(at + VERTEX_RANGE)),
        word(at + VERTEX_FLAGS),
    );
}

// Vertex `held` of end `end`: a held row of the vertex mark that draws the end's table.
fn end_vertex(end: u32, held: u32) -> Vertex {
    let e = mark.ends + END_WORDS * end;
    return vertex_at(record_at(program[e + END_STATE], program[e + END_STRIDE], held));
}

// Whether an edge's ends `a` and `b`, held rows of the vertex marks its two ends attach to, are the
// same vertex.
fn same_vertex(a: u32, b: u32) -> bool {
    return a == b && program[mark.ends + END_STATE] == program[mark.ends + END_WORDS + END_STATE];
}

// Where the face normal sum for vertex `held` of end `end` lies, or NONE.
fn end_normal(end: u32, held: u32) -> u32 {
    let table = program[mark.ends + END_WORDS * end + END_NORMALS];
    if table == NONE {
        return NONE;
    }
    return record_at(table, NORMAL_WORDS, held);
}

fn edge_at(at: u32) -> Edge {
    return Edge(
        word(at + EDGE_FROM),
        word(at + EDGE_TO),
        word(at + EDGE_COLOR),
        float_at(at + EDGE_WIDTH),
        float_at(at + EDGE_FLOW),
        float_at(at + EDGE_TRAVEL),
        word(at + EDGE_FLAGS),
    );
}

fn face_at(at: u32) -> Face {
    let corners = vec3u(word(at + FACE_A), word(at + FACE_B), word(at + FACE_C));
    return Face(corners, word(at + FACE_COLOR), word(at + FACE_FLAGS));
}

fn line_at(at: u32) -> Line {
    return Line(
        word(at + LINE_COLOR),
        float_at(at + LINE_WIDTH),
        float_at(at + LINE_FLOW),
        float_at(at + LINE_TRAVEL),
        word(at + LINE_FLAGS),
    );
}

// The current mark's word indices for a stroke row's comet travel and its flow. NONE for a mark
// that draws no strokes.
fn travel_words() -> vec2u {
    switch mark.kind {
        case MARK_EDGES: { return vec2u(EDGE_TRAVEL, EDGE_FLOW); }
        case MARK_LINES: { return vec2u(LINE_TRAVEL, LINE_FLOW); }
        default: { return vec2u(NONE); }
    }
}

fn area_at(at: u32) -> Area {
    return Area(word(at + AREA_COLOR), word(at + AREA_FLAGS));
}
