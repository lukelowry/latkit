// Faces: one instanced triangle per row between the vertices its corners name, lit from the camera.
// Facing the camera, a face shows its color; turned away, it darkens by the theme's shading.

import package::lib::types::{NONE, VISIBLE, PINNED, PLACED, ENDS_COLOR};
import package::lib::bind::{frame, mark};
import package::lib::state::{row_at, face_at, vertex_slot};
import package::lib::project::{project, world, culled};
import package::lib::focus::faded;
import package::lib::marker::{MarkerColor, glow};
import package::lib::color::output;

// Each vertex's summed face normals, in fixed point.
@group(2) @binding(3) var<storage, read> normals: array<i32>;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) world: vec3f,
    @location(1) normal: vec3f,
    @location(2) color: vec4f,
    @location(3) @interpolate(flat) row: u32,
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) row: u32) -> Varyings {
    var out: Varyings;
    out.row = row;
    let f = face_at(row_at(row));
    if any(f.corners == vec3u(NONE)) || (f.flags & VISIBLE) == 0u {
        out.clip = culled();
        return out;
    }
    let slot = f.corners[corner];
    let v = vertex_slot(slot);
    if (v.flags & (PINNED | PLACED)) == 0u {
        out.clip = culled();
        return out;
    }
    out.clip = project(v.hi, v.lo, v.elevation);
    out.world = world(v.hi, v.lo, v.elevation);
    out.normal = vec3f(f32(normals[slot * 3u]), f32(normals[slot * 3u + 1u]), f32(normals[slot * 3u + 2u]));
    let color = select(unpack4x8unorm(f.color), unpack4x8unorm(v.color), (mark.flags & ENDS_COLOR) != 0u);
    out.color = vec4f(color.rgb, color.a * faded(row));
    return out;
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    let eye = normalize(frame.eye.xyz - v.world);
    let length2 = dot(v.normal, v.normal);
    var n = select(eye, v.normal * inverseSqrt(length2), length2 > 1e-12);
    n = select(n, -n, dot(n, eye) < 0.0);
    let facing = max(dot(n, eye), 0.0);
    let diffuse = 1.0 - frame.shading * (1.0 - facing);
    let shine = pow(max(dot(n, normalize(frame.light.xyz + eye)), 0.0), 48.0) * 0.3 * frame.shading;
    let rim = pow(1.0 - facing, 4.0) * 0.25 * frame.shading;
    let rgb = min(v.color.rgb * diffuse + shine + rim, vec3f(1.0));
    return output(glow(MarkerColor(vec4f(rgb, v.color.a), 0.0), v.row));
}
