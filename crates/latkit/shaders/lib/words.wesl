// Bit-exact scalar and packed reads shared by every integer-texture algorithm.
import package::lib::types::{WORD_WIDTH, WORD_HEIGHT};

fn word_quad(words: texture_2d_array<u32>, at: u32) -> vec4u {
    let texel = at / 4u;
    return textureLoad(words, vec2i(i32(texel % WORD_WIDTH), i32(texel / WORD_WIDTH % WORD_HEIGHT)),
        i32(texel / (WORD_WIDTH * WORD_HEIGHT)), 0);
}

fn word_read(words: texture_2d_array<u32>, at: u32) -> u32 {
    return word_quad(words, at)[at % 4u];
}

// Four words at any address. Aligned row records take one fetch; an unaligned range takes two.
fn word_four(words: texture_2d_array<u32>, at: u32) -> vec4u {
    let a = word_quad(words, at);
    let lane = at % 4u;
    if lane == 0u { return a; }
    let b = word_quad(words, at + 4u);
    switch lane {
        case 1u: { return vec4u(a.yzw, b.x); }
        case 2u: { return vec4u(a.zw, b.xy); }
        default: { return vec4u(a.w, b.xyz); }
    }
}

fn word_index(position: vec4f, layer: u32) -> u32 {
    return ((layer * WORD_HEIGHT + u32(position.y)) * WORD_WIDTH + u32(position.x)) * 4u;
}

// A fullscreen triangle. A scissor restricts each pass to complete output texels.
fn fullscreen(i: u32) -> vec4f {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
