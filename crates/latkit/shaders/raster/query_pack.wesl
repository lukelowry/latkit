import package::lib::types::WordStep;
import package::lib::words::{word_quad, word_index, fullscreen};
@group(2) @binding(18) var first: texture_2d_array<u32>;
@group(2) @binding(19) var<uniform> params: WordStep;
@vertex
fn vertex(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f { return fullscreen(v); }

@fragment
fn counts(@builtin(position) p: vec4f) -> @location(0) vec4u {
    let at = word_index(p, params.layer);
    var out = vec4u(0u);
    for (var k = 0u; k < 4u; k++) {
        if at + k < params.count { out[k] = word_quad(first, (at + k) * 4u).x; }
    }
    return out;
}

@fragment
fn boxed(@builtin(position) p: vec4f) -> @location(0) vec4u {
    let start = word_index(p, params.layer) * 32u;
    var out = vec4u(0u);
    for (var lane = 0u; lane < 4u; lane++) {
        for (var bit = 0u; bit < 32u; bit++) {
            let row = start + lane * 32u + bit;
            if row < params.count && word_quad(first, row * 4u).x != 0u { out[lane] |= 1u << bit; }
        }
    }
    return out;
}
