// Traces: a line's samples over every frame in view. The traced column's table holds the first frame
// drawn and how many, then the axis pages as (offset, first frame), then per row block a count and
// where its frame pages start, then the frame pages as (offset, first frame, rows). Offsets within
// the table are relative to it.

import package::lib::types::{NONE, MISSING, COLUMN_TABLE, PAGE_BITS, PAGE_MASK};
import package::lib::bind::{pages, program, mark};
import package::lib::read::column_word;

fn trace_table() -> u32 {
    return column_word(mark.trace, COLUMN_TABLE);
}

// The first frame drawn.
fn trace_first() -> u32 {
    return program[trace_table()];
}

// How many frames are drawn.
fn trace_frames() -> u32 {
    return program[trace_table() + 1u];
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
    let e = entry(t + 4u, max(program[t + 2u], 1u), 2u, frame);
    let w = program[e] + (frame - program[e + 1u]) * 2u;
    return vec2f(bitcast<f32>(pages[w]), bitcast<f32>(pages[w + 1u]));
}

// The bits of `row`'s sample in `frame`.
fn trace_value(row: u32, frame: u32) -> u32 {
    let t = trace_table();
    let blocks = t + 4u + 2u * program[t + 2u];
    let block = row >> PAGE_BITS;
    if block >= program[t + 3u] {
        return MISSING;
    }
    let count = program[blocks + 2u * block];
    if count == 0u {
        return MISSING;
    }
    let e = entry(t + program[blocks + 2u * block + 1u], count, 3u, frame);
    let local = row & PAGE_MASK;
    if program[e] == NONE || local >= program[e + 2u] || frame < program[e + 1u] {
        return MISSING;
    }
    return pages[program[e] + (frame - program[e + 1u]) * program[e + 2u] + local];
}
