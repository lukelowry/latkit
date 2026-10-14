// Groups: each row of a vertex mark that contains rows stands around its members, in their bounds
// and the theme's padding, or as its own marker at their middle when folded, between the two while
// it folds. Every member's slot names the group it is in, so whatever reads a vertex slot reads the
// outermost group folded all the way over it, or follows one folding. Nested groups settle over one pass per level, innermost first. Each level
// opens its groups' boxes, widens them a member a thread, then stands each group in its box, so a
// group of a million members takes no longer than a million groups of one.

import package::lib::types::{
    NONE, VISIBLE, PINNED, PLACED, COLLAPSED, OPEN_GROUP, VERTEX_WORDS, VERTEX_POSITION, VERTEX_HALF, VERTEX_FLAGS,
    VERTEX_FOLD, TERMINAL_WORDS,
};
import package::lib::bind::{frame, eye, mark, program, state};
import package::lib::state::{row_at, extra_at, float_at, vertex_at, stand_ins};
import package::lib::points::vertex_half;
import package::lib::mark::px;
import package::lib::reduce::{ordered, unordered};

// Each group slot's box, four words: the least x and y as `~ordered`, the greatest as `ordered`, so
// `atomicMax` widens all four and zero is empty.
@group(2) @binding(18) var<storage, read_write> boxes: array<atomic<u32>>;

// Where member entry `k` lies among the mark's member entries.
fn entry(k: u32) -> u32 {
    return mark.members + mark.rows + 1u + TERMINAL_WORDS * k;
}

// The vertex slot of group row `row`.
fn group_slot(row: u32) -> u32 {
    return mark.state / VERTEX_WORDS + row;
}

@compute @workgroup_size(256)
fn clear(@builtin(global_invocation_id) id: vec3u) {
    if id.x < arrayLength(&stand_ins) {
        stand_ins[id.x] = 0u;
    }
}

// One thread per group row: its box empties.
@compute @workgroup_size(256)
fn open(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= mark.rows || mark.members == NONE {
        return;
    }
    let b = 4u * group_slot(id.x);
    for (var k = 0u; k < 4u; k++) {
        atomicStore(&boxes[b + k], 0u);
    }
}

// One thread per member entry: the member names its group, and widens the group's box when it shows.
@compute @workgroup_size(256)
fn widen(@builtin(global_invocation_id) id: vec3u) {
    if mark.members == NONE || id.x >= program[mark.members + mark.rows] {
        return;
    }
    let t = entry(id.x);
    let first = program[mark.ends + program[t]];
    if first == NONE {
        return;
    }
    // An entry's last word is the group row it belongs to.
    let row = program[t + 2u];
    let slot = group_slot(row);
    let folded = float_at(row_at(row) + VERTEX_FOLD) >= 1.0;
    let member = first + program[t + 1u];
    stand_ins[member] = (slot + 1u) | select(OPEN_GROUP, 0u, folded);
    let v = vertex_at(member * VERTEX_WORDS);
    if (v.flags & (PINNED | PLACED)) == 0u || (v.flags & VISIBLE) == 0u {
        return;
    }
    let half = vertex_half(v) / eye.px_per_unit.x;
    let p = v.hi + v.lo;
    let b = 4u * slot;
    atomicMax(&boxes[b], ~ordered(p.x - half.x));
    atomicMax(&boxes[b + 1u], ~ordered(p.y - half.y));
    atomicMax(&boxes[b + 2u], ordered(p.x + half.x));
    atomicMax(&boxes[b + 3u], ordered(p.y + half.y));
}

// One thread per group row: it stands in its box, padded, or at its own size when folded or when no
// member shows, and between the two while it folds.
@compute @workgroup_size(256)
fn stand(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows || mark.members == NONE {
        return;
    }
    let at = row_at(row);
    let own_word = VERTEX_WORDS + mark.inputs;
    let own = vec2f(px(float_at(extra_at(row, mark.inputs)), own_word), px(float_at(extra_at(row, mark.inputs + 1u)), own_word + 1u));
    let own_units = own / eye.px_per_unit.x;
    let fold = clamp(float_at(at + VERTEX_FOLD), 0.0, 1.0);
    let flags = select(state[at + VERTEX_FLAGS] & ~COLLAPSED, state[at + VERTEX_FLAGS] | COLLAPSED, fold >= 1.0);
    state[at + VERTEX_FLAGS] = flags;
    let b = 4u * group_slot(row);
    let widest = atomicLoad(&boxes[b + 2u]);
    if widest == 0u {
        // No member shows: the row keeps its own place, at its own size.
        state[at + VERTEX_HALF] = bitcast<u32>(own_units.x);
        state[at + VERTEX_HALF + 1u] = bitcast<u32>(own_units.y);
        return;
    }
    let lo = vec2f(unordered(~atomicLoad(&boxes[b])), unordered(~atomicLoad(&boxes[b + 1u])));
    let hi = vec2f(unordered(widest), unordered(atomicLoad(&boxes[b + 3u])));
    let center = 0.5 * (lo + hi);
    let padding = frame.group_padding / eye.px_per_unit.x;
    let half = mix(0.5 * (hi - lo) + padding, own_units, fold);
    state[at + VERTEX_POSITION] = bitcast<u32>(center.x);
    state[at + VERTEX_POSITION + 1u] = bitcast<u32>(center.y);
    state[at + VERTEX_POSITION + 2u] = 0u;
    state[at + VERTEX_POSITION + 3u] = 0u;
    state[at + VERTEX_HALF] = bitcast<u32>(half.x);
    state[at + VERTEX_HALF + 1u] = bitcast<u32>(half.y);
    state[at + VERTEX_FLAGS] = (flags & ~PINNED) | PLACED;
}
