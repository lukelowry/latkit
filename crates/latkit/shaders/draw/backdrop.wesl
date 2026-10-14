// The backdrop under every mark: a plane's or a diagram's grid, or the earth's surface and graticule,
// darkened where casters shadow the ground, lit by daylight, and on the globe ringed by its air. Lines
// are a pixel wide and antialiased per axis. Their spacing steps by tens, and the next step fades in as
// the lines crowd, so no seam shows. They fade where the view grazes the ground, and on a plane away
// from what the camera looks at.

import package::lib::types::{SPACE_EARTH, SPACE_PLANE, SPACE_DIAGRAM, GRID_OFF, GRID_DOTS};
import package::lib::bind::{frame, eye};
import package::lib::color::output;
import package::lib::project::{PI, NEAR_Z, FAR_Z};
import package::lib::shade::{lit, daylight};

@group(2) @binding(10) var shadows: texture_2d<f32>;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) ndc: vec2f,
}

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> Varyings {
    let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    let ndc = uv * 2.0 - 1.0;
    return Varyings(vec4f(ndc, 0.0, 1.0), ndc);
}

// Coverage of lines `pitch` apart through `p`, which moves `w` per pixel: a pixel wide, fading out as
// their cells shrink to a few pixels.
fn lines(p: vec2f, w: vec2f, pitch: f32) -> f32 {
    let cells = max(w / pitch, vec2f(1e-12));
    let px = abs(fract(p / pitch + 0.5) - 0.5) / cells;
    let c = saturate(1.0 - px) * (1.0 - smoothstep(vec2f(0.08), vec2f(0.25), cells));
    return max(c.x, c.y);
}

fn dots(p: vec2f, w: vec2f, pitch: f32) -> f32 {
    let cells = max(w / pitch, vec2f(1e-12));
    let px = abs(fract(p / pitch + 0.5) - 0.5) / cells;
    return saturate(1.5 - length(px)) * (1.0 - smoothstep(0.08, 0.25, max(cells.x, cells.y)));
}

// Lines spaced `pitch` times a power of ten, from the `lowest` power to the `highest`: the spacing
// nearest twenty pixels draws, and the next coarser one fades in as it crowds.
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

// `color` darkened where casters shadow ground point `g`.
fn shaded(color: vec4f, g: vec3f, ahead: bool) -> vec4f {
    let shadow = select(0.0, 1.0 - lit(shadows, g, true), ahead);
    return vec4f(mix(color.rgb, frame.shade.color.rgb, shadow), color.a);
}

// The plane: its grid where the ray meets elevation 0 at `g`, faded where the ray grazes and away
// from the center.
fn plane(g: vec3f, d: vec3f, ahead: bool) -> vec4f {
    let p = g.xy + frame.center_hi + frame.center_lo;
    let w = fwidth(g.xy);
    let ground = shaded(frame.background, g, ahead);
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

// The earth: the mercator band or the globe's disc, eased between as the projection morphs, lit by
// daylight, the graticule on it, and around the globe its air.
fn earth(o: vec3f, d: vec3f, g: vec3f, ahead: bool) -> vec4f {
    // The flat map ends where web mercator does, at y = ±π.
    let band = PI - abs(g.y + frame.mercator_y);
    let flat = saturate(band / max(fwidth(band), 1e-9) + 0.5) * f32(ahead);
    // The globe is a sphere of radius 1 / cos(lat0) whose top touches the ground at the center.
    let radius = 1.0 / cos(radians(frame.center_hi.y + frame.center_lo.y));
    let center = vec3f(0.0, 0.0, -radius);
    let to_center = center - o;
    let along = dot(to_center, d);
    let off = length(to_center - d * along);
    let miss = off - radius;
    let round = saturate(-miss / max(fwidth(miss), 1e-9) + 0.5) * f32(along > 0.0);
    let covered = mix(flat, round, frame.globe);
    let hit = o + d * (along - sqrt(max(radius * radius - off * off, 0.0)));
    let globe = frame.globe >= 0.5;
    let p = select(map_degrees(g), globe_degrees(hit, radius), globe);
    let ground = vec4f(frame.surface.rgb * daylight(p), frame.surface.a);
    var color = blend(frame.background, select(shaded(ground, g, ahead), ground, globe), covered);
    let facing = dot(normalize(hit - center), -d);
    if frame.graticule != 0u {
        // Longitude jumps where it wraps; its other wrapping steadies the derivative there.
        let wrapped = fract(p.x / 360.0) * 360.0;
        let w = vec2f(min(fwidth(p.x), fwidth(wrapped)), fwidth(p.y));
        let fade = select(smoothstep(0.02, 0.15, abs(d.z)), smoothstep(0.0, 0.3, facing), globe);
        color = blend(color, frame.grid_color, grid(p, w, 1.0, -2.0, 1.0, false) * fade * covered);
    }
    if frame.atmosphere.a > 0.0 && frame.globe > 0.0 {
        // A rim of air over the globe's edge and a halo past it, lit where the sun is up over the
        // ground the ray passes nearest.
        let rim = pow(1.0 - saturate(facing), 3.0) * round;
        let halo = pow(1.0 - smoothstep(radius, radius * 1.12, off), 2.0) * (1.0 - round) * f32(along > 0.0);
        let below = daylight(globe_degrees(o + d * along, radius));
        let air = (rim + halo) * frame.atmosphere.a * frame.globe * mix(0.2, 1.0, below);
        color = vec4f(mix(color.rgb, frame.atmosphere.rgb, saturate(air)), color.a);
    }
    return color;
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let near = eye.world_from_clip * vec4f(v.ndc, NEAR_Z, 1.0);
    let far = eye.world_from_clip * vec4f(v.ndc, FAR_Z, 1.0);
    let o = near.xyz / near.w;
    let d = normalize(far.xyz / far.w - o);
    // Where the ray meets elevation 0.
    let t = -o.z / d.z;
    let g = o + d * max(t, 0.0);
    var color = frame.background;
    if frame.space == SPACE_PLANE || frame.space == SPACE_DIAGRAM {
        color = plane(g, d, t > 0.0);
    } else if frame.space == SPACE_EARTH {
        color = earth(o, d, g, t > 0.0);
    }
    return output(vec4f(color.rgb * color.a, color.a));
}
