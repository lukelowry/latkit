// Triangles: one instanced triangle per face row, lit from the camera so a flat mesh seen from
// above shows its exact colors. A face turned away darkens by the theme's shading.

import package::lib::bind::{frame, eye, word};
import package::lib::project::culled;
import package::lib::triangles::{triangle_corner, triangle_shown, corner_clip};
import package::lib::state::end_normal;
import package::lib::marker::{MarkerColor, glow};
import package::lib::focus::focus_of;
import package::lib::color::output;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) world: vec3f,
    @location(1) normal: vec3f,
    @location(2) color: vec4f,
    @location(3) @interpolate(flat) row: u32,
    // The row's focus bits, which tint a lit face.
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
    // The face normals summed at this corner's vertex, in fixed point.
    let n = end_normal(corner, c.vertex);
    if n != NONE {
        out.normal = vec3f(f32(bitcast<i32>(word(n))), f32(bitcast<i32>(word(n + 1u))), f32(bitcast<i32>(word(n + 2u))));
    }
    out.color = c.color;
    out.focus = focus_of(c.row);
    return out;
}

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
    return output(glow(MarkerColor(vec4f(rgb, v.color.a), 0.0), v.focus));
}
