// What every mark's shaders share.

import package::lib::types::POINTS;
import package::lib::bind::{eye, mark};

// The primitive a pipeline's marks draw, `POINTS`, `STROKES`, or `TRIANGLES`, for the shaders made for
// one: each pipeline holds only that one's geometry, and compiles quickly.
override PRIMITIVE: u32 = POINTS;

// A size in CSS pixels: state word `word` holds position units when the mark measures it in units.
fn px(size: f32, word: u32) -> f32 {
    return select(size, size * eye.px_per_unit.x, (mark.units & (1u << word)) != 0u);
}

// A marker's half, CSS pixels, scaled to keep its larger side within `range`: what a size in units
// keeps of its looks at any zoom.
fn within(half: vec2f, range: vec2f) -> vec2f {
    let side = max(half.x, half.y);
    if side <= 0.0 {
        return half;
    }
    return half * (clamp(side, range.x, range.y) / side);
}

// Coverage of a signed distance `d` in CSS pixels, antialiased over a target pixel.
fn coverage(d: f32) -> f32 {
    return clamp(0.5 - d * eye.pixel_ratio, 0.0, 1.0);
}

// CSS pixels a quad reaches past the shape it draws: one target pixel, over which its edge fades.
fn fringe() -> f32 {
    return 1.0 / eye.pixel_ratio;
}
