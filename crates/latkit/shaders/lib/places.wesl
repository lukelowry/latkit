// Places: where a layout put each vertex row, x and y, at `mark.places`. A row no layout placed reads
// both words zero; a layout writes a coordinate of zero as negative zero.

@if(stress)
@group(2) @binding(16) var<storage, read_write> places: array<u32>;
@else
@group(2) @binding(16) var<storage, read> places: array<u32>;

// Whether a place's words hold one.
fn is_placed(x: u32, y: u32) -> bool {
    return x != 0u || y != 0u;
}

// A coordinate as a place word: zero as negative zero, so a place at the origin reads as placed.
fn place_word(v: f32) -> u32 {
    return select(bitcast<u32>(v), 0x80000000u, v == 0.0);
}
