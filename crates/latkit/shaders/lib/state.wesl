// Evaluated rows: words of the `state` buffer. A row's kind words sit at `mark.state`, `mark.stride`
// apart, so vertex slots count every vertex mark's rows; its extra words (labels, marker inputs) sit
// at `mark.extra`, `mark.extras` apart. Each vertex slot also names the group it is in, if any: one
// plus the group's slot, with `OPEN_GROUP` unless the group is folded all the way. While a group
// folds, its members draw moving into it, shrinking and fading as far as it folded.

import package::lib::types::{
    VERTEX_WORDS, VERTEX_POSITION, VERTEX_COLOR, VERTEX_STATUS, VERTEX_HALF, VERTEX_ELEVATION,
    VERTEX_FLAGS, VERTEX_FOLD, EDGE_FROM, EDGE_TO, EDGE_COLOR, EDGE_WIDTH, EDGE_FLOW, EDGE_FLAGS,
    FACE_A, FACE_B, FACE_C, FACE_COLOR, FACE_FLAGS, LINE_COLOR, LINE_WIDTH, LINE_FLOW, LINE_FLAGS, OPEN_GROUP,
    GROUP_DEPTH,
};
import package::lib::bind::{state, mark};

@if(groups)
@group(2) @binding(14) var<storage, read_write> stand_ins: array<u32>;
@else
@group(2) @binding(14) var<storage, read> stand_ins: array<u32>;

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
    flow: f32,
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
        state[at + VERTEX_FLAGS],
    );
}

// The slot standing in for vertex slot `slot`: the outermost collapsed group it is in, or itself.
fn resolved(slot: u32) -> u32 {
    var at = slot;
    var standing = slot;
    for (var level = 0u; level < GROUP_DEPTH; level++) {
        let group = stand_ins[at];
        if group == 0u {
            break;
        }
        at = (group & ~OPEN_GROUP) - 1u;
        if (group & OPEN_GROUP) == 0u {
            standing = at;
        }
    }
    return standing;
}

// The outermost group folding over vertex slot `slot`, and how far it has folded.
struct Folding {
    group: u32,
    fold: f32,
}

fn folding(slot: u32) -> Folding {
    var at = slot;
    var out = Folding(slot, 0.0);
    for (var level = 0u; level < GROUP_DEPTH; level++) {
        let group = stand_ins[at];
        if group == 0u {
            break;
        }
        at = (group & ~OPEN_GROUP) - 1u;
        let fold = float_at(at * VERTEX_WORDS + VERTEX_FOLD);
        if fold > 0.0 {
            out = Folding(at, fold);
        }
    }
    return out;
}

// The vertex in graph slot `slot` as drawn, from any vertex mark: the group folded all the way over
// it, or itself, moved toward a group folding over it, shrunk, and faded, as far as it folded.
fn vertex_slot(slot: u32) -> Vertex {
    let standing = resolved(slot);
    var v = vertex_at(standing * VERTEX_WORDS);
    if standing != slot {
        return v;
    }
    let f = folding(slot);
    if f.fold <= 0.0 {
        return v;
    }
    let g = vertex_at(f.group * VERTEX_WORDS);
    v.hi = mix(v.hi + v.lo, g.hi + g.lo, f.fold);
    v.lo = vec2f(0.0);
    v.elevation = mix(v.elevation, g.elevation, f.fold);
    v.half *= 1.0 - f.fold;
    let color = unpack4x8unorm(v.color);
    v.color = pack4x8unorm(vec4f(color.rgb, color.a * (1.0 - f.fold)));
    return v;
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
