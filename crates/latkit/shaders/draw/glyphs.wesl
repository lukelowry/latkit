// Glyphs: every labeled row's text where placement put it, faded in and out, over a halo of the
// background so it reads over whatever lies under it.

import package::lib::types::{CANDIDATE_WORDS, CANDIDATE_BOX, CANDIDATE_UV, CANDIDATE_COLOR, CANDIDATE_ALPHA};
import package::lib::bind::{frame, eye, mark, ramp};
import package::lib::project::culled;
import package::lib::color::output;

@group(2) @binding(8) var atlas: texture_2d<f32>;
@group(2) @binding(13) var<storage, read> labels: array<u32>;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) color: vec4f,
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) row: u32) -> Varyings {
    var out: Varyings;
    let at = mark.candidates + row * CANDIDATE_WORDS;
    let alpha = bitcast<f32>(labels[at + CANDIDATE_ALPHA]);
    if row >= mark.rows || !(alpha > 0.0) {
        out.clip = culled();
        return out;
    }
    let lo = vec2f(bitcast<f32>(labels[at + CANDIDATE_BOX]), bitcast<f32>(labels[at + CANDIDATE_BOX + 1u]));
    let hi = vec2f(bitcast<f32>(labels[at + CANDIDATE_BOX + 2u]), bitcast<f32>(labels[at + CANDIDATE_BOX + 3u]));
    let uv0 = labels[at + CANDIDATE_UV];
    let uv1 = labels[at + CANDIDATE_UV + 1u];
    let quad = vec2f(f32(corner & 1u), f32(corner >> 1u));
    // Snapped to whole target pixels, so text stays crisp.
    let p = round(mix(lo, hi, quad) * eye.pixel_ratio) / eye.pixel_ratio;
    let ndc = p / eye.size * 2.0 - 1.0;
    out.clip = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.uv = mix(vec2f(f32(uv0 & 0xffffu), f32(uv0 >> 16u)), vec2f(f32(uv1 & 0xffffu), f32(uv1 >> 16u)), quad);
    let color = unpack4x8unorm(labels[at + CANDIDATE_COLOR]);
    out.color = vec4f(color.rgb, color.a * alpha);
    return out;
}

fn coverage(uv: vec2f) -> f32 {
    return textureSampleLevel(atlas, ramp, uv / vec2f(textureDimensions(atlas)), 0.0).r;
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let text = coverage(v.uv);
    // The halo: the most coverage within its reach.
    var halo = 0.0;
    let reach = frame.halo * eye.pixel_ratio;
    if reach > 0.0 {
        for (var i = 0u; i < 8u; i++) {
            let angle = f32(i) * 0.785398;
            halo = max(halo, coverage(v.uv + vec2f(cos(angle), sin(angle)) * reach));
        }
    }
    let back = frame.background;
    let a_text = text * v.color.a;
    let a_halo = halo * v.color.a * back.a * 0.85;
    let a = a_text + a_halo * (1.0 - a_text);
    let rgb = v.color.rgb * a_text + back.rgb * a_halo * (1.0 - a_text);
    return output(vec4f(rgb, a));
}
