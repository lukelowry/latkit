// Pack per-code flags into 64-code bitsets, then scan only one count per block. Gathering the
// bounded request list never scans all rows or reads intermediate results back to the CPU.
//
// No vector here is indexed by a runtime value. ANGLE's translation for Direct3D misreads such an
// index into a swizzle, `b.zw[i]`, so the gather read a block's seen bits as its wanted bits.
import package::lib::types::{WordStep, WANTED};
import package::lib::words::{word_quad, word_read, word_index, fullscreen};
@group(2) @binding(18) var source: texture_2d_array<u32>;
@group(2) @binding(20) var prefix: texture_2d_array<u32>;
@group(2) @binding(19) var<uniform> params: WordStep;

@vertex
fn vertex(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f { return fullscreen(v); }

// A block's seen bits, low then high 32 codes, then its wanted bits likewise.
@fragment
fn bits(@builtin(position) p: vec4f) -> @location(0) vec4u {
    let first = word_index(p, params.layer) / 4u * 64u;
    let low = flags(first);
    let high = flags(first + 32u);
    return vec4u(low.x, high.x, low.y, high.y);
}

// The seen bits and the wanted bits of the 32 codes from `first`.
fn flags(first: u32) -> vec2u {
    var seen = 0u;
    var wanted = 0u;
    for (var k = 0u; k < 32u; k++) {
        if first + k >= params.count { break; }
        let flag = word_quad(source, (first + k) * 4u).x;
        if flag != 0u { seen |= 1u << k; }
        if flag == 2u { wanted |= 1u << k; }
    }
    return vec2u(seen, wanted);
}

@fragment
fn counts(@builtin(position) p: vec4f) -> @location(0) vec4u {
    let first = word_index(p, params.layer);
    return vec4u(asked(first), asked(first + 1u), asked(first + 2u), asked(first + 3u));
}

// The number of codes block `block` asks for.
fn asked(block: u32) -> u32 {
    if block >= params.count { return 0u; }
    let b = word_quad(source, block * 4u);
    return population(b.z) + population(b.w);
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
    // The rank's code in the block: among its low 32 codes' wanted bits, or else its high.
    let b = word_quad(source, lo * 4u);
    let within = rank - word_read(prefix, lo);
    let low = population(b.z);
    if within < low { return lo * 64u + nth(b.z, within); }
    return lo * 64u + 32u + nth(b.w, within - low);
}

// The position of the set bit of `word` with `n` set bits below it.
fn nth(word: u32, n: u32) -> u32 {
    var left = n;
    for (var k = 0u; k < 32u; k++) {
        if (word & (1u << k)) != 0u {
            if left == 0u { return k; }
            left--;
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
