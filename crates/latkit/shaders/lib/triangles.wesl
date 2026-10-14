// Triangles: the corners of a face row, between the vertices its references name. Draws, casts,
// and probes read a triangle through `triangle_corner`.

import package::lib::types::{NONE, VISIBLE, PLACED, ENDS_COLOR};
import package::lib::bind::{mark};
import package::lib::state::{row_at, face_at, vertex_slot};
import package::lib::project::{world, clip_of};
import package::lib::focus::faded;

struct Corner {
    world: vec3f,
    slot: u32,
    color: vec4f,
    shown: bool,
}

// Corner `corner` of face row `row`.
fn triangle_corner(row: u32, corner: u32) -> Corner {
    var c: Corner;
    let f = face_at(row_at(row));
    if any(f.corners == vec3u(NONE)) || (f.flags & VISIBLE) == 0u {
        c.shown = false;
        return c;
    }
    c.slot = f.corners[corner];
    let v = vertex_slot(c.slot);
    c.world = world(v.hi, v.lo, v.elevation);
    let color = select(unpack4x8unorm(f.color), unpack4x8unorm(v.color), (mark.flags & ENDS_COLOR) != 0u);
    c.color = vec4f(color.rgb, color.a * faded(row, f.flags));
    c.shown = (v.flags & PLACED) != 0u;
    return c;
}

fn corner_clip(c: Corner) -> vec4f {
    return clip_of(c.world);
}
