// Label placement. `candidates` measures each labeled row's label where its anchor puts it, asks for
// the texts the atlas lacks of labels that could show, and keys it by whether it showed before, its
// priority, and its id. Then rounds of `claim` (each label wanting room takes the least key into
// every cell it covers, or drops if one is held), `decide` (a label holding all its cells is placed),
// and `occupy` (placed labels hold their cells) settle, with cells not held cleared between rounds.
// That places labels as greedily by key as a sequential pass would. `fade` eases each label in or
// out. Placement only decides which labels show; draws place them from their anchors every frame. A
// diagram's labels scale with its sheet, so they need no placement: only `candidates` runs there,
// to ask for texts.

import package::lib::types::{
    NONE, VISIBLE, LABEL_CODE, LABEL_PRIORITY, CANDIDATE_WORDS, CANDIDATE_BOX, CANDIDATE_KEY, CANDIDATE_STATE,
    CANDIDATE_ALPHA, WANTS, PLACED_LABEL, DROPPED, STICKY, OCCUPIED, CELL, WANTED,
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
    if uv0 == 0u && uv1 == 0u {
        // The atlas lacks this text: ask for it, if the label could show, legible and near the view.
        let near = 0.25 * eye.size;
        if a.shown && legibility(size) > 0.0 && in_view(a.at - near, a.at + near) {
            let asked = atomicAdd(&labels[mark.wanted], 1u);
            if asked < WANTED {
                put(mark.wanted + 1u + asked, code);
            }
        }
        put(at + CANDIDATE_STATE, next);
        return;
    }
    let t = text_at(uv0, uv1, size, a.at, a.align);
    if a.shown && in_view(t.lo, t.hi) && fits(t.hi - t.lo, a.room) {
        next |= WANTS;
    }
    put(at + CANDIDATE_BOX, bitcast<u32>(t.lo.x));
    put(at + CANDIDATE_BOX + 1u, bitcast<u32>(t.lo.y));
    put(at + CANDIDATE_BOX + 2u, bitcast<u32>(t.hi.x));
    put(at + CANDIDATE_BOX + 3u, bitcast<u32>(t.hi.y));
    let level = u32(clamp(bitcast<f32>(state[extra_at(row, mark.label + LABEL_PRIORITY)]), 0.0, 255.0));
    let id_bits = (mark.label_id + row + 1u) & 0x7fffffu;
    put(at + CANDIDATE_KEY, select(0x80000000u, 0u, sticky) | ((255u - level) << 23u) | id_bits);
    put(at + CANDIDATE_STATE, next);
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
