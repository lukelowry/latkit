// Reading evaluated rows. Each mark keeps its per-row words in pages of `PAGE_ROWS` held rows,
// listed by the page table at `mark.state`. A row has `mark.stride` kind words, then `mark.extras`
// extra words (marker inputs, labels, shade inputs, trailing texel padding). An edge reads its vertices through the page
// tables of the vertex marks that draw them, which its ends list.

import package::lib::types::{
    NONE, PAGE_BITS, PAGE_MASK, VERTEX_POSITION, VERTEX_COLOR,
    VERTEX_STATUS, VERTEX_HALF, VERTEX_ELEVATION, VERTEX_RANGE, VERTEX_FLAGS, EDGE_FROM, EDGE_TO,
    EDGE_COLOR, EDGE_WIDTH, EDGE_FLOW, EDGE_TRAVEL, EDGE_FLAGS,
    LINE_COLOR, LINE_WIDTH, LINE_FLOW, LINE_TRAVEL, LINE_FLAGS, AREA_COLOR, AREA_FLAGS, MARK_EDGES, MARK_LINES,
};
import package::lib::bind::{program, mark, word, pages};
import package::lib::words::word_quad;

struct Vertex {
    hi: vec2f,
    lo: vec2f,
    color: u32,
    status: u32,
    half: vec2f,
    elevation: f32,
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
    return program(table + (row >> PAGE_BITS)) + (row & PAGE_MASK) * stride;
}

// Where the first kind word of the current mark's `row` lies in the pages.
fn row_at(row: u32) -> u32 {
    return record_at(mark.state, mark.stride + mark.extras, row);
}

// Where extra word `w` of the current mark's `row` lies in the pages.
fn extra_at(row: u32, w: u32) -> u32 {
    return row_at(row) + mark.stride + w;
}

// `count` (at most eight) of the current mark's extra words of `row` from `first`, as numbers: a
// marker's or a shade's inputs.
fn row_inputs(row: u32, first: u32, count: u32) -> array<f32, 8> {
    var input = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for (var i = 0u; i < min(count, 8u); i++) {
        input[i] = bitcast<f32>(word(extra_at(row, first + i)));
    }
    return input;
}

fn vertex_at(at: u32) -> Vertex {
    // Compiled row widths and arena pages are multiples of four words.
    let a = word_quad(pages, at);
    let b = word_quad(pages, at + 4u);
    let c = word_quad(pages, at + 8u);
    return Vertex(
        bitcast<vec2f>(a.xy), bitcast<vec2f>(a.zw),
        b.x, b.y, bitcast<vec2f>(b.zw),
        bitcast<f32>(c.x), unpack_range(c.y), c.z,
    );
}

// Vertex `held` of end `end`: a held row of the vertex mark that draws the end's table.
fn end_vertex(end: u32, held: u32) -> Vertex {
    let table = select(mark.from_state, mark.to_state, end != 0u);
    let stride = select(mark.from_stride, mark.to_stride, end != 0u);
    return vertex_at(record_at(table, stride, held));
}

// Whether an edge's ends `a` and `b`, held rows of the vertex marks its two ends attach to, are the
// same vertex.
fn same_vertex(a: u32, b: u32) -> bool {
    return (a == b) & (mark.from_state == mark.to_state);
}

fn edge_at(at: u32) -> Edge {
    let a = word_quad(pages, at);
    let b = word_quad(pages, at + 4u);
    return Edge(a.x, a.y, a.z, bitcast<f32>(a.w), bitcast<f32>(b.x), bitcast<f32>(b.y), b.z);
}

fn line_at(at: u32) -> Line {
    let a = word_quad(pages, at);
    return Line(a.x, bitcast<f32>(a.y), bitcast<f32>(a.z), bitcast<f32>(a.w), word(at + LINE_FLAGS));
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
    let a = word_quad(pages, at);
    return Area(a.x, a.y);
}
