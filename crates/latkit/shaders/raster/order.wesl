// Stable four-bit radix sorting, using histograms, an exclusive scan, and point scatter. A
// record is four exact words: its unsigned key, then an opaque payload. Equal keys retain input
// order through every pass; no floating-point depth or nondeterministic blending is involved.
import package::lib::types::{WordStep, WORD_WIDTH, WORD_HEIGHT, RADIX_BLOCK, RADIX_BITS};
import package::lib::words::{word_read, word_quad, word_index, fullscreen};

@group(2) @binding(0) var records: texture_2d_array<u32>;
@if(scatter)
@group(2) @binding(1) var offsets: texture_2d_array<u32>;
@group(2) @binding(2) var<uniform> params: WordStep;

fn blocks() -> u32 { return (params.count + RADIX_BLOCK - 1u) / RADIX_BLOCK; }
fn digit(key: u32) -> u32 { return (key >> params.value) & ((1u << RADIX_BITS) - 1u); }
fn key(i: u32) -> u32 { return word_read(records, params.source + i * 4u); }

@if(!scatter)
@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return fullscreen(i); }

@if(!scatter)
@fragment
fn histogram(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let first = word_index(position, params.layer) - params.destination;
    let n = blocks();
    var result = vec4u(0u);
    for (var lane = 0u; lane < 4u; lane++) {
        let bin = (first + lane) / n;
        let block = (first + lane) % n;
        for (var k = 0u; k < RADIX_BLOCK; k++) {
            let i = block * RADIX_BLOCK + k;
            if i < params.count { result[lane] += u32(digit(key(i)) == bin); }
        }
    }
    return result;
}

@if(scatter)
struct Moved {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) record: vec4u,
}

@if(scatter)
@vertex
fn vertex(@builtin(instance_index) i: u32) -> Moved {
    let record = word_quad(records, params.source + i * 4u);
    let bin = digit(record.x);
    let block = i / RADIX_BLOCK;
    var at = word_read(offsets, params.other + bin * blocks() + block);
    for (var before = block * RADIX_BLOCK; before < i; before++) {
        at += u32(digit(key(before)) == bin);
    }
    let texel = params.destination / 4u + at;
    if texel / (WORD_WIDTH * WORD_HEIGHT) != params.layer { return Moved(vec4f(2, 2, 0, 1), record); }
    let p = vec2f(f32(texel % WORD_WIDTH), f32(texel / WORD_WIDTH % WORD_HEIGHT)) + 0.5;
    return Moved(vec4f(p / vec2f(params.size) * vec2f(2, -2) + vec2f(-1, 1), 0, 1), record);
}

@if(scatter)
@fragment
fn scatter(moved: Moved) -> @location(0) vec4u { return moved.record; }
