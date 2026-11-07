// The overlay: lines, boxes, filled rectangles, and runs of text in CSS pixels, drawn over every
// mark. It draws a plot's axes, a scene's title and legends and their backdrops, a selection box,
// and a connection being drawn. Text samples the atlas's distance field, and its quad covers the
// field's spread.

import package::lib::types::{Sprite, SPRITE_TEXT, SPRITE_BOX, SPRITE_FILL, TEXT_SPREAD};
import package::lib::bind::{eye, ramp};
import package::lib::mark::coverage;
import package::lib::project::to_clip;
import package::lib::color::output;
import package::lib::words::word_quad;

@group(2) @binding(7) var sprites: texture_2d_array<u32>;
@group(2) @binding(8) var atlas: texture_2d<f32>;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) p: vec2f,
    @location(1) @interpolate(flat) sprite: u32,
}

fn sprite_at(i: u32) -> Sprite {
    let at = i * 16u;
    let ends = bitcast<vec4f>(word_quad(sprites, at));
    let uv = bitcast<vec4f>(word_quad(sprites, at + 4u));
    let color = bitcast<vec4f>(word_quad(sprites, at + 8u));
    let style = word_quad(sprites, at + 12u);
    return Sprite(ends.xy, ends.zw, uv, color, bitcast<f32>(style.x), style.y);
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) sprite: u32) -> Varyings {
    let s = sprite_at(sprite);
    let quad = vec2f(f32(corner & 1u), f32(corner >> 1u));
    var p = mix(s.a, s.b, quad);
    if s.kind == SPRITE_BOX {
        p = mix(min(s.a, s.b) - 1.0, max(s.a, s.b) + 1.0, quad);
    } else if s.kind == SPRITE_FILL {
        p = mix(min(s.a, s.b), max(s.a, s.b), quad);
    } else if s.kind != SPRITE_TEXT {
        let dir = normalize(s.b - s.a + vec2f(1e-6, 0.0));
        let reach = 0.5 * s.width + 1.0;
        let along = mix(s.a - dir * reach, s.b + dir * reach, quad.x);
        p = along + vec2f(-dir.y, dir.x) * (quad.y * 2.0 - 1.0) * reach;
    }
    return Varyings(to_clip(p, vec4f(0.0, 0.0, 0.0, 1.0)), p, sprite);
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let s = sprite_at(v.sprite);
    var c = 0.0;
    var color = s.color;
    if s.kind == SPRITE_TEXT {
        let t = (v.p - s.a) / max(s.b - s.a, vec2f(1e-6));
        let uv = mix(s.uv.xy, s.uv.zw, t) / vec2f(textureDimensions(atlas));
        // CSS pixels per texel, then target pixels past the text's edge.
        let scale = (s.b.y - s.a.y) / max(s.uv.w - s.uv.y, 1e-6);
        let d = (textureSampleLevel(atlas, ramp, uv, 0.0).r - 0.5) * 2.0 * TEXT_SPREAD * scale * eye.pixel_ratio;
        c = clamp(0.5 + d, 0.0, 1.0);
    } else if s.kind == SPRITE_BOX {
        let lo = min(s.a, s.b);
        let hi = max(s.a, s.b);
        let inside = all(v.p >= lo) && all(v.p <= hi);
        let edge = min(min(v.p.x - lo.x, hi.x - v.p.x), min(v.p.y - lo.y, hi.y - v.p.y));
        let line = coverage(abs(edge) - 0.5 * s.width);
        c = max(line, f32(inside) * 0.15);
    } else if s.kind == SPRITE_FILL && s.width > 0.0 {
        // A rectangle with corners rounded by its width.
        let half = 0.5 * abs(s.b - s.a);
        let q = abs(v.p - 0.5 * (s.a + s.b)) - half + s.width;
        c = coverage(length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - s.width);
    } else if s.kind == SPRITE_FILL {
        c = 1.0;
    } else {
        let ab = s.b - s.a;
        let t = clamp(dot(v.p - s.a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        let d = length(v.p - (s.a + ab * t)) - 0.5 * s.width;
        c = coverage(d);
    }
    let a = color.a * c;
    return output(vec4f(color.rgb * a, a));
}
