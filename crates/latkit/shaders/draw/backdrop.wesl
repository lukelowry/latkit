// The backdrop under every mark: a plane's or a diagram's grid, or the earth's surface and graticule,
// darkened where casters shadow the ground, lit by daylight, and on the globe ringed by its air. Lines
// are a pixel wide and antialiased per axis. Their spacing steps by tens, and the next step fades in as
// the lines crowd, so no seam shows. They fade where the view grazes the ground, and on a plane away
// from what the camera looks at. The round globe writes its depth a hair under its surface, so what
// lies behind it hides and what lies on it draws.

import package::lib::types::{SPACE_EARTH, SPACE_PLANE, SPACE_DIAGRAM, GRID_OFF, GRID_DOTS};
import package::lib::bind::{frame, eye};
import package::lib::color::output;
import package::lib::project::{PI, NEAR_Z, FAR_Z, globe_center};
import package::lib::shade::{lit, daylight};

@group(2) @binding(10) var shadows: texture_2d<f32>;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) ndc: vec2f,
}

// How far under its surface the globe's depth lies, in its radii: deeper than a chord of a few
// degrees sags, so paths and areas on the ground draw over it.
const SURFACE_BIAS: f32 = 1e-3;

// What a pixel of the backdrop draws: its color, and the depth of the ground there.
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
fn earth(o: vec3f, d: vec3f, g: vec3f, ahead: bool) -> Ground {
    // The flat map ends where web mercator does, at y = ±π.
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
    var ground = frame.surface;
    if globe {
        p = globe_degrees(hit, radius);
        ground = vec4f(ground.rgb * daylight(p), ground.a);
    } else {
        p = map_degrees(g);
        ground = shaded(vec4f(ground.rgb * daylight(p), ground.a), g, ahead);
    }
    var color = blend(frame.background, ground, covered);
    let facing = dot(normalize(hit - center), -d);
    if frame.graticule != 0u {
        // Longitude jumps where it wraps; its other wrapping steadies the derivative there.
        let wrapped = fract(p.x / 360.0) * 360.0;
        let w = vec2f(min(fwidth(p.x), fwidth(wrapped)), fwidth(p.y));
        let fade = select(smoothstep(0.02, 0.15, abs(d.z)), smoothstep(0.0, 0.3, facing), globe);
        color = blend(color, frame.grid_color, grid(p, w, 1.0, -2.0, 1.0, false) * fade * covered);
    }
    if frame.atmosphere.a > 0.0 && frame.globe > 0.0 {
        // A thin rim of air over the globe's edge and a halo just past it, as thick as the air is
        // beside the earth, lit where the sun is up over the ground the ray passes nearest.
        let rim = pow(1.0 - saturate(facing), 6.0) * round;
        let halo = pow(1.0 - smoothstep(radius, radius * 1.045, off), 2.0) * (1.0 - round) * f32(along > 0.0);
        let below = daylight(globe_degrees(o + d * along, radius));
        let air = (rim + halo) * frame.atmosphere.a * frame.globe * mix(0.2, 1.0, below);
        color = vec4f(mix(color.rgb, frame.atmosphere.rgb, saturate(air)), color.a);
    }
    var depth = FAR_Z;
    if frame.globe >= 1.0 && round > 0.5 {
        let under = eye.clip_from_world * vec4f(hit - normalize(hit - center) * radius * SURFACE_BIAS, 1.0);
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
