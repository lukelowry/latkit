// Bit-exact scalar and packed reads shared by every integer-texture algorithm.
import package::lib::types::{WORD_WIDTH, WORD_HEIGHT};

fn word_quad(words: texture_2d_array<u32>, at: u32) -> vec4u {
    let texel = at / 4u;
    return textureLoad(words, vec2i(i32(texel % WORD_WIDTH), i32(texel / WORD_WIDTH % WORD_HEIGHT)),
        i32(texel / (WORD_WIDTH * WORD_HEIGHT)), 0);
}

// Word `lane` of `v`. A vector indexed by a runtime value, `v[lane]`, becomes a function with a
// switch in ANGLE's translation for D3D, compiled again wherever it is read, so selects pick it.
fn lane_word(v: vec4u, lane: u32) -> u32 {
    return select(select(v.x, v.y, lane == 1u), select(v.z, v.w, lane == 3u), lane >= 2u);
}

fn word_read(words: texture_2d_array<u32>, at: u32) -> u32 {
    return lane_word(word_quad(words, at), at % 4u);
}

fn word_index(position: vec4f, layer: u32) -> u32 {
    return ((layer * WORD_HEIGHT + u32(position.y)) * WORD_WIDTH + u32(position.x)) * 4u;
}

// A fullscreen triangle. A scissor restricts each pass to complete output texels.
fn fullscreen(i: u32) -> vec4f {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
