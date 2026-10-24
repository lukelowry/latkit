// Triangles: a face row's corners, at the vertices its references name; or an area's triangles, three
// points at a time from its geometry column after the point its label hangs from, numbered by the
// mark's list. Draws, probes, bounds, and labels read a triangle through `triangle_corner`; which kind
// a pipeline reads is its `PATH`: ends for faces, geometry for areas.

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
    // Where it stands, in position units.
    position: vec3f,
    // A face corner's vertex, a held row of the vertex mark its end attaches to; `NONE` for an area's.
    vertex: u32,
    color: vec4f,
    row: u32,
    // Whether it has a place to stand, and whether it lies in front of the globe's horizon.
    shown: bool,
    ahead: bool,
}

// Triangles every live row draws: a face per row, or each of every area's, as its list numbers them.
fn triangle_instances() -> u32 {
    if PATH == PATH_GEOMETRY {
        return stroke_instances();
    }
    return mark.rows;
}

// Corner `corner` of triangle `instance`, faded as its tile comes and goes.
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

// Whether triangle `instance` draws: every corner placed, and one in front of the globe's horizon;
// the globe's depth cuts a triangle reaching past its edge.
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

// Point `offset` of the points of triangle `t.index` of area row `t.row`: 0 is where its label hangs,
// 1 to 3 its corners.
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

// Where area row `row`'s label hangs: inside its largest polygon, farthest from its edges.
fn area_anchor(row: u32) -> Corner {
    return area_point(Segment(row, NONE, 0u, 0.0, 1.0, 1.0, false), 0u);
}

fn corner_clip(c: Corner) -> vec4f {
    return clip_of(c.world);
}
