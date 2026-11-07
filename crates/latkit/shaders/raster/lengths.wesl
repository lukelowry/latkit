// Segmented floating-point prefix sums. A record is (row, length bits, 0, 0). Rows are contiguous;
// sums reset at each row, so long scenes never lose short distances by subtracting global sums.
import package::lib::types::{WordStep, SCAN_BLOCK};
import package::lib::words::{word_quad, word_index, fullscreen};
@group(2) @binding(0) var source: texture_2d_array<u32>;
@group(2) @binding(1) var other: texture_2d_array<u32>;
@group(2) @binding(2) var<uniform> params: WordStep;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return fullscreen(i); }
fn input(i: u32) -> vec4u { return word_quad(source, params.source + 4u * i); }
fn index(position: vec4f) -> u32 { return (word_index(position, params.layer) - params.destination) / 4u; }

@fragment
fn totals(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let first = index(position) * SCAN_BLOCK;
    let end = min(first + SCAN_BLOCK, params.count);
    let row = input(end - 1u).x;
    var sum = 0.0;
    for (var j = end; j > first; j--) {
        let q = input(j - 1u);
        if q.x != row { break; }
        sum += bitcast<f32>(q.y);
    }
    return vec4u(row, bitcast<u32>(sum), 0u, 0u);
}

@fragment
fn scan(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position);
    let block = i / SCAN_BLOCK;
    let first = block * SCAN_BLOCK;
    let row = input(i).x;
    var sum = 0.0;
    var boundary = false;
    let end = i + select(0u, 1u, (params.value & 2u) != 0u);
    for (var j = end; j > first; j--) {
        let q = input(j - 1u);
        if q.x != row { boundary = true; break; }
        sum += bitcast<f32>(q.y);
    }
    if !boundary && block > 0u && (params.value & 1u) != 0u {
        let carry = word_quad(other, params.other + 4u * (block - 1u));
        if carry.x == row { sum += bitcast<f32>(carry.y); }
    }
    return vec4u(row, bitcast<u32>(sum), 0u, 0u);
}
