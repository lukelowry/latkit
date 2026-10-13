// From positions to the screen. Positions are (high, low) pairs: their difference from the camera's
// center is taken in parts, so f64 data keeps its precision at any zoom.

import package::lib::types::{SPACE_EARTH};
import package::lib::bind::frame;

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;
const MAX_LATITUDE: f32 = 85.05113;
// Depth is reversed: the near plane is at 1 and the far plane at 0, which keeps precision far away.
const NEAR_Z: f32 = 1.0;
const FAR_Z: f32 = 0.0;

// The offset of `p` from the camera's center, in position units.
fn relative(hi: vec2f, lo: vec2f) -> vec2f {
    return (hi - frame.center_hi) + (lo - frame.center_lo);
}

fn mercator_y(latitude: f32) -> f32 {
    let lat = radians(clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE));
    return log(tan(PI / 4.0 + lat / 2.0));
}

// Web mercator radians from the center; near the center, a local expansion keeps precision.
fn mercator(hi: vec2f, lo: vec2f) -> vec2f {
    let d = relative(hi, lo);
    let lat = clamp(hi.y + lo.y, -MAX_LATITUDE, MAX_LATITUDE);
    let near = radians(d.y) / cos(radians(lat - 0.5 * d.y));
    let far = mercator_y(lat) - frame.mercator_y;
    return vec2f(radians(d.x), select(far, near, abs(d.y) < 0.25));
}

// `p` on the unit sphere, turned so the camera's center faces +z.
fn on_sphere(hi: vec2f, lo: vec2f) -> vec3f {
    let lon = radians(relative(hi, lo).x);
    let lat = radians(clamp(hi.y + lo.y, -90.0, 90.0));
    let lat0 = radians(frame.center_hi.y + frame.center_lo.y);
    let v = vec3f(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
    return vec3f(v.x, v.y * cos(lat0) - v.z * sin(lat0), v.y * sin(lat0) + v.z * cos(lat0));
}

// World coordinates: plane or plot units, or mercator radians morphing onto the globe.
fn world(hi: vec2f, lo: vec2f, z: f32) -> vec3f {
    if frame.space != SPACE_EARTH {
        return vec3f(relative(hi, lo), z);
    }
    let flat = vec3f(mercator(hi, lo), z);
    if frame.globe <= 0.0 {
        return flat;
    }
    let lat0 = radians(frame.center_hi.y + frame.center_lo.y);
    let s = on_sphere(hi, lo) * (1.0 + z);
    let round = vec3f(s.xy, s.z - 1.0) / cos(lat0);
    return mix(flat, round, frame.globe);
}

fn project(hi: vec2f, lo: vec2f, z: f32) -> vec4f {
    return frame.clip_from_world * vec4f(world(hi, lo, z), 1.0);
}

// Whether `p` is on the visible side of the globe.
fn facing(hi: vec2f, lo: vec2f) -> bool {
    return frame.globe < 0.5 || frame.space != SPACE_EARTH || on_sphere(hi, lo).z > 0.0;
}

// CSS pixels from the top left.
fn to_screen(clip: vec4f) -> vec2f {
    let ndc = clip.xy / clip.w;
    return (vec2f(ndc.x, -ndc.y) * 0.5 + 0.5) * frame.size;
}

// Clip coordinates for a screen point at the depth of `at`.
fn to_clip(screen: vec2f, at: vec4f) -> vec4f {
    let ndc = screen / frame.size * 2.0 - 1.0;
    return vec4f(vec2f(ndc.x, -ndc.y) * at.w, at.z, at.w);
}

// `clip` a little toward the camera, so a mark lying on a face draws over it.
fn nearer(clip: vec4f) -> vec4f {
    return vec4f(clip.xy, min(clip.z * 1.003, clip.w), clip.w);
}

// A position outside the clip volume: the primitive is dropped.
fn culled() -> vec4f {
    return vec4f(2.0, 2.0, 2.0, 1.0);
}
