// Pack per-code flags into 64-code bitsets, then scan only one count per block. Gathering the
// bounded request list never scans all rows or reads intermediate results back to the CPU.
import package::lib::types::{WordStep, WANTED};
import package::lib::words::{word_quad, word_read, word_index, fullscreen};
@group(2) @binding(18) var source: texture_2d_array<u32>;
@group(2) @binding(20) var prefix: texture_2d_array<u32>;
@group(2) @binding(19) var<uniform> params: WordStep;

@vertex
fn vertex(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f { return fullscreen(v); }

@fragment
fn bits(@builtin(position) p: vec4f) -> @location(0) vec4u {
    let first = word_index(p, params.layer) / 4u * 64u;
    var out = vec4u(0u);
    for (var k = 0u; k < 64u; k++) {
        if first + k >= params.count { break; }
        let flag = word_quad(source, (first + k) * 4u).x;
        let bit = 1u << (k % 32u);
        if flag != 0u { out[k / 32u] |= bit; }
        if flag == 2u { out[2u + k / 32u] |= bit; }
    }
    return out;
}

@fragment
fn counts(@builtin(position) p: vec4f) -> @location(0) vec4u {
    let first = word_index(p, params.layer);
    var out = vec4u(0u);
    for (var k = 0u; k < 4u; k++) {
        if first + k >= params.count { break; }
        let b = word_quad(source, (first + k) * 4u).zw;
        out[k] = population(b.x) + population(b.y);
    }
    return out;
}

fn wanted(at: u32) -> u32 {
    let total = word_read(prefix, params.count);
    if at == 0u { return total; }
    let rank = at - 1u;
    if rank >= min(total, WANTED) { return 0u; }
    var lo = 0u;
    var hi = params.count;
    while lo < hi {
        let mid = lo + (hi - lo) / 2u;
        if word_read(prefix, mid + 1u) <= rank { lo = mid + 1u; } else { hi = mid; }
    }
    let b = word_quad(source, lo * 4u).zw;
    var before = word_read(prefix, lo);
    for (var bit = 0u; bit < 64u; bit++) {
        if (b[bit / 32u] & (1u << (bit % 32u))) != 0u {
            if before == rank { return lo * 64u + bit; }
            before++;
        }
    }
    return 0u;
}

@fragment
fn gather(@builtin(position) p: vec4f) -> @location(0) vec4u {
    let first = word_index(p, params.layer);
    return vec4u(wanted(first), wanted(first + 1u), wanted(first + 2u), wanted(first + 3u));
}

@fragment
fn seen(@builtin(position) p: vec4f) -> @location(0) vec4u {
    let first = word_index(p, params.layer) / 4u * 2u;
    let a = word_quad(source, first * 4u).xy;
    var b = vec2u(0u);
    if first + 1u < params.count { b = word_quad(source, (first + 1u) * 4u).xy; }
    return vec4u(a, b);
}

// Parallel bit count using only GLSL ES 3.00 integer operations.
fn population(value: u32) -> u32 {
 var x = value - ((value >> 1u) & 0x55555555u);
 x = (x & 0x33333333u) + ((x >> 2u) & 0x33333333u);
 x = (x + (x >> 4u)) & 0x0f0f0f0fu;
 return (x * 0x01010101u) >> 24u;
}
