// Label placement. `candidates` gives each labeled row a box where its mark's geometry anchors it,
// asks for texts the atlas lacks, and keys it by whether it was placed before, its priority, and its
// id. Then rounds of `claim` (each label wanting room takes the least key into every cell it covers,
// or drops if one is held), `decide` (a label holding all its cells is placed), and `occupy` (placed
// labels hold their cells) settle, with cells not held cleared between rounds. That places labels as
// greedily by key as a sequential pass would. `fade` eases each label in or out.

import package::lib::types::{
    NONE, VISIBLE, SIZED, VERTEX_WORDS, MARKER_BLOCK, POINTS, STROKES, LABEL_CODE, LABEL_PRIORITY, LABEL_COLOR, CANDIDATE_WORDS,
    CANDIDATE_BOX, CANDIDATE_KEY, CANDIDATE_STATE, CANDIDATE_UV, CANDIDATE_COLOR, CANDIDATE_ALPHA, WANTS,
    PLACED_LABEL, DROPPED, STICKY, OCCUPIED, CELL, WANTED, PATH_TRACE,
};
import package::lib::bind::{frame, eye, mark, state};
import package::lib::state::{extra_at, folding};
import package::lib::project::{to_screen, clip_of};
import package::lib::points::point;
import package::lib::path::{PATH, Segment, segment_screen, path_count};
import package::lib::triangles::triangle_corner;
import package::lib::read::missing_bits;

@group(2) @binding(13) var<storage, read_write> labels: array<atomic<u32>>;

fn word(at: u32) -> u32 {
    return atomicLoad(&labels[at]);
}

fn put(at: u32, value: u32) {
    atomicStore(&labels[at], value);
}

fn candidate(row: u32) -> u32 {
    return mark.candidates + row * CANDIDATE_WORDS;
}

// Where row `row`'s label hangs, CSS pixels, how it aligns to that point (0 left, 0.5 centered),
// the room it must fit in (none when zero), and whether it shows.
struct Anchor {
    at: vec2f,
    align: vec2f,
    room: vec2f,
    shown: bool,
}

fn anchor(row: u32) -> Anchor {
    var a: Anchor;
    switch mark.primitive {
        case POINTS: {
            let p = point(row);
            // A row folding into its group gives its label up as it starts.
            let folds = folding(mark.state / VERTEX_WORDS + row).fold > 0.0;
            a.shown = p.shown && p.clip.w > 0.0 && !folds;
            let center = to_screen(p.clip);
            // A group titles its box from above its top left corner; a block, or any marker given a
            // width and height, holds its label while it fits; a round one hangs it beside.
            if mark.members != NONE {
                a.at = center + vec2f(-p.half.x, -p.half.y - 3.0);
                a.align = vec2f(0.0, 1.0);
            } else if mark.marker == MARKER_BLOCK || (mark.flags & SIZED) != 0u {
                a.at = center;
                a.align = vec2f(0.5);
                a.room = 2.0 * p.half;
            } else {
                a.at = center + vec2f(p.half.x + 4.0, 0.0);
                a.align = vec2f(0.0, 0.5);
            }
        }
        case STROKES: {
            let count = path_count(row);
            // A trace labels its last sample; other paths their middle.
            let last = PATH == PATH_TRACE;
            let on = segment_screen(Segment(row, select(count / 2u, max(count, 1u) - 1u, last)));
            a.shown = count > 0u && on.shown;
            if last {
                a.at = on.b + vec2f(6.0, 0.0);
                a.align = vec2f(0.0, 0.5);
            } else {
                a.at = 0.5 * (on.a + on.b);
                a.align = vec2f(0.5);
            }
        }
        default: {
            var sum = vec2f(0.0);
            a.shown = true;
            for (var k = 0u; k < 3u; k++) {
                let c = triangle_corner(row, k);
                let clip = clip_of(c.world);
                a.shown = a.shown && c.shown && clip.w > 0.0;
                sum += to_screen(clip);
            }
            a.at = sum / 3.0;
            a.align = vec2f(0.5);
        }
    }
    return a;
}

@compute @workgroup_size(256)
fn candidates(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows {
        return;
    }
    let at = candidate(row);
    let before = word(at + CANDIDATE_STATE);
    let sticky = (before & PLACED_LABEL) != 0u;
    let code_bits = state[extra_at(row, mark.label + LABEL_CODE)];
    var next = select(0u, STICKY, sticky);
    if missing_bits(code_bits) || (state[mark.state + row * mark.stride + mark.stride - 1u] & VISIBLE) == 0u {
        put(at + CANDIDATE_STATE, next);
        return;
    }
    let code = u32(bitcast<f32>(code_bits));
    let uv0 = word(mark.runs + 2u * code);
    let uv1 = word(mark.runs + 2u * code + 1u);
    if uv0 == 0u && uv1 == 0u {
        // The atlas lacks this text: ask for it.
        let asked = atomicAdd(&labels[mark.wanted], 1u);
        if asked < WANTED {
            put(mark.wanted + 1u + asked, code);
        }
        put(at + CANDIDATE_STATE, next);
        return;
    }
    let a = anchor(row);
    let texels = vec2f(f32(uv1 & 0xffffu) - f32(uv0 & 0xffffu), f32(uv1 >> 16u) - f32(uv0 >> 16u));
    let size = texels / eye.pixel_ratio;
    let lo = a.at - size * a.align;
    let hi = lo + size;
    let in_view = all(hi > vec2f(0.0)) && all(lo < eye.size);
    let fits = a.room.x <= 0.0 || all(size <= a.room);
    if a.shown && in_view && fits {
        next |= WANTS;
    }
    put(at + CANDIDATE_BOX, bitcast<u32>(lo.x));
    put(at + CANDIDATE_BOX + 1u, bitcast<u32>(lo.y));
    put(at + CANDIDATE_BOX + 2u, bitcast<u32>(hi.x));
    put(at + CANDIDATE_BOX + 3u, bitcast<u32>(hi.y));
    let level = u32(clamp(bitcast<f32>(state[extra_at(row, mark.label + LABEL_PRIORITY)]), 0.0, 255.0));
    let id_bits = (mark.label_id + row + 1u) & 0x7fffffu;
    put(at + CANDIDATE_KEY, select(0x80000000u, 0u, sticky) | ((255u - level) << 23u) | id_bits);
    put(at + CANDIDATE_STATE, next);
    put(at + CANDIDATE_UV, uv0);
    put(at + CANDIDATE_UV + 1u, uv1);
    put(at + CANDIDATE_COLOR, state[extra_at(row, mark.label + LABEL_COLOR)]);
}

// The cells row `row`'s label covers: least and greatest column and row.
fn cells_of(row: u32) -> vec4u {
    let at = candidate(row);
    let lo = vec2f(bitcast<f32>(word(at + CANDIDATE_BOX)), bitcast<f32>(word(at + CANDIDATE_BOX + 1u)));
    let hi = vec2f(bitcast<f32>(word(at + CANDIDATE_BOX + 2u)), bitcast<f32>(word(at + CANDIDATE_BOX + 3u)));
    let top = vec2f(f32(frame.cell_columns), f32(frame.cell_rows)) - 1.0;
    let a = vec2u(clamp(floor(lo / CELL), vec2f(0.0), top));
    let b = vec2u(clamp(floor(hi / CELL), vec2f(0.0), top));
    return vec4u(a, b);
}

fn cell(x: u32, y: u32) -> u32 {
    return frame.cells + y * frame.cell_columns + x;
}

// Whether row `row`'s label still wants room this round.
fn undecided(row: u32) -> bool {
    let s = word(candidate(row) + CANDIDATE_STATE);
    return (s & WANTS) != 0u && (s & (PLACED_LABEL | DROPPED)) == 0u;
}

@compute @workgroup_size(256)
fn clear_cells(@builtin(global_invocation_id) id: vec3u) {
    if id.x < frame.cell_columns * frame.cell_rows {
        put(frame.cells + id.x, NONE);
    }
}

@compute @workgroup_size(256)
fn reset_cells(@builtin(global_invocation_id) id: vec3u) {
    if id.x < frame.cell_columns * frame.cell_rows && word(frame.cells + id.x) != OCCUPIED {
        put(frame.cells + id.x, NONE);
    }
}

@compute @workgroup_size(256)
fn claim(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows || !undecided(row) {
        return;
    }
    let at = candidate(row);
    let key = word(at + CANDIDATE_KEY);
    let c = cells_of(row);
    for (var y = c.y; y <= c.w; y++) {
        for (var x = c.x; x <= c.z; x++) {
            if word(cell(x, y)) == OCCUPIED {
                put(at + CANDIDATE_STATE, word(at + CANDIDATE_STATE) | DROPPED);
                return;
            }
            atomicMin(&labels[cell(x, y)], key);
        }
    }
}

@compute @workgroup_size(256)
fn decide(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows || !undecided(row) {
        return;
    }
    let at = candidate(row);
    let key = word(at + CANDIDATE_KEY);
    let c = cells_of(row);
    for (var y = c.y; y <= c.w; y++) {
        for (var x = c.x; x <= c.z; x++) {
            if word(cell(x, y)) != key {
                return;
            }
        }
    }
    put(at + CANDIDATE_STATE, word(at + CANDIDATE_STATE) | PLACED_LABEL);
}

@compute @workgroup_size(256)
fn occupy(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows || (word(candidate(row) + CANDIDATE_STATE) & PLACED_LABEL) == 0u {
        return;
    }
    let c = cells_of(row);
    for (var y = c.y; y <= c.w; y++) {
        for (var x = c.x; x <= c.z; x++) {
            put(cell(x, y), OCCUPIED);
        }
    }
}

@compute @workgroup_size(256)
fn fade(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows {
        return;
    }
    let at = candidate(row);
    let placed = (word(at + CANDIDATE_STATE) & PLACED_LABEL) != 0u;
    let alpha = bitcast<f32>(word(at + CANDIDATE_ALPHA));
    let next = clamp(select(alpha - frame.label_fade, alpha + frame.label_fade, placed), 0.0, 1.0);
    put(at + CANDIDATE_ALPHA, bitcast<u32>(select(next, 0.0, missing_bits(bitcast<u32>(next)))));
}
