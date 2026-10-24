// Label placement, once `compute/candidates.wesl` measured each label: rounds of `claim` (each
// label wanting room takes the least key into every cell it covers, or drops if one is held),
// `decide` (a label holding all its cells is placed), and `occupy` (placed labels hold their cells)
// settle, with cells not held cleared between rounds. That places labels as greedily by key as a
// sequential pass would. `ask` then asks for the texts of placed labels the atlas lacks and notes
// those it holds, so it keeps them: texts are set only for labels that show, however many rows are in
// view. `fade` eases each label in or out. Placement only decides which labels show; draws place them
// from their anchors every frame.
//
// A mark that shows at most `label_max` labels keeps, of those wanting room, the ones of least key,
// before any claims: keys are unique, so a radix select over three digits of 11, 11, and 10 bits finds
// the greatest key kept exactly, each digit a pass over the candidates and one over its buckets.

import package::lib::types::{
    NONE, LABEL_CODE, CANDIDATE_BOX, CANDIDATE_KEY, CANDIDATE_STATE, CANDIDATE_ALPHA, WANTS, PLACED_LABEL, DROPPED,
    UNSET, OCCUPIED, CELL, item,
};
import package::lib::bind::{frame, mark, word};
import package::lib::state::extra_at;
import package::lib::read::missing_bits;
import package::lib::placement::{labels, label_word, put_label, put, candidate, want, seen};
import package::lib::drawn::held_row;

// Buckets of a digit of the select capping labels.
const SELECT_BUCKETS: u32 = 2048u;

// Word `k` of the select's state, past its buckets: the key's digits found, how many of the least
// keys are still to keep, and the digit next counted (4 once fewer want room than the cap).
fn select_word(k: u32) -> u32 {
    return mark.label_select + SELECT_BUCKETS + k;
}

// Where digit `d` of a key starts, and how many bits it has.
fn digit(d: u32) -> vec2u {
    switch d {
        case 0u: { return vec2u(21u, 11u); }
        case 1u: { return vec2u(10u, 11u); }
        default: { return vec2u(0u, 10u); }
    }
}

// The held row of the drawn row invocation `id` covers, or NONE past the mark's live rows.
fn labeled(id: vec3u) -> u32 {
    let i = item(id);
    return select(NONE, held_row(i), i < mark.rows);
}

fn wanting(row: u32) -> bool {
    return (word(candidate(row) + CANDIDATE_STATE) & WANTS) != 0u;
}

@compute @workgroup_size(256)
fn select_start(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if mark.label_max == NONE {
        return;
    }
    if i < SELECT_BUCKETS {
        put_label(mark.label_select + i, 0u);
    }
    if i == 0u {
        put_label(select_word(0u), 0u);
        put_label(select_word(1u), mark.label_max);
        put_label(select_word(2u), 0u);
    }
}

@compute @workgroup_size(256)
fn select_count(@builtin(global_invocation_id) id: vec3u) {
    let row = labeled(id);
    let d = label_word(select_word(2u));
    if row == NONE || mark.label_max == NONE || d >= 3u || !wanting(row) {
        return;
    }
    let key = word(candidate(row) + CANDIDATE_KEY);
    let at = digit(d);
    // Only keys whose higher digits are those found count.
    let above = at.x + at.y;
    if above < 32u && (key >> above) != label_word(select_word(0u)) {
        return;
    }
    atomicAdd(&labels[mark.label_select + ((key >> at.x) & (SELECT_BUCKETS - 1u))], 1u);
}

// The bucket holding the least key still to keep, clearing the buckets for the next digit.
@compute @workgroup_size(1)
fn select_find() {
    let d = label_word(select_word(2u));
    // A cap of none keeps no label: the cut drops them all.
    if mark.label_max == NONE || mark.label_max == 0u || d >= 3u {
        return;
    }
    var left = label_word(select_word(1u));
    var found = SELECT_BUCKETS;
    for (var b = 0u; b < SELECT_BUCKETS; b++) {
        let n = label_word(mark.label_select + b);
        put_label(mark.label_select + b, 0u);
        if found == SELECT_BUCKETS {
            if n >= left {
                found = b;
            } else {
                left -= n;
            }
        }
    }
    if found == SELECT_BUCKETS {
        // Fewer want room than the cap: each keeps its chance.
        put_label(select_word(2u), 4u);
        return;
    }
    put_label(select_word(0u), (label_word(select_word(0u)) << digit(d).y) | found);
    put_label(select_word(1u), left);
    put_label(select_word(2u), d + 1u);
}

@compute @workgroup_size(256)
fn select_cut(@builtin(global_invocation_id) id: vec3u) {
    let row = labeled(id);
    if row == NONE || mark.label_max == NONE || !wanting(row) || label_word(select_word(2u)) == 4u {
        return;
    }
    let at = candidate(row) + CANDIDATE_STATE;
    if mark.label_max == 0u || word(candidate(row) + CANDIDATE_KEY) > label_word(select_word(0u)) {
        put(at, word(at) & ~WANTS);
    }
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
    let i = item(id);
    if i < frame.cell_columns * frame.cell_rows {
        put_label(frame.cells + i, NONE);
    }
}

@compute @workgroup_size(256)
fn reset_cells(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i < frame.cell_columns * frame.cell_rows && label_word(frame.cells + i) != OCCUPIED {
        put_label(frame.cells + i, NONE);
    }
}

@compute @workgroup_size(256)
fn claim(@builtin(global_invocation_id) id: vec3u) {
    let row = labeled(id);
    if row == NONE || !undecided(row) {
        return;
    }
    let at = candidate(row);
    let key = word(at + CANDIDATE_KEY);
    let c = cells_of(row);
    for (var y = c.y; y <= c.w; y++) {
        for (var x = c.x; x <= c.z; x++) {
            if label_word(cell(x, y)) == OCCUPIED {
                put(at + CANDIDATE_STATE, word(at + CANDIDATE_STATE) | DROPPED);
                return;
            }
            atomicMin(&labels[cell(x, y)], key);
        }
    }
}

@compute @workgroup_size(256)
fn decide(@builtin(global_invocation_id) id: vec3u) {
    let row = labeled(id);
    if row == NONE || !undecided(row) {
        return;
    }
    let at = candidate(row);
    let key = word(at + CANDIDATE_KEY);
    let c = cells_of(row);
    for (var y = c.y; y <= c.w; y++) {
        for (var x = c.x; x <= c.z; x++) {
            if label_word(cell(x, y)) != key {
                return;
            }
        }
    }
    put(at + CANDIDATE_STATE, word(at + CANDIDATE_STATE) | PLACED_LABEL);
}

@compute @workgroup_size(256)
fn occupy(@builtin(global_invocation_id) id: vec3u) {
    let row = labeled(id);
    if row == NONE || (word(candidate(row) + CANDIDATE_STATE) & PLACED_LABEL) == 0u {
        return;
    }
    let c = cells_of(row);
    for (var y = c.y; y <= c.w; y++) {
        for (var x = c.x; x <= c.z; x++) {
            put_label(cell(x, y), OCCUPIED);
        }
    }
}

@compute @workgroup_size(256)
fn ask(@builtin(global_invocation_id) id: vec3u) {
    let row = labeled(id);
    if row == NONE {
        return;
    }
    let s = word(candidate(row) + CANDIDATE_STATE);
    if (s & PLACED_LABEL) == 0u {
        return;
    }
    let code = u32(bitcast<f32>(word(extra_at(row, mark.label + LABEL_CODE))));
    if (s & UNSET) != 0u {
        want(code);
    } else {
        seen(code);
    }
}

@compute @workgroup_size(256)
fn fade(@builtin(global_invocation_id) id: vec3u) {
    let row = labeled(id);
    if row == NONE {
        return;
    }
    let at = candidate(row);
    // A label placed before its text is set waits for it to fade in.
    let s = word(at + CANDIDATE_STATE);
    let placed = (s & PLACED_LABEL) != 0u && (s & UNSET) == 0u;
    let alpha = bitcast<f32>(word(at + CANDIDATE_ALPHA));
    let next = clamp(select(alpha - frame.label_fade, alpha + frame.label_fade, placed), 0.0, 1.0);
    put(at + CANDIDATE_ALPHA, bitcast<u32>(select(next, 0.0, missing_bits(bitcast<u32>(next)))));
}
