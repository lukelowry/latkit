// What every mark's shaders share.

import package::lib::bind::{eye, mark};

// A size in CSS pixels: state word `word` holds position units when the mark measures it in units.
fn px(size: f32, word: u32) -> f32 {
    return select(size, size * eye.px_per_unit.x, (mark.units & (1u << word)) != 0u);
}

// Coverage of a signed distance `d` in CSS pixels, antialiased over a target pixel.
fn coverage(d: f32) -> f32 {
    return clamp(0.5 - d * eye.pixel_ratio, 0.0, 1.0);
}
