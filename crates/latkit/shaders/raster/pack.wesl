// Converts row planes to the arena's existing packed row layout, keeping all addresses stable.
import package::lib::types::{WordStep, WORD_WIDTH, WORD_HEIGHT};
import package::lib::words::{fullscreen, word_index, word_quad};

@group(2) @binding(0) var a: texture_2d_array<u32>;
@group(2) @binding(1) var b: texture_2d_array<u32>;
@group(2) @binding(2) var c: texture_2d_array<u32>;
@group(2) @binding(3) var d: texture_2d_array<u32>;
@group(2) @binding(4) var e: texture_2d_array<u32>;
@group(2) @binding(5) var f: texture_2d_array<u32>;
@group(2) @binding(6) var g: texture_2d_array<u32>;
@group(2) @binding(7) var h: texture_2d_array<u32>;
@group(2) @binding(8) var<uniform> pack_step: WordStep;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return fullscreen(i); }

fn plane(row: u32, quad: u32) -> vec4u {
    let offset = 4u * row;
    switch quad {
        case 0u: { return word_quad(a, offset); }
        case 1u: { return word_quad(b, offset); }
        case 2u: { return word_quad(c, offset); }
        case 3u: { return word_quad(d, offset); }
        case 4u: { return word_quad(e, offset); }
        case 5u: { return word_quad(f, offset); }
        case 6u: { return word_quad(g, offset); }
        default: { return word_quad(h, offset); }
    }
}

fn packed(at: u32) -> u32 {
    if at >= pack_step.count { return 0u; }
    let word = at % pack_step.value;
    return plane(at / pack_step.value, word / 4u)[word % 4u];
}

@fragment
fn pack(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let at = word_index(position, pack_step.layer);
    if at >= pack_step.count { return vec4u(0u); }
    if pack_step.value % 4u == 0u {
        return plane(at / pack_step.value, (at % pack_step.value) / 4u);
    }
    return vec4u(packed(at), packed(at + 1u), packed(at + 2u), packed(at + 3u));
}
