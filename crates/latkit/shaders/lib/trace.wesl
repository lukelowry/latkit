// Traces: what a line draws of a sampled field across the axis: runs of entries left to right, each
// of one level, frames or buckets. The traced column's table holds a header (how many runs, pages of
// rows, and levels); per run its level's place among the levels, its first entry, how many, and the
// point it starts at; per level the level, how many axis pages it has, where they are listed, and
// where its pages' lists start; per level and page of rows how many pages of frames or least values
// it has and where they are listed, then of greatest values; then those lists: axis pages as (offset,
// first entry), pages of values as (offset, first entry, words per entry). Offsets within the table
// are relative to it. A line runs through each frame, and through each bucket's least and greatest
// value where it draws; between runs that do not meet, a point is left out, breaking the line.

import package::lib::types::{NONE, MISSING, COLUMN_TABLE};
import package::lib::bind::{program, mark, word};
import package::lib::read::{column_word, page_of};

const HEADER: u32 = 4u;
const TRACE_RUN_WORDS: u32 = 4u;
const LEVEL_WORDS: u32 = 4u;

fn trace_table() -> u32 {
    return column_word(mark.trace, COLUMN_TABLE);
}

// The last of `count` items of `stride` words from `at` whose word `key` is at most `value`.
fn last_at_most(at: u32, count: u32, stride: u32, key: u32, value: u32) -> u32 {
    var lo = 0u;
    var hi = count;
    while hi - lo > 1u {
        let mid = (lo + hi) / 2u;
        if program[at + mid * stride + key] <= value {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return at + lo * stride;
}

// A run of the trace: its level's place among the levels, its first entry, how many, and the point
// it starts at.
struct TraceRun {
    slot: u32,
    first: u32,
    entries: u32,
    point: u32,
}

// The run point `k` lies in: the last starting at or before it.
fn trace_run(k: u32) -> TraceRun {
    let t = trace_table();
    let r = last_at_most(t + HEADER, max(program[t], 1u), TRACE_RUN_WORDS, 3u, k);
    return TraceRun(program[r], program[r + 1u], program[r + 2u], program[r + 3u]);
}

// Where level `slot`'s words start.
fn trace_level_at(slot: u32) -> u32 {
    let t = trace_table();
    return t + HEADER + TRACE_RUN_WORDS * program[t] + LEVEL_WORDS * slot;
}

// The level a run of `slot` draws.
fn trace_level(slot: u32) -> u32 {
    return program[trace_level_at(slot)];
}

// Where entry `entry` of level `slot` draws along the axis, as (high, low): a frame at its
// coordinate, a bucket at its middle.
fn trace_axis(slot: u32, entry: u32) -> vec2f {
    let l = trace_level_at(slot);
    let e = last_at_most(trace_table() + program[l + 2u], max(program[l + 1u], 1u), 2u, 1u, entry);
    let w = program[e] + (entry - program[e + 1u]) * 2u;
    return vec2f(bitcast<f32>(word(w)), bitcast<f32>(word(w + 1u)));
}

// The bits of `row`'s value of entry `entry` of level `slot`: a frame's, or a bucket's least
// (`side` 0) or greatest (1).
fn trace_entry(row: u32, slot: u32, entry: u32, side: u32) -> u32 {
    let t = trace_table();
    let at = page_of(row);
    let block = at.x;
    if block >= program[t + 1u] {
        return MISSING;
    }
    let lists = t + program[trace_level_at(slot) + 3u] + 4u * block + 2u * side;
    let count = program[lists];
    if count == 0u {
        return MISSING;
    }
    let e = last_at_most(t + program[lists + 1u], count, 3u, 1u, entry);
    let local = at.y;
    let per = program[e + 2u];
    if program[e] == NONE || local >= per || entry < program[e + 1u] {
        return MISSING;
    }
    return word(program[e] + (entry - program[e + 1u]) * per + local);
}
