// Triangles: one instanced triangle per face row, lit from the camera so a flat mesh seen from above
// shows its exact colors; turned away, a face darkens by the theme's shading. Faces receive the
// ground's shadow map. The cast variant draws them through the light's eye into the map.

import package::lib::bind::{frame, eye};
import package::lib::project::culled;
import package::lib::triangles::{triangle_corner, triangle_shown, corner_clip};
import package::lib::marker::{MarkerColor, glow};
import package::lib::focus::focus_of;
import package::lib::shade::{caster, lit};
import package::lib::color::output;

// Each vertex's summed face normals, in fixed point.
@group(2) @binding(3) var<storage, read> normals: array<i32>;
@if(!casts)
@group(2) @binding(10) var shadows: texture_2d<f32>;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) world: vec3f,
    @location(1) normal: vec3f,
    @location(2) color: vec4f,
    @location(3) @interpolate(flat) row: u32,
    // The row's focus bits: a lit face tints by them.
    @location(4) @interpolate(flat) focus: u32,
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    var out: Varyings;
    let c = triangle_corner(instance, corner);
    out.row = c.row;
    if !triangle_shown(instance) {
        out.clip = culled();
        return out;
    }
    out.clip = corner_clip(c);
    out.world = c.world;
    let s = c.slot * 3u;
    out.normal = vec3f(f32(normals[s]), f32(normals[s + 1u]), f32(normals[s + 2u]));
    out.color = c.color;
    out.focus = focus_of(c.row);
    return out;
}

@if(!casts)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let to_eye = normalize(eye.position.xyz - v.world);
    let length2 = dot(v.normal, v.normal);
    var n = select(to_eye, v.normal * inverseSqrt(length2), length2 > 1e-12);
    n = select(n, -n, dot(n, to_eye) < 0.0);
    let facing = max(dot(n, to_eye), 0.0);
    let diffuse = 1.0 - frame.shading * (1.0 - facing);
    let shine = pow(max(dot(n, normalize(frame.light.xyz + to_eye)), 0.0), 48.0) * 0.3 * frame.shading;
    let rim = pow(1.0 - facing, 4.0) * 0.25 * frame.shading;
    let rgb = min(v.color.rgb * diffuse + shine + rim, vec3f(1.0));
    let shadowed = mix(rgb, frame.shade.color.rgb, 1.0 - lit(shadows, v.world, false));
    return output(glow(MarkerColor(vec4f(shadowed, v.color.a), 0.0), v.focus));
}

@if(casts)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    return caster(v.color.a, v.world.z);
}
