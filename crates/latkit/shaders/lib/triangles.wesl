// Triangles: a face row's corners at the vertices its references name, or an area's triangles. An
// area's geometry column holds its label anchor, then three points per triangle, and the mark's
// list numbers the triangles. Draws, probes, bounds, and labels read triangles through
// `triangle_corner`. A pipeline's `PATH` selects the kind: `PATH_ENDS` for faces, `PATH_GEOMETRY`
// for areas.

import package::lib::types::{NONE, VISIBLE, PLACED, ENDS_COLOR, PATH_GEOMETRY};
import package::lib::bind::mark;
import package::lib::state::{row_at, face_at, area_at, end_vertex};
import package::lib::project::{world, clip_of, shows};
import package::lib::focus::faded;
import package::lib::read::{points_of, point_bits, missing_bits};
import package::lib::path::{PATH, Segment, segment, stroke_instances};
import package::lib::drawn::drawn_row;

struct Corner {
    world: vec3f,
    // Its position, in position units.
    position: vec3f,
    // A face corner's vertex: a held row of the vertex mark its end attaches to. NONE for an area.
    vertex: u32,
    color: vec4f,
    row: u32,
    // Whether it has a position, and whether it lies in front of the globe's horizon.
    shown: bool,
    ahead: bool,
}

// Triangles across all drawn rows: one per face, or every area triangle the list numbers.
fn triangle_instances() -> u32 {
    if PATH == PATH_GEOMETRY {
        return stroke_instances();
    }
    return mark.rows;
}

// Corner `corner` of triangle `instance`, faded while its tile fades in or out.
fn triangle_corner(instance: u32, corner: u32) -> Corner {
    if PATH == PATH_GEOMETRY {
        let s = segment(instance);
        var c = area_point(s, 1u + corner);
        c.color.a *= s.presence;
        return c;
    }
    let d = drawn_row(instance);
    var c = face_corner(d.row, corner);
    c.color.a *= d.presence;
    return c;
}

// Whether triangle `instance` draws: every corner has a position, and at least one lies in front of
// the globe's horizon. The globe's depth clips a triangle reaching past its edge.
fn triangle_shown(instance: u32) -> bool {
    var ahead = false;
    for (var k = 0u; k < 3u; k++) {
        let c = triangle_corner(instance, k);
        if !c.shown {
            return false;
        }
        ahead = ahead || c.ahead;
    }
    return ahead;
}

// The drawn row triangle `instance` belongs to.
fn triangle_item(instance: u32) -> u32 {
    if PATH == PATH_GEOMETRY {
        return segment(instance).item;
    }
    return instance;
}

fn face_corner(row: u32, corner: u32) -> Corner {
    var c: Corner;
    c.row = row;
    let f = face_at(row_at(row));
    if any(f.corners == vec3u(NONE)) || (f.flags & VISIBLE) == 0u {
        c.shown = false;
        return c;
    }
    c.vertex = f.corners[corner];
    let v = end_vertex(corner, c.vertex);
    c.world = world(v.hi, v.lo, v.elevation);
    c.position = vec3f(v.hi + v.lo, v.elevation);
    let color = select(unpack4x8unorm(f.color), unpack4x8unorm(v.color), (mark.flags & ENDS_COLOR) != 0u);
    c.color = vec4f(color.rgb, color.a * faded(row, f.flags));
    c.shown = (v.flags & PLACED) != 0u;
    c.ahead = shows(c.world);
    return c;
}

// Point `offset` of triangle `t.index` of area row `t.row`. Offset 0 is the area's label anchor;
// 1 to 3 are the triangle's corners.
fn area_point(t: Segment, offset: u32) -> Corner {
    var c: Corner;
    c.row = t.row;
    c.vertex = NONE;
    let a = area_at(row_at(t.row));
    let points = points_of(mark.geometry, t.row);
    let k = select(3u * t.index + offset, 0u, offset == 0u);
    if (a.flags & VISIBLE) == 0u || k >= points.count {
        c.shown = false;
        return c;
    }
    let w = point_bits(points, k);
    if missing_bits(w.x) || missing_bits(w.y) {
        c.shown = false;
        return c;
    }
    let xy = vec2f(bitcast<f32>(w.x), bitcast<f32>(w.y));
    c.position = vec3f(xy, 0.0);
    c.world = world(xy, vec2f(0.0), 0.0);
    let color = unpack4x8unorm(a.color);
    c.color = vec4f(color.rgb, color.a * faded(t.row, a.flags));
    c.shown = true;
    c.ahead = shows(c.world);
    return c;
}

// Area row `row`'s label anchor: inside its largest polygon, at the point farthest from its edges.
fn area_anchor(row: u32) -> Corner {
    return area_point(Segment(row, NONE, 0u, 0.0, 1.0, 1.0, false), 0u);
}

fn corner_clip(c: Corner) -> vec4f {
    return clip_of(c.world);
}
