// Projection from positions to the screen. Positions are (high, low) f32 pairs, and their offset
// from the camera's center is computed part by part, so f64 data keeps its precision at any zoom.
// Every pass projects through the view's `eye`.

import package::lib::types::{SPACE_EARTH, PROJECTION_PLANAR, PROJECTION_MERCATOR, PROJECTION_GLOBE, PROJECTION_DYNAMIC};
import package::lib::bind::{frame, eye};

// Geometry uses a fixed scene projection; shared state kernels read the current view.
override PROJECTION: u32 = PROJECTION_DYNAMIC;
fn geographic() -> bool {
    if PROJECTION == PROJECTION_DYNAMIC { return frame.space == SPACE_EARTH; }
    return PROJECTION != PROJECTION_PLANAR;
}

fn globe_amount() -> f32 {
    if PROJECTION == PROJECTION_GLOBE { return 1.0; }
    if PROJECTION != PROJECTION_DYNAMIC { return 0.0; }
    return frame.globe;
}

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;
const MAX_LATITUDE: f32 = 85.05113;
// Depth is reversed: the near plane is at 1 and the far plane at 0, for precision far away.
const NEAR_Z: f32 = 1.0;
const FAR_Z: f32 = 0.0;

// The offset of position (`hi`, `lo`) from the camera's center, in position units.
fn relative(hi: vec2f, lo: vec2f) -> vec2f {
    return (hi - frame.center_hi) + (lo - frame.center_lo);
}

fn mercator_y(latitude: f32) -> f32 {
    let lat = radians(clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE));
    return log(tan(PI / 4.0 + lat / 2.0));
}

// Web Mercator coordinates relative to the center, in radians. Near the center, a local expansion
// keeps precision.
fn mercator(hi: vec2f, lo: vec2f) -> vec2f {
    let d = relative(hi, lo);
    let lat = clamp(hi.y + lo.y, -MAX_LATITUDE, MAX_LATITUDE);
    // select evaluates both formulas. Nearby rows need only the precise local expansion;
    // distant rows need only Mercator, avoiding unused transcendental operations either way.
    if abs(d.y) < 0.25 {
        return vec2f(radians(d.x), radians(d.y) / cos(radians(lat - 0.5 * d.y)));
    }
    return vec2f(radians(d.x), mercator_y(lat) - frame.mercator_y);
}

// The position on the unit sphere, rotated so the camera's center faces +z.
fn on_sphere(hi: vec2f, lo: vec2f) -> vec3f {
    let lon = radians(relative(hi, lo).x);
    let lat = radians(clamp(hi.y + lo.y, -90.0, 90.0));
    let v = vec3f(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
    return vec3f(v.x, v.y * frame.latitude_cos - v.z * frame.latitude_sin,
        v.y * frame.latitude_sin + v.z * frame.latitude_cos);
}

// Parallax changes a position's apparent height, but not its longitude or latitude. Project those
// coordinates once, sharing the expensive geographic functions between both heights.
struct Surfaces {
    raised: vec3f,
    apparent: vec3f,
}

fn planar_surfaces(hi: vec2f, lo: vec2f, elevation: f32) -> Surfaces {
    let xy = relative(hi, lo);
    return Surfaces(vec3f(xy, elevation), vec3f(xy, eye.parallax * elevation));
}

fn mercator_surfaces(hi: vec2f, lo: vec2f, elevation: f32) -> Surfaces {
    let xy = mercator(hi, lo);
    return Surfaces(vec3f(xy, radians(elevation)), vec3f(xy, radians(eye.parallax * elevation)));
}

fn globe_surfaces(hi: vec2f, lo: vec2f, elevation: f32) -> Surfaces {
    let unit = on_sphere(hi, lo);
    let s = unit * (1.0 + radians(elevation));
    let a = unit * (1.0 + radians(eye.parallax * elevation));
    let round = vec3f(s.xy, s.z - 1.0) / frame.latitude_cos;
    let around = vec3f(a.xy, a.z - 1.0) / frame.latitude_cos;
    return Surfaces(round, around);
}

fn surfaces(hi: vec2f, lo: vec2f, elevation: f32) -> Surfaces {
    // Keep the specialization visible here: pruning removes the unused coordinate systems
    // and all their helpers before a driver sees the module.
    switch PROJECTION {
        case PROJECTION_PLANAR: { return planar_surfaces(hi, lo, elevation); }
        case PROJECTION_MERCATOR: { return mercator_surfaces(hi, lo, elevation); }
        case PROJECTION_GLOBE: { return globe_surfaces(hi, lo, elevation); }
        default: {}
    }
    if frame.space != SPACE_EARTH { return planar_surfaces(hi, lo, elevation); }
    if frame.globe <= 0.0 { return mercator_surfaces(hi, lo, elevation); }
    let round = globe_surfaces(hi, lo, elevation);
    if frame.globe >= 1.0 { return round; }
    let flat = mercator_surfaces(hi, lo, elevation);
    return Surfaces(mix(flat.raised, round.raised, frame.globe), mix(flat.apparent, round.apparent, frame.globe));
}

// The world point a row at a position draws at. A row appears raised by `eye.parallax` of its
// elevation and lies as deep as raised by all of it: on the eye's ray through where it appears.
// Looking straight down, elevation so sets only depth, and every row draws over its ground
// position. Tilting the camera eases the parallax to 1, where the point is the raised position.
fn world(hi: vec2f, lo: vec2f, elevation: f32) -> vec3f {
    let projected = surfaces(hi, lo, elevation);
    let raised = projected.raised;
    if eye.parallax >= 1.0 || elevation == 0.0 {
        return raised;
    }
    let apparent = projected.apparent;
    let depth = clip_of(apparent).w;
    if !(depth > 0.0) {
        return raised;
    }
    // Past the globe's edge, a row hides where it appears.
    if !shows(apparent) {
        return apparent;
    }
    let e = eye.position.xyz;
    return e + (apparent - e) * (clip_of(raised).w / depth);
}

fn clip_of(w: vec3f) -> vec4f {
    return eye.clip_from_world * vec4f(w, 1.0);
}

fn project(hi: vec2f, lo: vec2f, z: f32) -> vec4f {
    return clip_of(world(hi, lo, z));
}

// A plot has no pitch, bearing, or elevation: its x/y axes are independent, and every point
// shares depth and w. Preserve the same high/low subtraction and matrix coefficients while
// omitting the zero terms of the general perspective transform.
fn plot_clip(hi: vec2f, lo: vec2f) -> vec4f {
    let p = relative(hi, lo);
    let m = eye.clip_from_world;
    return vec4f(vec2f(m[0].x, m[1].y) * p + m[3].xy, m[3].zw);
}

// The globe's center in world units. The globe is a sphere of radius `-center.z` whose top touches
// the ground at the camera's center.
fn globe_center() -> vec3f {
    return vec3f(0.0, 0.0, -frame.globe_radius);
}

// Whether world point `w` is on the visible side of the globe. On the round globe, it must lie in
// front of the plane of the globe's visible edge, a test that is exact at any pitch. On the map, or
// while the globe morphs, everything shows, and the ground's depth hides what lies behind it.
fn shows(w: vec3f) -> bool {
    if PROJECTION == PROJECTION_PLANAR { return true; }
    if PROJECTION == PROJECTION_MERCATOR { return true; }
    if PROJECTION == PROJECTION_DYNAMIC {
        if frame.space != SPACE_EARTH || frame.globe < 1.0 { return true; }
    }
    let c = globe_center();
    return dot(w - c, eye.position.xyz - w) > 0.0;
}

// A clip position in CSS pixels from the top left.
fn to_screen(clip: vec4f) -> vec2f {
    let ndc = clip.xy / clip.w;
    return (vec2f(ndc.x, -ndc.y) * 0.5 + 0.5) * eye.size;
}

// Clip coordinates for a screen point at the depth of `at`.
fn to_clip(screen: vec2f, at: vec4f) -> vec4f {
    let ndc = screen / eye.size * 2.0 - 1.0;
    return vec4f(vec2f(ndc.x, -ndc.y) * at.w, at.z, at.w);
}

// `clip`, of world point `w`, with its depth moved toward the camera by `px` CSS pixels of world
// length there, at most halfway to the camera. A CSS pixel spans 1 / px_per_unit world units at the
// focal distance, 1.5 view heights from the camera, and proportionally more further away.
fn toward_eye(clip: vec4f, w: vec3f, px: f32) -> vec4f {
    let toward = eye.position.xyz - w;
    let away = length(toward);
    if !(away > 0.0) || !(px > 0.0) || !(clip.w > 0.0) {
        return clip;
    }
    let along = min(px * clip.w / (1.5 * eye.size.y * eye.px_per_unit.x), 0.5 * away);
    let moved = clip_of(w + toward / away * along);
    return vec4f(clip.xy, moved.z / moved.w * clip.w, clip.w);
}

// `clip` moved slightly toward the camera, keeping strokes above coplanar ground geometry.
fn nearer(clip: vec4f) -> vec4f {
    return vec4f(clip.xy, min(clip.z * 1.003, clip.w), clip.w);
}

// A position outside the clip volume: the primitive is dropped.
fn culled() -> vec4f {
    return vec4f(2.0, 2.0, 2.0, 1.0);
}
