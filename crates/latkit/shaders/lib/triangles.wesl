// Area triangles. The geometry column holds a label anchor, then three points per triangle,
// and the mark's list numbers them. Decode the row and its geometry once for all three corners.

import package::lib::types::{VISIBLE, MISSING, NONE};
import package::lib::bind::mark;
import package::lib::state::{row_at, area_at, Area};
import package::lib::project::{world, clip_of, shows};
import package::lib::focus::faded;
import package::lib::read::{Points, points_of, point_bits, point_address, point_at, missing_bits};
import package::lib::path::{Segment, segment, stroke_instances};
import package::lib::lists::{list_words, list_entry};
import package::lib::words::word_quad;
import package::lib::drawn::drawn_row;

struct Corner {
    world: vec3f,
    // Its position, in position units.
    position: vec3f,
    color: vec4f,
    row: u32,
    // Whether it has a position, and whether it lies in front of the globe's horizon.
    shown: bool,
    ahead: bool,
}

// Triangles across all drawn area rows, in list order.
fn triangle_instances() -> u32 { return stroke_instances(); }

struct AreaSource {
    row: u32,
    state: Area,
    points: Points,
}

fn area_source(row: u32) -> AreaSource {
    return AreaSource(row, area_at(row_at(row)), points_of(mark.geometry, row));
}

// An invalid point stays missing, including when its row is hidden. Bounds use these source
// coordinates directly, without projecting or decoding the row again for each corner.
fn area_bits(source: AreaSource, point: u32) -> vec2u {
    if (source.state.flags & VISIBLE) == 0u || point >= source.points.count { return vec2u(MISSING); }
    return point_bits(source.points, point);
}

// Corner `corner` of triangle `instance`, faded while its tile fades in or out.
fn triangle_corner(s: Segment, source: AreaSource, corner: u32) -> Corner {
    var c = area_point(source, 3u * s.index + 1u + corner);
    c.color.a *= s.presence;
    return c;
}

struct Triangle {
    source: AreaSource,
    corners: vec3u,
    presence: f32,
    valid: bool,
}

// Resolve addresses once. Ordinary triangles use the prepared list; focused triangles and
// triangles crossing a geometry piece use the same page tables as bounds and labels.
fn triangle_at(instance: u32) -> Triangle {
    @if(!focused) {
        let pair = word_quad(list_words, list_entry(mark.list, 2u * instance));
        let entry = select(pair.xy, pair.zw, (instance & 1u) != 0u);
        if entry.y != NONE {
            let drawn = drawn_row(entry.x);
            let source = AreaSource(drawn.row, area_at(row_at(drawn.row)), Points(0u, 0u, 0u));
            return Triangle(source, entry.y + vec3u(0u, 2u, 4u), drawn.presence, true);
        }
    }
    let s = segment(instance);
    let source = area_source(s.row);
    let point = 3u * s.index + 1u;
    if point + 2u >= source.points.count { return Triangle(source, vec3u(0u), s.presence, false); }
    let corners = vec3u(point_address(source.points, point), point_address(source.points, point + 1u), point_address(source.points, point + 2u));
    return Triangle(source, corners, s.presence, true);
}

// Triangulation supplies finite corners. A draw fetches only its own point unless it lies behind
// the globe's horizon, where the other corners decide whether the triangle still reaches ahead.
fn triangle_vertex(instance: u32, corner: u32) -> Corner {
    let t = triangle_at(instance);
    var c: Corner;
    c.row = t.source.row;
    if !t.valid || (t.source.state.flags & VISIBLE) == 0u { return c; }
    c = area_position(t.source, bitcast<vec2f>(point_at(t.corners[corner])));
    c.color.a *= t.presence;
    if !c.ahead {
        let a = bitcast<vec2f>(point_at(t.corners[(corner + 1u) % 3u]));
        let b = bitcast<vec2f>(point_at(t.corners[(corner + 2u) % 3u]));
        c.shown = shows(world(a, vec2f(0.0), 0.0)) || shows(world(b, vec2f(0.0), 0.0));
    }
    return c;
}

// Point zero is the area's label anchor; the remaining points are its triangles' corners.
fn area_point(source: AreaSource, point: u32) -> Corner {
    var c: Corner;
    c.row = source.row;
    let w = area_bits(source, point);
    if missing_bits(w.x) || missing_bits(w.y) {
        c.shown = false;
        return c;
    }
    return area_position(source, bitcast<vec2f>(w));
}

fn area_position(source: AreaSource, xy: vec2f) -> Corner {
    var c: Corner;
    c.row = source.row;
    c.position = vec3f(xy, 0.0);
    c.world = world(xy, vec2f(0.0), 0.0);
    let color = unpack4x8unorm(source.state.color);
    c.color = vec4f(color.rgb, color.a * faded(source.row, source.state.flags));
    c.shown = true;
    c.ahead = shows(c.world);
    return c;
}

// Area row `row`'s label anchor: inside its largest polygon, at the point farthest from its edges.
fn area_anchor(row: u32) -> Corner {
    return area_point(area_source(row), 0u);
}

fn corner_clip(c: Corner) -> vec4f {
    return clip_of(c.world);
}
