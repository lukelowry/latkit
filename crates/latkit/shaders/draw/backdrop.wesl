// The backdrop under every mark: a plane's or diagram's grid, or the earth's ground and graticule,
// lit by daylight, with the atmosphere around the globe. Lines are one pixel wide and antialiased
// per axis. Each axis spaces its lines by the finest step of 1, 2, and 5 times a power of ten (30°
// and 90° past 10° on the earth) at least the theme's grid spacing apart. The next coarser step
// always draws, and the finer one fades out as it nears that spacing, so no seam shows. Lines fade where the view grazes the ground, and on a plane, with
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

// Coverage of grid lines `pitch` apart on each axis at `p`, where `p` changes by `w` per pixel, per
// axis. Lines are a pixel wide and fade out as their cells shrink to a few pixels.
fn lines(p: vec2f, w: vec2f, pitch: vec2f) -> vec2f {
    let cells = max(w / pitch, vec2f(1e-12));
    let px = abs(fract(p / pitch + 0.5) - 0.5) / cells;
    return saturate(1.0 - px) * (1.0 - smoothstep(vec2f(0.08), vec2f(0.25), cells));
}

// Coverage of grid dots `pitch` apart at `p`, where `p` changes by `w` per pixel. Dots are a CSS
// pixel across on any screen and fade out as their cells shrink to a few pixels.
fn dots(p: vec2f, w: vec2f, pitch: f32) -> f32 {
    let cells = max(w / pitch, vec2f(1e-12));
    let px = abs(fract(p / pitch + 0.5) - 0.5) / cells;
    return saturate(eye.pixel_ratio + 0.5 - length(px)) * (1.0 - smoothstep(0.08, 0.25, max(cells.x, cells.y)));
}

// The finest step at least `least`, in multiples of `pitch` from `lowest` to `highest`: 1, 2, or 5
// times a power of ten, and on the earth (`degrees`) 30 and 90 past 10.
fn nice(least: f32, pitch: f32, lowest: f32, highest: f32, degrees: bool) -> f32 {
    let x = clamp(least / pitch, lowest, highest);
    var decade = exp2(floor(log2(x) * 0.30103) * 3.3219281);
    // Rounding can leave the decade a step off.
    decade = select(decade, decade * 10.0, x > decade * 10.0001);
    decade = select(decade, decade * 0.1, x < decade * 0.9999);
    let m = x / decade;
    var step = select(select(select(10.0, 5.0, m <= 5.0001), 2.0, m <= 2.0001), 1.0, m <= 1.0001) * decade;
    if degrees && step > 10.0001 {
        step = select(90.0, 30.0, step <= 30.0001);
    }
    return min(step, highest) * pitch;
}

// Grid lines (or dots) in multiples of `pitch` from `lowest` to `highest`, at least the theme's
// grid spacing apart on each axis. The next coarser step draws whole, and the finer one fades out
// as its lines near that spacing.
fn grid(p: vec2f, w: vec2f, pitch: f32, lowest: f32, highest: f32, degrees: bool, dotted: bool) -> f32 {
    let least = frame.grid_spacing * eye.pixel_ratio;
    let fine = vec2f(
        nice(least * w.x, pitch, lowest, highest, degrees),
        nice(least * w.y, pitch, lowest, highest, degrees),
    );
    let coarse = vec2f(
        nice(fine.x * 1.5, pitch, lowest, highest, degrees),
        nice(fine.y * 1.5, pitch, lowest, highest, degrees),
    );
    let fade = smoothstep(vec2f(least), vec2f(2.0 * least), fine / max(w, vec2f(1e-30)));
    if dotted {
        // Dots sit where lines would cross, so both axes step alike.
        let finest = max(fine.x, fine.y);
        return max(dots(p, w, finest) * min(fade.x, fade.y), dots(p, w, max(coarse.x, coarse.y)));
    }
    let shown = max(lines(p, w, fine) * fade, lines(p, w, coarse));
    return max(shown.x, shown.y);
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
    let c = grid(p, w, frame.grid_pitch, 1.0, 1e30, false, frame.grid_kind == GRID_DOTS) * fade;
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

// The earth: the flat map's square or the globe's disc, blended as the projection morphs, lit by
// daylight, with the graticule on it and the atmosphere around the globe.
fn earth(o: vec3f, d: vec3f, g: vec3f, ahead: bool) -> Ground {
    // The flat map is one world. It ends where Web Mercator does, at y = ±π, and at the
    // antimeridian, x = ±π from the prime meridian. The distance to the antimeridian starts from
    // the center's longitude part by part, so the edge holds still at any zoom.
    let band = PI - abs(g.y + frame.mercator_y);
    let east = radians(180.0 - frame.center_hi.x - frame.center_lo.x) - g.x;
    let west = radians(180.0 + frame.center_hi.x + frame.center_lo.x) + g.x;
    let side = min(east, west);
    let across = saturate(side / max(fwidth(side), 1e-9) + 0.5);
    let flat = saturate(band / max(fwidth(band), 1e-9) + 0.5) * across * f32(ahead);
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
        color = blend(color, frame.grid_color, grid(p, w, 1.0, 0.01, 90.0, true, false) * fade * covered);
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
