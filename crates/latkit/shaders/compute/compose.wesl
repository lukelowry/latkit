// A shot's panels composed into the bytes a consumer takes, so no pixel is touched on the CPU: RGBA
// rows with straight alpha for an image, or NV12 planes (BT.709, limited range) for an encoder. One
// dispatch per panel writes its panel of the picture in whole words; a fill writes the background
// where no panel draws.

import package::lib::types::Compose;

@group(2) @binding(0) var panel: texture_2d<f32>;
@group(2) @binding(1) var<storage, read_write> bytes: array<u32>;
@group(2) @binding(2) var<uniform> compose: Compose;

// BT.709 luma weights of gamma-encoded color, and the scales of its two chroma differences.
const LUMA: vec3f = vec3f(0.2126, 0.7152, 0.0722);
const BLUE: f32 = 1.8556;
const RED: f32 = 1.5748;

// A panel's premultiplied color as the picture keeps it: straight with its alpha in a transparent
// image, else over black.
fn kept(c: vec4f) -> vec4f {
    if compose.alpha == 0u {
        return vec4f(c.rgb, 1.0);
    }
    if c.a <= 0.0 {
        return vec4f(0.0);
    }
    return vec4f(c.rgb / c.a, c.a);
}

// Writes the 4×2 block of NV12 at `at` from its eight colors, rows of four.
fn write_block(at: vec2u, rgb: array<vec3f, 8>) {
    var chroma = vec4f(0.0);
    for (var row = 0u; row < 2u; row++) {
        var luma = vec4f(0.0);
        for (var column = 0u; column < 4u; column++) {
            let c = rgb[row * 4u + column];
            let y = dot(c, LUMA);
            luma[column] = y;
            // Cb and Cr of each 2×2, averaged.
            let pair = column / 2u * 2u;
            chroma[pair] += (c.b - y) / BLUE * 0.25;
            chroma[pair + 1u] += (c.r - y) / RED * 0.25;
        }
        bytes[((at.y + row) * compose.picture.x + at.x) / 4u] = pack4x8unorm((16.0 + 219.0 * luma) / 255.0);
    }
    let words = compose.chroma + (at.y / 2u * compose.picture.x + at.x) / 4u;
    bytes[words] = pack4x8unorm((128.0 + 224.0 * chroma) / 255.0);
}

// One pixel of a panel as an RGBA word.
@compute @workgroup_size(16, 16)
fn rgba(@builtin(global_invocation_id) id: vec3u) {
    if any(id.xy >= compose.size) {
        return;
    }
    let at = compose.origin + id.xy;
    bytes[at.y * compose.picture.x + at.x] = pack4x8unorm(kept(textureLoad(panel, id.xy, 0)));
}

// One pixel of the background as an RGBA word.
@compute @workgroup_size(16, 16)
fn fill_rgba(@builtin(global_invocation_id) id: vec3u) {
    if any(id.xy >= compose.picture) {
        return;
    }
    bytes[id.y * compose.picture.x + id.x] = pack4x8unorm(compose.background);
}

// One 4×2 block of a panel as NV12: two words of luma and one of chroma.
@compute @workgroup_size(16, 16)
fn nv12(@builtin(global_invocation_id) id: vec3u) {
    let block = id.xy * vec2u(4u, 2u);
    if any(block >= compose.size) {
        return;
    }
    var rgb: array<vec3f, 8>;
    for (var i = 0u; i < 8u; i++) {
        rgb[i] = textureLoad(panel, block + vec2u(i % 4u, i / 4u), 0).rgb;
    }
    write_block(compose.origin + block, rgb);
}

// One 4×2 block of the background as NV12.
@compute @workgroup_size(16, 16)
fn fill_nv12(@builtin(global_invocation_id) id: vec3u) {
    let block = id.xy * vec2u(4u, 2u);
    if any(block >= compose.picture) {
        return;
    }
    let c = compose.background.rgb * compose.background.a;
    write_block(block, array<vec3f, 8>(c, c, c, c, c, c, c, c));
}
