// Colors are sRGB-encoded, as in CSS, and packed RGBA8 in state.

import package::lib::types::{THEME_MISSING, COLORMAP_CYCLIC, COLORMAP_CATEGORICAL};
import package::lib::bind::{frame, colormaps, ramp, theme_word};
import package::lib::read::missing;

// `x` mapped linearly from `domain` onto `range`, clamped.
fn scale(x: f32, domain: vec2f, range: vec2f) -> f32 {
    if missing(x) {
        return x;
    }
    let span = domain.y - domain.x;
    let t = select(0.5, (x - domain.x) / span, span != 0.0);
    return mix(range.x, range.y, clamp(t, 0.0, 1.0));
}

// `x` through colormap `layer` over `domain`, packed RGBA8. The theme's missing color if `x` is
// missing.
fn colormap(layer: u32, kind: u32, x: f32, domain: vec2f) -> u32 {
    if missing(x) {
        return theme_word(THEME_MISSING);
    }
    if kind == COLORMAP_CATEGORICAL {
        let bin = u32(abs(floor(x))) % 256u;
        return pack4x8unorm(textureLoad(colormaps, vec2u(bin, 0u), layer, 0));
    }
    var t = (x - domain.x) / max(domain.y - domain.x, 1e-30);
    t = select(clamp(t, 0.0, 1.0), fract(t), kind == COLORMAP_CYCLIC);
    return pack4x8unorm(textureSampleLevel(colormaps, ramp, vec2f((t * 255.0 + 0.5) / 256.0, 0.5), layer, 0.0));
}

fn to_linear(c: vec3f) -> vec3f {
    return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

// A premultiplied fragment color prepared for the target. sRGB values convert to linear when the
// target stores linear color.
fn output(premultiplied: vec4f) -> vec4f {
    if frame.linear == 0u || premultiplied.a <= 0.0 {
        return premultiplied;
    }
    return vec4f(to_linear(premultiplied.rgb / premultiplied.a) * premultiplied.a, premultiplied.a);
}
