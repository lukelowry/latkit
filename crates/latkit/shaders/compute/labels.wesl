// Label placement. `candidates` measures each labeled row's label where its anchor puts it, by the
// size of its text, or an estimate of it while the text is not set, and keys it by its priority,
// then whether it showed before, then its id: a label that arrives later still displaces lesser
// ones, and among equals those shown keep their place. Then rounds of `claim` (each label wanting
// room takes the least key into every cell it covers, or drops if one is held), `decide` (a label
// holding all its cells is placed), and `occupy` (placed labels hold their cells) settle, with cells
// not held cleared between rounds. That places labels as greedily by key as a sequential pass would.
// `ask` then asks for the texts of placed labels the atlas lacks and notes those it holds, so it
// keeps them: texts are set only for labels that show, however many rows are in view. `fade` eases
// each label in or out. Placement only decides which labels show; draws place them from their
// anchors every frame. A diagram's labels scale with its sheet, so they need no placement: only
// `candidates` runs there, to ask for the texts of labels in view.
//
// A mark that shows at most `label_max` labels keeps, of those wanting room, the ones of least key,
// before any claims: keys are unique, so a radix select over three digits of 11, 11, and 10 bits finds
// the greatest key kept exactly, each digit a pass over the candidates and one over its buckets.

import package::lib::types::{
    NONE, VISIBLE, LABEL_CODE, LABEL_PRIORITY, CANDIDATE_WORDS, CANDIDATE_BOX, CANDIDATE_KEY, CANDIDATE_STATE,
    CANDIDATE_ALPHA, WANTS, PLACED_LABEL, DROPPED, STICKY, ESTIMATED, TEXT_ESTIMATE, OCCUPIED, CELL, WANTED,
    SPACE_DIAGRAM,
};
import package::lib::bind::{frame, eye, mark, state};
import package::lib::state::extra_at;
import package::lib::read::missing_bits;
import package::lib::label::{anchor, length_px, legibility, text_at, fits, in_view};

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

// Asks the host to set the text of `code`.
fn want(code: u32) {
    let asked = atomicAdd(&labels[mark.wanted], 1u);
    if asked < WANTED {
        put(mark.wanted + 1u + asked, code);
    }
}

// Notes that a label shows the text of `code`, so the atlas keeps it.
fn seen(code: u32) {
    atomicOr(&labels[mark.seen + code / 32u], 1u << (code % 32u));
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
    let a = anchor(row);
    let size = length_px(mark.label_size);
    let diagram = frame.space == SPACE_DIAGRAM;
    let estimated = (uv0 & TEXT_ESTIMATE) != 0u;
    if (uv0 == 0u && uv1 == 0u) || (estimated && diagram) {
        // The atlas lacks this text, and the label cannot wait for placement to ask for it: ask now,
        // if it could show, legible and near the view.
        let near = 0.25 * eye.size;
        if a.shown && legibility(size) > 0.0 && in_view(a.at - near, a.at + near) {
            want(code);
        }
        put(at + CANDIDATE_STATE, next);
        return;
    }
    if estimated {
        next |= ESTIMATED;
    }
    let t = text_at(uv0 & ~TEXT_ESTIMATE, uv1, size, a.at, a.align);
    if a.shown && in_view(t.lo, t.hi) {
        // A diagram shows every label in view that fits; elsewhere `ask` notes those placed.
        if diagram {
            seen(code);
        }
        if fits(t.hi - t.lo, a.room) {
            next |= WANTS;
        }
    }
    put(at + CANDIDATE_BOX, bitcast<u32>(t.lo.x));
    put(at + CANDIDATE_BOX + 1u, bitcast<u32>(t.lo.y));
    put(at + CANDIDATE_BOX + 2u, bitcast<u32>(t.hi.x));
    put(at + CANDIDATE_BOX + 3u, bitcast<u32>(t.hi.y));
    let level = u32(clamp(bitcast<f32>(state[extra_at(row, mark.label + LABEL_PRIORITY)]), 0.0, 255.0));
    let id_bits = (mark.label_id + row + 1u) & 0x7fffffu;
    put(at + CANDIDATE_KEY, ((255u - level) << 24u) | select(0x800000u, 0u, sticky) | id_bits);
    put(at + CANDIDATE_STATE, next);
}

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

fn wanting(row: u32) -> bool {
    return (word(candidate(row) + CANDIDATE_STATE) & WANTS) != 0u;
}

@compute @workgroup_size(256)
fn select_start(@builtin(global_invocation_id) id: vec3u) {
    if mark.label_max == NONE {
        return;
    }
    if id.x < SELECT_BUCKETS {
        put(mark.label_select + id.x, 0u);
    }
    if id.x == 0u {
        put(select_word(0u), 0u);
        put(select_word(1u), mark.label_max);
        put(select_word(2u), 0u);
    }
}

@compute @workgroup_size(256)
fn select_count(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    let d = word(select_word(2u));
    if row >= mark.rows || mark.label_max == NONE || d >= 3u || !wanting(row) {
        return;
    }
    let key = word(candidate(row) + CANDIDATE_KEY);
    let at = digit(d);
    // Only keys whose higher digits are those found count.
    let above = at.x + at.y;
    if above < 32u && (key >> above) != word(select_word(0u)) {
        return;
    }
    atomicAdd(&labels[mark.label_select + ((key >> at.x) & (SELECT_BUCKETS - 1u))], 1u);
}

// The bucket holding the least key still to keep, clearing the buckets for the next digit.
@compute @workgroup_size(1)
fn select_find() {
    let d = word(select_word(2u));
    // A cap of none keeps no label: the cut drops them all.
    if mark.label_max == NONE || mark.label_max == 0u || d >= 3u {
        return;
    }
    var left = word(select_word(1u));
    var found = SELECT_BUCKETS;
    for (var b = 0u; b < SELECT_BUCKETS; b++) {
        let n = word(mark.label_select + b);
        put(mark.label_select + b, 0u);
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
        put(select_word(2u), 4u);
        return;
    }
    put(select_word(0u), (word(select_word(0u)) << digit(d).y) | found);
    put(select_word(1u), left);
    put(select_word(2u), d + 1u);
}

@compute @workgroup_size(256)
fn select_cut(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows || mark.label_max == NONE || !wanting(row) || word(select_word(2u)) == 4u {
        return;
    }
    let at = candidate(row) + CANDIDATE_STATE;
    if mark.label_max == 0u || word(candidate(row) + CANDIDATE_KEY) > word(select_word(0u)) {
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
fn ask(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows {
        return;
    }
    let s = word(candidate(row) + CANDIDATE_STATE);
    if (s & PLACED_LABEL) == 0u {
        return;
    }
    let code = u32(bitcast<f32>(state[extra_at(row, mark.label + LABEL_CODE)]));
    if (s & ESTIMATED) != 0u {
        want(code);
    } else {
        seen(code);
    }
}

@compute @workgroup_size(256)
fn fade(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows {
        return;
    }
    let at = candidate(row);
    // A label placed by an estimate waits for its text to fade in.
    let s = word(at + CANDIDATE_STATE);
    let placed = (s & PLACED_LABEL) != 0u && (s & ESTIMATED) == 0u;
    let alpha = bitcast<f32>(word(at + CANDIDATE_ALPHA));
    let next = clamp(select(alpha - frame.label_fade, alpha + frame.label_fade, placed), 0.0, 1.0);
    put(at + CANDIDATE_ALPHA, bitcast<u32>(select(next, 0.0, missing_bits(bitcast<u32>(next)))));
}
