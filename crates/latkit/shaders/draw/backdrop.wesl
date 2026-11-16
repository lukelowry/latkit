import package::lib::project::{geographic, globe_amount};
// The backdrop under every mark: a plane's grid, or the earth's ground and grid, lit by daylight,
// with the atmosphere around the globe.
//
// A grid's lines lie at multiples of two steps, a finer and a coarser, which the frame picks from
// the camera's zoom alone. Turning or tilting the view so moves no line and fades none. The coarser
// step always draws, and the finer one fades in as zooming in spreads its lines apart. Lines have a
// set width in pixels, antialiased by how much of the coordinate a pixel spans. Where they crowd
// closer than a pixel or two, toward a horizon or the globe's edge, they draw as the share of a
// pixel they cover. A grid so settles into an even tint there, and neither flickers nor fades away.
//
// The round globe writes the depth of the plane through its visible edge, which hides what lies
// behind the globe and nothing on it.

import package::lib::types::{SPACE_EARTH, SPACE_PLANE, GRID_OFF, GRID_DOTS};
import package::lib::bind::{frame, eye};
import package::lib::color::output;
import package::lib::project::{PI, NEAR_Z, FAR_Z, globe_center};
import package::lib::daylight::daylight;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) ndc: vec2f,
}

// A backdrop pixel: its color, and the ground's depth there.
struct Ground {
    color: vec4f,
    depth: f32,
}

// Where a pixel lies on a grid: each coordinate measured from the camera's center, and how much of
// each a pixel spans.
struct Gridded {
    at: vec2f,
    per_px: vec2f,
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

// The pixels between lines a step apart, where a pixel spans `per_px` steps.
fn cells(per_px: vec2f) -> vec2f {
    return 1.0 / clamp(per_px, vec2f(1e-30), vec2f(1e30));
}

// How far `u`, a coordinate counted in steps, lies from the nearest line, in pixels.
fn away(u: vec2f, cell: vec2f) -> vec2f {
    return abs(fract(u + 0.5) - 0.5) * cell;
}

// Coverage of lines a step apart on each axis, `width` pixels wide, at `u` steps along each
// coordinate, where a pixel spans `per_px` steps. Lines under three pixels apart blend toward the
// share of a pixel they cover.
fn lines(u: vec2f, per_px: vec2f, width: f32) -> vec2f {
    let cell = cells(per_px);
    let drawn = saturate(0.5 * (width + 1.0) - away(u, cell));
    return mix(saturate(width / cell), drawn, smoothstep(vec2f(1.0), vec2f(3.0), cell));
}

// Coverage of dots where lines a step apart would cross, each twice `width` pixels across.
fn dots(u: vec2f, per_px: vec2f, width: f32) -> f32 {
    let cell = cells(per_px);
    let drawn = saturate(width + 0.5 - length(away(u, cell)));
    let share = saturate(PI * width * width / (cell.x * cell.y));
    return mix(share, drawn, smoothstep(1.0, 3.0, min(cell.x, cell.y)));
}

// Coverage of the grid at `g`: lines (or dots) at the frame's finer step, faded in as far as the
// frame says, over those at its coarser step.
fn grid(g: Gridded) -> f32 {
    let width = frame.grid_width * eye.pixel_ratio;
    let fine = g.at / frame.grid_step.x + frame.grid_phase.xy;
    let coarse = g.at / frame.grid_step.y + frame.grid_phase.zw;
    let fine_px = g.per_px / frame.grid_step.x;
    let coarse_px = g.per_px / frame.grid_step.y;
    if frame.grid_kind == GRID_DOTS {
        return max(dots(fine, fine_px, width) * frame.grid_fade, dots(coarse, coarse_px, width));
    }
    let shown = max(lines(fine, fine_px, width) * frame.grid_fade, lines(coarse, coarse_px, width));
    return max(shown.x, shown.y);
}

// How much of `p` a pixel spans, the same whichever way the view is turned.
fn span(p: f32) -> f32 {
    return length(vec2f(dpdx(p), dpdy(p)));
}

fn blend(color: vec4f, over: vec4f, coverage: f32) -> vec4f {
    return vec4f(mix(color.rgb, over.rgb, coverage * over.a), color.a);
}

// The plane's grid at `g`, where the view ray meets elevation 0.
fn plane(g: vec3f, ahead: bool) -> vec4f {
    let ground = frame.background;
    if frame.grid_kind == GRID_OFF {
        return ground;
    }
    let at = Gridded(g.xy, vec2f(span(g.x), span(g.y)));
    return blend(ground, frame.grid_color, grid(at) * f32(ahead));
}

// Longitude and latitude in degrees at world point `w` on the flat map.
fn map_degrees(w: vec3f) -> vec2f {
    let lat = degrees(2.0 * atan(exp(w.y + frame.mercator_y)) - 0.5 * PI);
    return vec2f(frame.center_hi.x + frame.center_lo.x + degrees(w.x), lat);
}

// Longitude and latitude in degrees at world point `w` on the globe of `radius`.
fn globe_degrees(w: vec3f, radius: f32) -> vec2f {
    let u = normalize(vec3f(w.xy, w.z + radius));
    let v = vec3f(u.x, u.y * frame.latitude_cos + u.z * frame.latitude_sin,
        -u.y * frame.latitude_sin + u.z * frame.latitude_cos);
    let lon = frame.center_hi.x + frame.center_lo.x + degrees(atan2(v.x, v.z));
    return vec2f(lon, degrees(asin(clamp(v.y, -1.0, 1.0))));
}

// Where world point `w` on the flat map lies on the earth's grid, in degrees. The latitude is
// measured from the center's by how far north `w` lies of it, so it keeps its precision at any
// zoom, where the latitude itself would round to a few pixels.
fn map_gridded(w: vec3f) -> Gridded {
    // exp(y) - 1, summed as a series near 0, where the subtraction would lose it.
    let grown = select(exp(w.y) - 1.0, w.y * (1.0 + w.y * (0.5 + w.y / 6.0)), abs(w.y) < 0.01);
    let k = exp(frame.mercator_y);
    let here = k * (grown + 1.0);
    let lat = 2.0 * atan(k * grown / (1.0 + k * here));
    // A step north on the map covers less latitude toward the poles.
    let narrowing = 2.0 * here / (1.0 + here * here);
    return Gridded(degrees(vec2f(w.x, lat)), degrees(vec2f(span(w.x), narrowing * span(w.y))));
}

// Where world point `w` on the globe of `radius` lies on the earth's grid, in degrees. Both are
// measured from the center's, from how far `w` lies from the point the camera looks at, so they
// keep their precision at any zoom. What a pixel spans comes from the direction from the globe's
// center, which changes evenly where longitude wraps and at the poles.
fn globe_gridded(w: vec3f, radius: f32) -> Gridded {
    let u = w / radius;
    let s = frame.latitude_sin;
    let c = frame.latitude_cos;
    // The direction from the globe's center in the earth's axes, less the center's own height.
    let v = vec3f(u.x, u.y * c + u.z * s, (1.0 + u.z) * c - u.y * s);
    let lon = atan2(v.x, v.z);
    // The latitude whose sine is the center's plus `v.y`.
    let lat = 2.0 * atan(v.y / (c + sqrt(max(c * c - v.y * (2.0 * s + v.y), 0.0))));
    let dx = dpdx(v);
    let dy = dpdy(v);
    let level = max(v.x * v.x + v.z * v.z, 1e-12);
    let lon_px = length(vec2f(v.z * dx.x - v.x * dx.z, v.z * dy.x - v.x * dy.z)) / level;
    let lat_px = length(vec2f(dx.y, dy.y)) / sqrt(level);
    return Gridded(degrees(vec2f(lon, lat)), degrees(vec2f(lon_px, lat_px)));
}

// The depth the globe of `radius` hides by along the view ray `o + d t`: that of the plane through
// its visible edge. Everything at or above the ground on the side facing the eye lies in front of
// that plane, and everything on the far side behind it. The test is so exact, and nothing drawn on
// the ground has to clear a bias: a flat triangle between visible corners never crosses the plane.
// The globe's center lies `radius` below the origin, so the plane is where
// dot(x, eye) + radius * (x.z + eye.z) is zero. Written from the origin, its small terms keep
// their precision at any zoom.
fn horizon_depth(o: vec3f, d: vec3f, radius: f32) -> f32 {
    let e = eye.position.xyz;
    let t = -(dot(o, e) + radius * (o.z + e.z)) / (dot(d, e) + radius * d.z);
    let at = eye.clip_from_world * vec4f(o + d * t, 1.0);
    return clamp(at.z / at.w, FAR_Z, NEAR_Z);
}

// The earth: the flat map's square or the globe's disc, blended as the projection morphs, lit by
// daylight, with the grid on it and the atmosphere around the globe.
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
    let covered = mix(flat, round, globe_amount());
    let hit = o + d * (along - sqrt(max(radius * radius - off * off, 0.0)));
    let globe = globe_amount() >= 0.5;
    var p: vec2f;
    var ground = frame.ground;
    if globe {
        p = globe_degrees(hit, radius);
    } else {
        p = map_degrees(g);
    }
    ground = vec4f(ground.rgb * daylight(p), ground.a);
    var color = blend(frame.background, ground, covered);
    if frame.grid_kind != GRID_OFF {
        var at: Gridded;
        if globe {
            at = globe_gridded(hit, radius);
        } else {
            at = map_gridded(g);
        }
        color = blend(color, frame.grid_color, grid(at) * covered);
    }
    if frame.atmosphere.a > 0.0 && globe_amount() > 0.0 {
        // A thin rim of atmosphere over the globe's edge, and a halo out to 1.045 globe radii. It
        // is lit where the sun is up over the ground nearest the view ray.
        let facing = dot(normalize(hit - center), -d);
        let rim = pow(1.0 - saturate(facing), 6.0) * round;
        let halo = pow(1.0 - smoothstep(radius, radius * 1.045, off), 2.0) * (1.0 - round) * f32(along > 0.0);
        let below = daylight(globe_degrees(o + d * along, radius));
        let air = (rim + halo) * frame.atmosphere.a * globe_amount() * mix(0.2, 1.0, below);
        color = vec4f(mix(color.rgb, frame.atmosphere.rgb, saturate(air)), color.a);
    }
    var depth = FAR_Z;
    if globe_amount() >= 1.0 && round > 0.5 {
        depth = horizon_depth(o, d, radius);
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
    if frame.space == SPACE_PLANE {
        color = plane(g, t > 0.0);
    } else if geographic() {
        let ground = earth(o, d, g, t > 0.0);
        color = ground.color;
        depth = ground.depth;
    }
    return Out(output(vec4f(color.rgb * color.a, color.a)), depth);
}
