// The backdrop under every mark: a plane's grid, or the earth's surface.

import package::lib::types::{SPACE_EARTH, SPACE_PLANE, GRID_LINES, GRID_DOTS};
import package::lib::bind::frame;
import package::lib::color::output;
import package::lib::project::PI;

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

// Where the pixel's ray meets the ground (z = 0), relative to the center; w is 0 past the horizon.
fn ground(ndc: vec2f) -> vec4f {
    let near = frame.world_from_clip * vec4f(ndc, 0.0, 1.0);
    let far = frame.world_from_clip * vec4f(ndc, 1.0, 1.0);
    let a = near.xyz / near.w;
    let b = far.xyz / far.w;
    let t = a.z / (a.z - b.z);
    return vec4f(mix(a, b, t), f32(t >= 0.0));
}

// Coverage of grid lines or dots `pitch` apart, fading where they would crowd; `footprint` is one
// pixel's extent in position units.
fn grid(p: vec2f, pitch: f32, footprint: f32) -> f32 {
    var spacing = pitch;
    while spacing < footprint * 8.0 && spacing < 1e30 {
        spacing *= 10.0;
    }
    let center = frame.center_hi + frame.center_lo;
    let q = (p + center) / spacing;
    let d = abs(fract(q - 0.5) - 0.5) * spacing / footprint;
    if frame.grid_kind == GRID_DOTS {
        return clamp(1.5 - length(d), 0.0, 1.0);
    }
    return clamp(1.0 - min(d.x, d.y), 0.0, 1.0);
}

// How much of the pixel the earth covers: the mercator band between its latitude limits, or the
// globe's disc, eased between the two as the projection morphs.
fn earth(ndc: vec2f, g: vec4f) -> f32 {
    let lat0 = radians(frame.center_hi.y + frame.center_lo.y);
    // The flat map ends where web mercator does, at y = ±π.
    let band = PI - abs(g.y + frame.mercator_y);
    let flat = clamp(band / max(fwidth(band), 1e-9) + 0.5, 0.0, 1.0) * g.w;
    // The globe is a sphere of radius 1 / cos(lat0) whose top touches the ground at the center.
    let near = frame.world_from_clip * vec4f(ndc, 0.0, 1.0);
    let far = frame.world_from_clip * vec4f(ndc, 1.0, 1.0);
    let o = near.xyz / near.w;
    let d = normalize(far.xyz / far.w - o);
    let radius = 1.0 / cos(lat0);
    let to_center = vec3f(0.0, 0.0, -radius) - o;
    let along = dot(to_center, d);
    let miss = length(to_center - d * along) - radius;
    let round = clamp(-miss / max(fwidth(miss), 1e-9) + 0.5, 0.0, 1.0) * f32(along > 0.0);
    return mix(flat, round, frame.globe);
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let g = ground(v.ndc);
    let footprint = max(max(fwidth(g.x), fwidth(g.y)), 1e-30);
    let covered = earth(v.ndc, g);
    var color = frame.background;
    if frame.space == SPACE_EARTH {
        color = mix(frame.background, frame.surface, covered);
    } else if frame.space == SPACE_PLANE && frame.grid_kind != 0u && g.w > 0.0 {
        let c = grid(g.xy, frame.grid_pitch, footprint) * frame.grid_color.a;
        color = vec4f(mix(color.rgb, frame.grid_color.rgb, c), color.a);
    }
    return output(vec4f(color.rgb * color.a, color.a));
}
