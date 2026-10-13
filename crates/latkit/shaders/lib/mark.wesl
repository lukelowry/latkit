// What every mark's shaders share.

import package::lib::bind::{frame, mark};

// A size in CSS pixels: state word `word` holds position units when the mark measures it in units.
fn px(size: f32, word: u32) -> f32 {
    return select(size, size * frame.px_per_unit.x, (mark.units & (1u << word)) != 0u);
}
