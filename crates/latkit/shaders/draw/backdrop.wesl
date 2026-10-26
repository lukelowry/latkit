// The backdrop under every mark: a plane's or diagram's grid, or the earth's ground and graticule,
// lit by daylight, with the atmosphere around the globe. Lines are one pixel wide and antialiased
// per axis. Their spacing steps by powers of ten, and the next coarser spacing fades in as lines
// get dense, so no seam shows. Lines fade where the view grazes the ground, and on a plane, with
// distance from where the camera looks. The round globe writes its depth slightly below the ground,
// so marks behind it are hidden and marks on it still draw.

import package::lib::types::{SPACE_EARTH, SPACE_PLANE, SPACE_DIAGRAM, GRID_OFF, GRID_DOTS};
import package::lib::bind::{frame, eye};
import package::lib::color::output;
import package::lib::project::{PI, NEAR_Z, FAR_Z, globe_center};
import package::lib::daylight::daylight;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) ndc: vec2f,
}

// How far below the ground the globe's depth is written, in globe radii. It exceeds the sag of a
// chord a few degrees long, so paths and areas on the ground draw over the globe.
const GROUND_BIAS: f32 = 1e-3;

// A backdrop pixel: its color, and the ground's depth there.
struct Ground {
    color: vec4f,
    depth: f32,
}

struct Out {
    @location(0) color: vec4f,
    @builtin(frag_depth) depth: f32,
}

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> Varyings {
    let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    let ndc = uv * 2.0 - 1.0;
    return Varyings(vec4f(ndc, 0.0, 1.0), ndc);
}

// Coverage of grid lines `pitch` apart at `p`, where `p` changes by `w` per pixel. Lines are a
// pixel wide and fade out as their cells shrink to a few pixels.
fn lines(p: vec2f, w: vec2f, pitch: f32) -> f32 {
    let cells = max(w / pitch, vec2f(1e-12));
    let px = abs(fract(p / pitch + 0.5) - 0.5) / cells;
    let c = saturate(1.0 - px) * (1.0 - smoothstep(vec2f(0.08), vec2f(0.25), cells));
    return max(c.x, c.y);
}

// Coverage of grid dots `pitch` apart at `p`, where `p` changes by `w` per pixel. Dots are a CSS
// pixel across on any screen and fade out as their cells shrink to a few pixels.
fn dots(p: vec2f, w: vec2f, pitch: f32) -> f32 {
    let cells = max(w / pitch, vec2f(1e-12));
    let px = abs(fract(p / pitch + 0.5) - 0.5) / cells;
    return saturate(eye.pixel_ratio + 0.5 - length(px)) * (1.0 - smoothstep(0.08, 0.25, max(cells.x, cells.y)));
}

// Grid lines spaced `pitch` times a power of ten, with the power between `lowest` and `highest`.
// Lines draw at the spacing just under 20 pixels, and the next coarser spacing fades in as that one
// gets denser.
fn grid(p: vec2f, w: vec2f, pitch: f32, lowest: f32, highest: f32, dotted: bool) -> f32 {
    let level = clamp(log2(max(max(w.x, w.y) * 20.0 / pitch, 1e-30)) * 0.30103, lowest, highest);
    let k = floor(level);
    let t = level - k;
    let step = pitch * exp2(k * 3.3219281);
    if dotted {
        return max(dots(p, w, step), dots(p, w, step * 10.0) * t);
    }
    return max(lines(p, w, step), lines(p, w, step * 10.0) * t);
}

fn blend(color: vec4f, over: vec4f, coverage: f32) -> vec4f {
    return vec4f(mix(color.rgb, over.rgb, coverage * over.a), color.a);
}

// The plane's grid at `g`, where the view ray meets elevation 0, faded where the ray grazes the
// plane and away from the center.
fn plane(g: vec3f, d: vec3f, ahead: bool) -> vec4f {
    let p = g.xy + frame.center_hi + frame.center_lo;
    let w = fwidth(g.xy);
    let ground = frame.background;
    if frame.grid_kind == GRID_OFF {
        return ground;
    }
    let near = 1.0 - smoothstep(0.6, 1.0, length(g.xy) / max(frame.grid_fade, 1e-30));
    let fade = f32(ahead) * smoothstep(0.02, 0.15, abs(d.z)) * select(1.0, near, frame.grid_fade > 0.0);
    let c = grid(p, w, frame.grid_pitch, 0.0, 30.0, frame.grid_kind == GRID_DOTS) * fade;
    return blend(ground, frame.grid_color, c);
}

// Longitude and latitude in degrees at world point `w` on the flat map.
fn map_degrees(w: vec3f) -> vec2f {
    let lat = degrees(2.0 * atan(exp(w.y + frame.mercator_y)) - 0.5 * PI);
    return vec2f(frame.center_hi.x + frame.center_lo.x + degrees(w.x), lat);
}

// Longitude and latitude in degrees at world point `w` on the globe of `radius`.
fn globe_degrees(w: vec3f, radius: f32) -> vec2f {
    let lat0 = radians(frame.center_hi.y + frame.center_lo.y);
    let u = normalize(vec3f(w.xy, w.z + radius));
    let v = vec3f(u.x, u.y * cos(lat0) + u.z * sin(lat0), -u.y * sin(lat0) + u.z * cos(lat0));
    let lon = frame.center_hi.x + frame.center_lo.x + degrees(atan2(v.x, v.z));
    return vec2f(lon, degrees(asin(clamp(v.y, -1.0, 1.0))));
}

// The earth: the Mercator band or the globe's disc, blended as the projection morphs, lit by
// daylight, with the graticule on it and the atmosphere around the globe.
fn earth(o: vec3f, d: vec3f, g: vec3f, ahead: bool) -> Ground {
    // The flat map ends where Web Mercator does, at y = ±π.
    let band = PI - abs(g.y + frame.mercator_y);
    let flat = saturate(band / max(fwidth(band), 1e-9) + 0.5) * f32(ahead);
    let center = globe_center();
    let radius = -center.z;
    let to_center = center - o;
    let along = dot(to_center, d);
    let off = length(to_center - d * along);
    let miss = off - radius;
    let round = saturate(-miss / max(fwidth(miss), 1e-9) + 0.5) * f32(along > 0.0);
    let covered = mix(flat, round, frame.globe);
    let hit = o + d * (along - sqrt(max(radius * radius - off * off, 0.0)));
    let globe = frame.globe >= 0.5;
    var p: vec2f;
    var ground = frame.ground;
    if globe {
        p = globe_degrees(hit, radius);
    } else {
        p = map_degrees(g);
    }
    ground = vec4f(ground.rgb * daylight(p), ground.a);
    var color = blend(frame.background, ground, covered);
    let facing = dot(normalize(hit - center), -d);
    if frame.graticule != 0u {
        // Longitude jumps where it wraps. A second, shifted wrapping keeps the derivative steady
        // there.
        let wrapped = fract(p.x / 360.0) * 360.0;
        let w = vec2f(min(fwidth(p.x), fwidth(wrapped)), fwidth(p.y));
        let fade = select(smoothstep(0.02, 0.15, abs(d.z)), smoothstep(0.0, 0.3, facing), globe);
        color = blend(color, frame.grid_color, grid(p, w, 1.0, -2.0, 1.0, false) * fade * covered);
    }
    if frame.atmosphere.a > 0.0 && frame.globe > 0.0 {
        // A thin rim of atmosphere over the globe's edge, and a halo out to 1.045 globe radii. It
        // is lit where the sun is up over the ground nearest the view ray.
        let rim = pow(1.0 - saturate(facing), 6.0) * round;
        let halo = pow(1.0 - smoothstep(radius, radius * 1.045, off), 2.0) * (1.0 - round) * f32(along > 0.0);
        let below = daylight(globe_degrees(o + d * along, radius));
        let air = (rim + halo) * frame.atmosphere.a * frame.globe * mix(0.2, 1.0, below);
        color = vec4f(mix(color.rgb, frame.atmosphere.rgb, saturate(air)), color.a);
    }
    var depth = FAR_Z;
    if frame.globe >= 1.0 && round > 0.5 {
        let under = eye.clip_from_world * vec4f(hit - normalize(hit - center) * radius * GROUND_BIAS, 1.0);
        depth = clamp(under.z / under.w, FAR_Z, NEAR_Z);
    }
    return Ground(color, depth);
}

@fragment
fn fragment(v: Varyings) -> Out {
    let near = eye.world_from_clip * vec4f(v.ndc, NEAR_Z, 1.0);
    let far = eye.world_from_clip * vec4f(v.ndc, FAR_Z, 1.0);
    let o = near.xyz / near.w;
    let d = normalize(far.xyz / far.w - o);
    // Where the ray meets elevation 0.
    let t = -o.z / d.z;
    let g = o + d * max(t, 0.0);
    var color = frame.background;
    var depth = FAR_Z;
    if frame.space == SPACE_PLANE || frame.space == SPACE_DIAGRAM {
        color = plane(g, d, t > 0.0);
    } else if frame.space == SPACE_EARTH {
        let ground = earth(o, d, g, t > 0.0);
        color = ground.color;
        depth = ground.depth;
    }
    return Out(output(vec4f(color.rgb * color.a, color.a)), depth);
}
