// Vertex normals for faces: each face adds its unit normal to its three corners in fixed point, so the
// sums are exact in any order.

import package::lib::types::{NONE, PINNED, PLACED};
import package::lib::bind::mark;
import package::lib::state::{row_at, face_at, vertex_slot};
import package::lib::project::world;

@group(2) @binding(3) var<storage, read_write> normals: array<atomic<i32>>;

@compute @workgroup_size(256)
fn accumulate(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= mark.rows {
        return;
    }
    let f = face_at(row_at(id.x));
    if any(f.corners == vec3u(NONE)) {
        return;
    }
    let a = vertex_slot(f.corners.x);
    let b = vertex_slot(f.corners.y);
    let c = vertex_slot(f.corners.z);
    if ((a.flags & b.flags & c.flags) & (PINNED | PLACED)) == 0u {
        return;
    }
    let pa = world(a.hi, a.lo, a.elevation);
    let n = cross(world(b.hi, b.lo, b.elevation) - pa, world(c.hi, c.lo, c.elevation) - pa);
    let length2 = dot(n, n);
    if !(length2 > 1e-30) {
        return;
    }
    let q = vec3i(round(n * inverseSqrt(length2) * 65536.0));
    for (var k = 0u; k < 3u; k++) {
        let at = f.corners[k] * 3u;
        atomicAdd(&normals[at], q.x);
        atomicAdd(&normals[at + 1u], q.y);
        atomicAdd(&normals[at + 2u], q.z);
    }
}
