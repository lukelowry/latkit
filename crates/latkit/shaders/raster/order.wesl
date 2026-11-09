// Stable four-bit radix sorting, using block histograms, an exclusive scan, ranks, and point
// scatter. A record is four exact words: its unsigned key, then an opaque payload. Equal keys
// retain input order through every pass; no floating-point depth or nondeterministic blending is
// involved.
import package::lib::types::{WordStep, WORD_WIDTH, WORD_HEIGHT, RADIX_BLOCK, RADIX_BITS};
import package::lib::words::{word_read, word_quad, word_index, fullscreen};

@group(2) @binding(0) var records: texture_2d_array<u32>;
@group(2) @binding(1) var other: texture_2d_array<u32>;
@group(2) @binding(2) var<uniform> params: WordStep;

const BINS: u32 = 1u << RADIX_BITS;
const LANES: vec4u = vec4u(0u, 1u, 2u, 3u);

fn blocks() -> u32 { return (params.count + RADIX_BLOCK - 1u) / RADIX_BLOCK; }
fn digit(key: u32) -> u32 { return (key >> params.value) & (BINS - 1u); }
fn key(i: u32) -> u32 { return word_read(records, params.source + i * 4u); }
// A conversion, not `select`: GLSL ES 3.00 has no integer `mix` with a boolean vector.
fn ones(test: vec4<bool>) -> vec4u { return vec4u(test); }

@if(!scatter)
@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return fullscreen(i); }

// Each block's count of each digit, block by block. A texel counts four digits of one block, so
// each key is read once per four digits.
@if(!scatter)
@fragment
fn histogram(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let first = word_index(position, params.layer) - params.destination;
    let block = first / BINS;
    let bins = first % BINS + LANES;
    var result = vec4u(0u);
    for (var k = 0u; k < RADIX_BLOCK; k++) {
        let i = block * RADIX_BLOCK + k;
        if i < params.count { result += ones(vec4u(digit(key(i))) == bins); }
    }
    return result;
}

// The block counts digit by digit, as the scan orders them: every block's count of digit 0, then
// of digit 1, and so on. `records` holds them block by block.
@if(!scatter)
@fragment
fn by_digit(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let first = word_index(position, params.layer) - params.destination;
    let n = blocks();
    var result = vec4u(0u);
    for (var lane = 0u; lane < 4u; lane++) {
        let j = first + lane;
        result[lane] = word_read(records, params.source + (j % n) * BINS + j / n);
    }
    return result;
}

// Where each record moves: its digit's offset for its block (`other`, scanned), after the block's
// earlier records with that digit. A texel's four records share a block.
@if(!scatter)
@fragment
fn rank(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let first = word_index(position, params.layer) - params.destination;
    if first >= params.count { return vec4u(0u); }
    let block = first / RADIX_BLOCK;
    let n = blocks();
    var digits = vec4u(BINS);
    var result = vec4u(0u);
    for (var lane = 0u; lane < 4u; lane++) {
        if first + lane < params.count {
            digits[lane] = digit(key(first + lane));
            result[lane] = word_read(other, params.other + digits[lane] * n + block);
        }
    }
    for (var before = block * RADIX_BLOCK; before < min(first + 3u, params.count); before++) {
        result += ones(vec4u(before) < first + LANES) * ones(vec4u(digit(key(before))) == digits);
    }
    return result;
}

@if(scatter)
struct Moved {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) record: vec4u,
}

// Moves record `i` to its rank (`other`). Each texture layer the records land in draws every
// record and keeps those landing in it, reading only the rank of the rest.
@if(scatter)
@vertex
fn vertex(@builtin(instance_index) i: u32) -> Moved {
    let texel = params.destination / 4u + word_read(other, params.other + i);
    if texel / (WORD_WIDTH * WORD_HEIGHT) != params.layer { return Moved(vec4f(2, 2, 0, 1), vec4u(0u)); }
    let p = vec2f(f32(texel % WORD_WIDTH), f32(texel / WORD_WIDTH % WORD_HEIGHT)) + 0.5;
    let at = vec4f(p / vec2f(params.size) * vec2f(2, -2) + vec2f(-1, 1), 0, 1);
    return Moved(at, word_quad(records, params.source + i * 4u));
}

@if(scatter)
@fragment
fn scatter(moved: Moved) -> @location(0) vec4u { return moved.record; }
