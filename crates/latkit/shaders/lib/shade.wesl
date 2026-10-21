// Light: the ground's shadow map, and the earth's daylight. Casters draw into the map through the
// light's eye, blended by MIN: the most covered (1 − coverage), the lowest caster above the ground,
// and the highest (negated). The ground darkens at the level its lowest caster sets, sharp at contact
// and soft from high up; faces compare their height with the highest caster over them.

import package::lib::types::SPACE_EARTH;
import package::lib::bind::{frame, eye, ramp};

// How far the sun stands below the horizon, in the cosine of its angle, where night has fallen.
const TWILIGHT: f32 = 0.1;

// How lit the earth is at longitude and latitude `p`, in degrees: 1 by day, down to the night's
// brightness, eased across the terminator; 1 everywhere without daylight.
fn daylight(p: vec2f) -> f32 {
    let sun = frame.sun;
    if frame.space != SPACE_EARTH || dot(sun.xyz, sun.xyz) == 0.0 {
        return 1.0;
    }
    let r = radians(p);
    let n = vec3f(cos(r.y) * cos(r.x), cos(r.y) * sin(r.x), sin(r.y));
    return mix(sun.w, 1.0, smoothstep(-TWILIGHT, TWILIGHT * 0.5, dot(n, sun.xyz)));
}

// What a caster writes, blended by MIN.
fn caster(coverage: f32, height: f32) -> vec4f {
    let h = height + eye.lift;
    return vec4f(1.0 - coverage, h, -h, 0.0);
}

// Where world point `p` falls on the map, cast away from the light onto the ground, and its height.
fn on_map(p: vec3f) -> vec3f {
    let l = frame.shade.light.xyz;
    let ground = p.xy - l.xy / max(l.z, 1e-3) * p.z;
    let r = frame.shade.rect;
    return vec3f((ground - r.xy) / (r.zw - r.xy), p.z);
}

// How much light reaches world point `p`: 1 lit, down to 1 − the shadow's alpha.
fn lit(shadows: texture_2d<f32>, p: vec3f, ground: bool) -> f32 {
    if frame.shade.on == 0u {
        return 1.0;
    }
    let m = on_map(p);
    if any(m.xy < vec2f(0.0)) || any(m.xy > vec2f(1.0)) {
        return 1.0;
    }
    let uv = vec2f(m.x, 1.0 - m.y);
    let around = textureSampleLevel(shadows, ramp, uv, 3.0);
    let spread = frame.shade.light.w / max(frame.shade.texel, 1e-30);
    var shadow = 0.0;
    if ground {
        // The lowest caster around sets how far the shadow spreads.
        let gap = max(around.g, 0.0);
        let level = clamp(log2(max(gap * spread, 1.0)), 0.0, frame.shade.levels - 1.0);
        shadow = 1.0 - textureSampleLevel(shadows, ramp, uv, level).r;
    } else {
        // A face is shadowed where something stands higher over it on its light ray.
        let gap = max(-around.b - m.z, 0.0);
        let level = clamp(log2(max(gap * spread, 1.0)), 0.0, frame.shade.levels - 1.0);
        let top = -textureSampleLevel(shadows, ramp, uv, level).b;
        let bias = 2.0 * frame.shade.texel;
        shadow = smoothstep(bias, bias * 4.0, top - m.z);
    }
    return 1.0 - frame.shade.color.a * shadow;
}
