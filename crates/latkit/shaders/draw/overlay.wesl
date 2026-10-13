// The overlay: lines and runs of text in CSS pixels over every mark, such as a plot's axes.

import package::lib::types::{Sprite, SPRITE_TEXT};
import package::lib::bind::{frame, ramp};
import package::lib::color::output;

@group(2) @binding(7) var<storage, read> sprites: array<Sprite>;
@group(2) @binding(8) var atlas: texture_2d<f32>;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) p: vec2f,
    @location(1) @interpolate(flat) sprite: u32,
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) sprite: u32) -> Varyings {
    let s = sprites[sprite];
    let quad = vec2f(f32(corner & 1u), f32(corner >> 1u));
    var p = mix(s.a, s.b, quad);
    if s.kind != SPRITE_TEXT {
        let dir = normalize(s.b - s.a + vec2f(1e-6, 0.0));
        let reach = 0.5 * s.width + 1.0;
        let along = mix(s.a - dir * reach, s.b + dir * reach, quad.x);
        p = along + vec2f(-dir.y, dir.x) * (quad.y * 2.0 - 1.0) * reach;
    }
    let ndc = p / frame.size * 2.0 - 1.0;
    return Varyings(vec4f(ndc.x, -ndc.y, 0.0, 1.0), p, sprite);
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let s = sprites[v.sprite];
    var coverage = 0.0;
    if s.kind == SPRITE_TEXT {
        let t = (v.p - s.a) / max(s.b - s.a, vec2f(1e-6));
        let uv = mix(s.uv.xy, s.uv.zw, t) / vec2f(textureDimensions(atlas));
        coverage = textureSampleLevel(atlas, ramp, uv, 0.0).r;
    } else {
        let ab = s.b - s.a;
        let t = clamp(dot(v.p - s.a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        let d = length(v.p - (s.a + ab * t)) - 0.5 * s.width;
        coverage = clamp(0.5 - d * frame.pixel_ratio, 0.0, 1.0);
    }
    let a = s.color.a * coverage;
    return output(vec4f(s.color.rgb * a, a));
}
