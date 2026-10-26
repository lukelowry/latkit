// Helpers shared by every mark's shaders.

import package::lib::types::{POINTS, SPACE_EARTH};
import package::lib::bind::{frame, eye, mark};

// The primitive a pipeline's marks draw: `POINTS`, `STROKES`, or `TRIANGLES`. Each pipeline
// compiles only that primitive's geometry, so it compiles quickly.
override PRIMITIVE: u32 = POINTS;

// CSS pixels per position unit at the camera's center. On the earth a position unit is a degree,
// and the eye's scale is per mercator radian.
fn px_per_length() -> f32 {
    return eye.px_per_unit.x * select(1.0, radians(1.0), frame.space == SPACE_EARTH);
}

// `size` in CSS pixels. State word `word` holds position units when the mark measures it in units.
fn px(size: f32, word: u32) -> f32 {
    return select(size, size * px_per_length(), (mark.units & (1u << word)) != 0u);
}

// A marker's half size in CSS pixels, scaled so its larger side stays within `range`. Both sides
// scale together, so a size in units keeps its shape at any zoom.
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

// How far a quad extends past its shape, in CSS pixels: one target pixel, for the antialiased edge.
fn fringe() -> f32 {
    return 1.0 / eye.pixel_ratio;
}
