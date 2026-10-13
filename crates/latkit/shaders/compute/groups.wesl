// Groups: each row of a vertex mark that contains rows stands around its members, in their bounds
// and the theme's padding, or as its own marker at their middle when collapsed. Every member's slot
// names the group it is in, so whatever reads a vertex slot reads the outermost collapsed group
// standing in for it. Nested groups settle over one pass per level, innermost first.

import package::lib::types::{
    NONE, VISIBLE, PINNED, PLACED, COLLAPSED, OPEN_GROUP, VERTEX_WORDS, VERTEX_POSITION, VERTEX_HALF, VERTEX_FLAGS,
    TERMINAL_WORDS,
};
import package::lib::bind::{frame, eye, mark, program, state};
import package::lib::state::{row_at, extra_at, float_at, vertex_at, stand_ins};
import package::lib::points::vertex_half;
import package::lib::mark::px;

// Where row `row`'s members start among the mark's member entries, and how many there are.
fn members(row: u32) -> vec2u {
    let start = program[mark.members + row];
    return vec2u(start, program[mark.members + row + 1u] - start);
}

@compute @workgroup_size(256)
fn clear(@builtin(global_invocation_id) id: vec3u) {
    if id.x < arrayLength(&stand_ins) {
        stand_ins[id.x] = 0u;
    }
}

@compute @workgroup_size(256)
fn bound(@builtin(global_invocation_id) id: vec3u) {
    let row = id.x;
    if row >= mark.rows || mark.members == NONE {
        return;
    }
    let at = row_at(row);
    let own_word = VERTEX_WORDS + mark.inputs;
    let own = vec2f(px(float_at(extra_at(row, mark.inputs)), own_word), px(float_at(extra_at(row, mark.inputs + 1u)), own_word + 1u));
    let own_units = own / eye.px_per_unit.x;
    let flags = state[at + VERTEX_FLAGS];
    let collapsed = (flags & COLLAPSED) != 0u;
    let slot = mark.state / VERTEX_WORDS + row;
    let span = members(row);
    var lo = vec2f(1e30);
    var hi = vec2f(-1e30);
    for (var k = 0u; k < span.y; k++) {
        let t = mark.members + mark.rows + 1u + TERMINAL_WORDS * (span.x + k);
        let first = program[mark.ends + program[t]];
        if first == NONE {
            continue;
        }
        let member = first + program[t + 1u];
        stand_ins[member] = (slot + 1u) | select(OPEN_GROUP, 0u, collapsed);
        let v = vertex_at(member * VERTEX_WORDS);
        if (v.flags & (PINNED | PLACED)) == 0u || (v.flags & VISIBLE) == 0u {
            continue;
        }
        let half = vertex_half(v) / eye.px_per_unit.x;
        let p = v.hi + v.lo;
        lo = min(lo, p - half);
        hi = max(hi, p + half);
    }
    if lo.x > hi.x {
        // No member shows: the row keeps its own place, at its own size.
        state[at + VERTEX_HALF] = bitcast<u32>(own_units.x);
        state[at + VERTEX_HALF + 1u] = bitcast<u32>(own_units.y);
        return;
    }
    let center = 0.5 * (lo + hi);
    let padding = frame.group_padding / eye.px_per_unit.x;
    let half = select(0.5 * (hi - lo) + padding, own_units, collapsed);
    state[at + VERTEX_POSITION] = bitcast<u32>(center.x);
    state[at + VERTEX_POSITION + 1u] = bitcast<u32>(center.y);
    state[at + VERTEX_POSITION + 2u] = 0u;
    state[at + VERTEX_POSITION + 3u] = 0u;
    state[at + VERTEX_HALF] = bitcast<u32>(half.x);
    state[at + VERTEX_HALF + 1u] = bitcast<u32>(half.y);
    state[at + VERTEX_FLAGS] = (flags & ~PINNED) | PLACED;
}
