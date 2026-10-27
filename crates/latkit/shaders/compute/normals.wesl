// Vertex normals for faces. Each face adds its unit normal, in fixed point, to the normal words of
// its three corner vertices, in pages of the vertex mark they belong to. Fixed point makes the sums
// exact in any order.

import package::lib::types::{NONE, item};
import package::lib::bind::{mark, pages};
import package::lib::triangles::triangle_corner;
import package::lib::state::end_normal;

@compute @workgroup_size(256)
fn accumulate(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.rows {
        return;
    }
    let a = triangle_corner(i, 0u);
    let b = triangle_corner(i, 1u);
    let c = triangle_corner(i, 2u);
    if !(a.shown && b.shown && c.shown) || a.vertex == NONE {
        return;
    }
    let n = cross(b.world - a.world, c.world - a.world);
    let length2 = dot(n, n);
    if !(length2 > 1e-30) {
        return;
    }
    let q = bitcast<vec3u>(vec3i(round(n * inverseSqrt(length2) * 65536.0)));
    let vertices = vec3u(a.vertex, b.vertex, c.vertex);
    for (var k = 0u; k < 3u; k++) {
        let at = end_normal(k, vertices[k]);
        if at == NONE {
            continue;
        }
        atomicAdd(&pages[at], q.x);
        atomicAdd(&pages[at + 1u], q.y);
        atomicAdd(&pages[at + 2u], q.z);
    }
}
