// Transitions: rows ease from their previous state, read through the mark's remap.

import package::lib::types::NONE;
import package::lib::bind::{mark, program, previous};

// The row `row` eases from while a transition runs, or NONE when it has none (it grows in).
fn previous_row(row: u32) -> u32 {
    if mark.motion >= 1.0 || mark.previous == NONE {
        return NONE;
    }
    if mark.remap == NONE {
        return row;
    }
    return program[mark.remap + row];
}

fn previous_word(row: u32, word: u32) -> u32 {
    return previous[mark.previous + row * mark.stride + word];
}

fn previous_float(row: u32, word: u32) -> f32 {
    return bitcast<f32>(previous_word(row, word));
}

fn ease_color(was: u32, now: u32) -> vec4f {
    return mix(unpack4x8unorm(was), unpack4x8unorm(now), mark.motion);
}

fn ease(was: f32, now: f32) -> f32 {
    return mix(was, now, mark.motion);
}

// A (high, low) position eased by its offset, which keeps the destination's precision.
fn ease_offset(was_hi: vec2f, was_lo: vec2f, now_hi: vec2f, now_lo: vec2f) -> vec2f {
    return ((was_hi - now_hi) + (was_lo - now_lo)) * (1.0 - mark.motion);
}
