// Linear-work scans and reductions implemented with core WebGL2 render passes. No output is
// sampled while attached. The CPU submits a logarithmic number of passes, never reads a total.
import package::lib::types::{WordStep, Pages, SCAN_BLOCK, WORD_WIDTH, WORD_HEIGHT};
import package::lib::words::{word_read, word_quad, word_index, fullscreen};

@if(!gather)
@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    return fullscreen(i);
}

@group(2) @binding(0) var source: texture_2d_array<u32>;
@group(2) @binding(1) var other: texture_2d_array<u32>;
@group(2) @binding(2) var<uniform> params: WordStep;
@if(gather)
@group(2) @binding(3) var<uniform> pages: Pages;

@if(gather)
struct Gathered {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) page: vec4u,
}

// One quad per page, over the rows of the attached layer it writes. Each corner is a bit of a mask,
// so no corner table is indexed.
@if(gather)
@vertex
fn vertex(@builtin(vertex_index) i: u32, @builtin(instance_index) n: u32) -> Gathered {
    let page = pages.at[n];
    let first = page.y / 4u / WORD_WIDTH % WORD_HEIGHT;
    let last = ((page.y + page.z) / 4u - 1u) / WORD_WIDTH % WORD_HEIGHT + 1u;
    let x = f32((0x32u >> i) & 1u) * f32(params.size.x);
    let y = mix(f32(first), f32(last), f32((0x2Cu >> i) & 1u));
    return Gathered(vec4f(vec2f(x, y) / vec2f(params.size) * vec2f(2, -2) + vec2f(-1, 1), 0, 1), page);
}

// Copies each texel of a page from the same offset in its source page. Texels of the covered rows
// outside the page belong to other allocations and keep their words.
@if(gather)
@fragment
fn gather(g: Gathered) -> @location(0) vec4u {
    let at = word_index(g.position, params.layer);
    if at < g.page.y || at >= g.page.y + g.page.z { discard; }
    return word_quad(source, g.page.x + (at - g.page.y));
}

fn index(position: vec4f) -> u32 {
    return word_index(position, params.layer) - params.destination;
}

fn input(at: u32) -> vec4u {
    let q = word_quad(source, params.source + at);
    // GLSL ES 3.00 has no integer-vector mix overload. Multiplying by a converted boolean
    // vector preserves every bit and translates without requiring an extension.
    return q * vec4u(vec4u(at) + vec4u(0u, 1u, 2u, 3u) < vec4u(params.count));
}

fn total(q: vec4u) -> u32 {
    return q.x + q.y + q.z + q.w;
}

@fragment
fn fill(@builtin(position) position: vec4f) -> @location(0) vec4u {
    return vec4u(params.value);
}

@fragment
fn copy(@builtin(position) position: vec4f) -> @location(0) vec4u {
    return word_quad(source, params.source + index(position));
}

// The sum of each block of 64 input words. Padding contributes zero.
@fragment
fn scan_totals(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position);
    var sums = vec4u(0u);
    for (var lane = 0u; lane < 4u; lane++) {
        let start = (i + lane) * SCAN_BLOCK;
        for (var k = 0u; k < SCAN_BLOCK && start + k < params.count; k += 4u) {
            sums[lane] += total(input(start + k));
        }
    }
    return sums;
}

// The exclusive scan within a block, plus that block's recursively scanned total. `value` says
// whether the block totals exist; the base case is one block. The extra output at count is the
// total, so consumers never need a separate reduction or a synchronous readback.
@fragment
fn scan(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position);
    let block = select(0u, i / SCAN_BLOCK, params.value != 0u);
    var before = 0u;
    if params.value != 0u {
        before = word_read(other, params.other + block);
    }
    for (var k = block * SCAN_BLOCK; k < i && k < params.count; k += 4u) {
        before += total(input(k));
    }
    var q = vec4u(0u);
    if i < params.count { q = input(i); }
    return vec4u(before) + vec4u(0u, q.x, q.x + q.y, q.x + q.y + q.z);
}

// Component-wise maximum. Ordered-float minima use complemented words, so the same operation
// reduces fitted bounds/domains without float render targets, blending, or extensions.
@fragment
fn maximum(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let record = index(position) / 4u;
    var result = vec4u(0u);
    for (var k = 0u; k < SCAN_BLOCK; k++) {
        let i = (record * SCAN_BLOCK + k) * 4u;
        if i >= params.count { break; }
        result = max(result, word_quad(source, params.source + i));
    }
    return result;
}

// Lexicographic maximum selects a whole record, preserving the payload of the winner.
@fragment
fn greatest(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let record = index(position) / 4u;
    var result = vec4u(0u);
    for (var k = 0u; k < SCAN_BLOCK; k++) {
        let i = (record * SCAN_BLOCK + k) * 4u;
        if i >= params.count { break; }
        let v = word_quad(source, params.source + i);
        if v.x > result.x || (v.x == result.x && (v.y > result.y || (v.y == result.y && v.z > result.z))) { result = v; }
    }
    return result;
}
