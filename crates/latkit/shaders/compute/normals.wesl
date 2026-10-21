// Vertex normals for faces: each face adds its unit normal to its three corners in fixed point, so the
// sums are exact in any order.

import package::lib::types::{NONE, item};
import package::lib::bind::mark;
import package::lib::triangles::triangle_corner;

@group(2) @binding(3) var<storage, read_write> normals: array<atomic<i32>>;

@compute @workgroup_size(256)
fn accumulate(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.rows {
        return;
    }
    let a = triangle_corner(i, 0u);
    let b = triangle_corner(i, 1u);
    let c = triangle_corner(i, 2u);
    if !(a.shown && b.shown && c.shown) || a.slot == NONE {
        return;
    }
    let n = cross(b.world - a.world, c.world - a.world);
    let length2 = dot(n, n);
    if !(length2 > 1e-30) {
        return;
    }
    let q = vec3i(round(n * inverseSqrt(length2) * 65536.0));
    for (var k = 0u; k < 3u; k++) {
        let at = select(select(c.slot, b.slot, k == 1u), a.slot, k == 0u) * 3u;
        atomicAdd(&normals[at], q.x);
        atomicAdd(&normals[at + 1u], q.y);
        atomicAdd(&normals[at + 2u], q.z);
    }
}
