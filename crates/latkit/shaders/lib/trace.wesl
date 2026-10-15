// Traces: what a line draws of a sampled field across the axis. The traced column's table holds a
// header (the first frame drawn and how many, axis page and row block counts, the level of detail,
// its first bucket and how many), the axis pages as (offset, first frame), per row block how many
// frame pages, pages of least values, and pages of greatest values it has and where each list
// starts, then those pages as (offset, first frame or bucket, words per entry). Offsets within the
// table are relative to it. A line runs through each bucket's least and greatest value, then through
// each frame after the buckets.

import package::lib::types::{NONE, MISSING, COLUMN_TABLE, PAGE_BITS, PAGE_MASK};
import package::lib::bind::{pages, program, mark};
import package::lib::read::column_word;

const HEADER: u32 = 8u;

fn trace_table() -> u32 {
    return column_word(mark.trace, COLUMN_TABLE);
}

// The first frame drawn after the buckets.
fn trace_first() -> u32 {
    return program[trace_table()];
}

// Frames drawn after the buckets.
fn trace_frames() -> u32 {
    return program[trace_table() + 1u];
}

// The level of detail, its first bucket drawn, and how many.
fn trace_level() -> u32 {
    return program[trace_table() + 4u];
}

fn trace_bucket_first() -> u32 {
    return program[trace_table() + 5u];
}

fn trace_buckets() -> u32 {
    return program[trace_table() + 6u];
}

// The last of `count` entries of `stride` words from `at` whose first frame, its second word, is at
// most `frame`.
fn entry(at: u32, count: u32, stride: u32, frame: u32) -> u32 {
    var lo = 0u;
    var hi = count;
    while hi - lo > 1u {
        let mid = (lo + hi) / 2u;
        if program[at + mid * stride + 1u] <= frame {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return at + lo * stride;
}

// The axis coordinate of `frame` as (high, low).
fn trace_axis(frame: u32) -> vec2f {
    let t = trace_table();
    let e = entry(t + HEADER, max(program[t + 2u], 1u), 2u, frame);
    let w = program[e] + (frame - program[e + 1u]) * 2u;
    return vec2f(bitcast<f32>(pages[w]), bitcast<f32>(pages[w + 1u]));
}

// `row`'s word of entry `index` (a frame or a bucket) of its block's pages of `kind`: 0 frames, 1
// least values, 2 greatest values.
fn entry_word(row: u32, index: u32, kind: u32) -> u32 {
    let t = trace_table();
    let blocks = t + HEADER + 2u * program[t + 2u];
    let block = row >> PAGE_BITS;
    if block >= program[t + 3u] {
        return MISSING;
    }
    let pages_at = blocks + 6u * block + 2u * kind;
    let count = program[pages_at];
    if count == 0u {
        return MISSING;
    }
    let e = entry(t + program[pages_at + 1u], count, 3u, index);
    let local = row & PAGE_MASK;
    let per = program[e + 2u];
    if program[e] == NONE || local >= per || index < program[e + 1u] {
        return MISSING;
    }
    return pages[program[e] + (index - program[e + 1u]) * per + local];
}

// The bits of `row`'s sample in `frame`.
fn trace_value(row: u32, frame: u32) -> u32 {
    return entry_word(row, frame, 0u);
}

// The bits of `row`'s least (`which` 0) or greatest (1) value over `bucket` of the trace's level.
fn trace_bucket(row: u32, bucket: u32, which: u32) -> u32 {
    return entry_word(row, bucket, 1u + which);
}
