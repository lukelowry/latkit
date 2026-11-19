// Colors are sRGB-encoded, as in CSS, and packed RGBA8 in state.

import package::lib::types::{THEME_MISSING, COLORMAP_CYCLIC, COLORMAP_CATEGORICAL};
import package::lib::bind::{frame, colormaps, ramp, theme_word};
import package::lib::read::missing;

// Where `x` lies across `domain`: 0 at its start and 1 at its end, either way round, unclamped. A
// domain of one value puts every value in its middle.
fn unit(x: f32, domain: vec2f) -> f32 {
    let span = domain.y - domain.x;
    return select(0.5, (x - domain.x) / span, span != 0.0);
}

// `x` mapped linearly from `domain` onto `range`, clamped.
fn scale(x: f32, domain: vec2f, range: vec2f) -> f32 {
    if missing(x) {
        return x;
    }
    return mix(range.x, range.y, clamp(unit(x, domain), 0.0, 1.0));
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
    var t = unit(x, domain);
    t = select(clamp(t, 0.0, 1.0), fract(t), kind == COLORMAP_CYCLIC);
    return pack4x8unorm(textureSampleLevel(colormaps, ramp, vec2f((t * 255.0 + 0.5) / 256.0, 0.5), layer, 0.0));
}

// The least alpha of a pixel that hides what lies behind it: what an 8-bit target shows as fully
// opaque. Where depth varies, these pixels draw first and keep their depth, and every other pixel
// blends over them, so a partly covered pixel blends over what lies behind it, never over the
// background.
const OPAQUE: f32 = 1.0 - 0.5 / 255.0;

fn to_linear(c: vec3f) -> vec3f {
    return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

// The relative luminance of a color in linear light, and the contrast ratio between two, as WCAG
// defines them (see `legible` in `src/expr/ramp.rs`).
fn luminance(linear: vec3f) -> f32 {
    return dot(linear, vec3f(0.2126, 0.7152, 0.0722));
}

fn contrast(a: f32, b: f32) -> f32 {
    return (max(a, b) + 0.05) / (min(a, b) + 0.05);
}

fn to_srgb(c: vec3f) -> vec3f {
    return select(1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

// `color` (straight sRGB) made lighter or darker, toward whichever of white and black contrasts more
// with `ground`, until its contrast ratio with `ground` is at least `ratio`, as `legible` in
// `src/expr/ramp.rs` makes colormap colors read on the background. Luminance is linear in linear
// light, so the mix toward white or black that reaches the ratio has a closed form.
fn legible(color: vec3f, ground: vec3f, ratio: f32) -> vec3f {
    let c = to_linear(color);
    let g = luminance(to_linear(ground));
    let l = luminance(c);
    let lighter = contrast(1.0, g) >= contrast(0.0, g);
    let want = select((g + 0.05) / ratio - 0.05, ratio * (g + 0.05) - 0.05, lighter);
    let end = select(0.0, 1.0, lighter);
    let fitted = to_srgb(mix(c, vec3f(end), saturate((want - l) / (end - l))));
    return select(fitted, color, contrast(l, g) >= ratio);
}

// A premultiplied fragment color prepared for the target. sRGB values convert to linear when the
// target stores linear color.
fn output(premultiplied: vec4f) -> vec4f {
    if frame.linear == 0u || premultiplied.a <= 0.0 {
        return premultiplied;
    }
    return vec4f(to_linear(premultiplied.rgb / premultiplied.a) * premultiplied.a, premultiplied.a);
}
