// Paths: the segments a stroke draws, whatever mark it belongs to. A row's path runs between an
// edge's ends (straight, through the bends of a geometry column, or along the great circle on the
// earth), through a line's samples across the axis, or through a geometry column's points: a route
// a diagram's sheet worked out, or a path field. Draws, casts, probes, bounds, and labels all read a
// segment through `segment_ends` and `segment_screen`. Which path a pipeline reads is its `PATH`, so
// each compiles one kind of path.

import package::lib::types::{
    NONE, VISIBLE, PLACED, DASH, ENDS_COLOR, GEODESIC, STEP_BEFORE, STEP_AFTER, MARK_EDGES, PATH_ENDS, PATH_TRACE,
    PATH_GEOMETRY, EDGE_WIDTH, LINE_WIDTH, GEODESIC_STEP, OWN_HEIGHT, TRIANGLES,
};
import package::lib::bind::{frame, mark};
import package::lib::state::{row_at, edge_at, line_at, vertex_slot, Vertex};
import package::lib::project::{world, clip_of, facing, to_screen};
import package::lib::read::{missing_bits, column_value, points_of, point_bits};
import package::lib::trace::{
    trace_first, trace_axis, trace_value, trace_level, trace_bucket_first, trace_buckets, trace_bucket,
};
import package::lib::focus::faded;
import package::lib::mark::px;
import package::lib::points::vertex_half;
import package::lib::lists::{lists, list_entry, list_start, list_total};

// The path a pipeline's strokes read: one of the `PATH_` codes, fixed when the pipeline is made.
override PATH: u32 = PATH_ENDS;

// One segment of a row's path.
struct Segment {
    row: u32,
    index: u32,
}

// A point a path runs through: where it stands (position units as high and low parts, elevation),
// in world units and in position units, its color, and whether it is shown. Sources set where it
// stands; `path_point` places it in the world once.
struct PathPoint {
    hi: vec2f,
    lo: vec2f,
    z: f32,
    world: vec3f,
    position: vec3f,
    color: vec4f,
    // A vertex's half size in CSS pixels, a box when it has its own height; zero elsewhere.
    half: vec2f,
    boxed: bool,
    shown: bool,
}

// How a row's path is stroked.
struct Style {
    width: f32,
    color: vec4f,
    flow: f32,
    dash: bool,
    shown: bool,
}

// A segment on screen: its ends as points, in CSS pixels, and in clip space, and whether it shows.
struct OnScreen {
    ends: array<PathPoint, 2>,
    a: vec2f,
    b: vec2f,
    ca: vec4f,
    cb: vec4f,
    shown: bool,
}

// The segment drawn as instance `instance`: a fixed number per row, or numbered by the mark's list.
fn segment(instance: u32) -> Segment {
    if mark.per_row != NONE {
        let per = max(mark.per_row, 1u);
        return Segment(instance / per, instance % per);
    }
    let row = lists[list_entry(mark.list, instance)];
    return Segment(row, instance - list_start(mark.list, row));
}

// Segments of every live row's path.
fn stroke_instances() -> u32 {
    if mark.per_row != NONE {
        return mark.rows * mark.per_row;
    }
    return list_total(mark.list);
}

// Segments in row `row`'s path, as drawn.
fn path_count(row: u32) -> u32 {
    if mark.per_row != NONE {
        return mark.per_row;
    }
    return list_start(mark.list, row + 1u) - list_start(mark.list, row);
}

// Segments a geodesic from `a` to `b` takes: one per few degrees of arc.
fn arcs(a: vec2f, b: vec2f) -> u32 {
    let p = radians(a);
    let q = radians(b);
    let d = 2.0 * asin(min(1.0, sqrt(pow(sin(0.5 * (q.y - p.y)), 2.0) + cos(p.y) * cos(q.y) * pow(sin(0.5 * (q.x - p.x)), 2.0))));
    return clamp(u32(ceil(degrees(d) / GEODESIC_STEP)), 1u, 64u);
}

// Points the geometry column gives row `row`: an edge's bends, or a whole path.
fn geometry_count(row: u32) -> u32 {
    if row >= mark.rows {
        return 0u;
    }
    return points_of(mark.geometry, row).count;
}

// Segments row `row`'s path has, or for an area its triangles: the count a list over the mark's rows
// counts.
fn row_segments(row: u32) -> u32 {
    switch PATH {
        case PATH_ENDS: {
            let middle = geometry_count(row);
            if middle == 0u && (mark.flags & GEODESIC) != 0u {
                let e = edge_at(row_at(row));
                if e.a == NONE || e.b == NONE {
                    return 0u;
                }
                let a = vertex_slot(e.a);
                let b = vertex_slot(e.b);
                return arcs(a.hi + a.lo, b.hi + b.lo);
            }
            return middle + 1u;
        }
        case PATH_GEOMETRY: {
            let count = geometry_count(row);
            if mark.primitive == TRIANGLES {
                // An area's triangles follow the point its label hangs from, three points each.
                return select(0u, (count - 1u) / 3u, count > 0u);
            }
            return max(count, 1u) - 1u;
        }
        default: {
            return mark.per_row;
        }
    }
}

fn vertex_point(v: Vertex) -> PathPoint {
    var p: PathPoint;
    p.hi = v.hi;
    p.lo = v.lo;
    p.z = v.elevation;
    p.color = unpack4x8unorm(v.color);
    p.half = vertex_half(v);
    p.boxed = (v.flags & OWN_HEIGHT) != 0u;
    p.shown = (v.flags & PLACED) != 0u;
    return p;
}

// CSS pixels from a vertex's middle to its outline along `dir`: a box's or a circle's.
fn outline(p: PathPoint, dir: vec2f) -> f32 {
    if p.boxed {
        return min(p.half.x / max(abs(dir.x), 1e-6), p.half.y / max(abs(dir.y), 1e-6));
    }
    return p.half.x;
}

fn hidden() -> PathPoint {
    var p: PathPoint;
    p.shown = false;
    return p;
}

// A point at `xy` (position units) and elevation `z`.
fn position_point(xy: vec2f, z: f32, color: vec4f) -> PathPoint {
    var p: PathPoint;
    p.hi = xy;
    p.z = z;
    p.color = color;
    p.shown = true;
    return p;
}

// `p` placed in the world, shown only on the side of the globe facing the camera.
fn placed_point(p: PathPoint) -> PathPoint {
    var out = p;
    out.world = world(p.hi, p.lo, p.z);
    out.position = vec3f(p.hi + p.lo, p.z);
    out.shown = p.shown && facing(p.hi, p.lo);
    return out;
}

// The point a fraction `t` of the way along the great circle from `a` to `b`, in degrees.
fn along_circle(a: vec2f, b: vec2f, t: f32) -> vec2f {
    let p = radians(a);
    let q = radians(b);
    let u = vec3f(cos(p.y) * cos(p.x), cos(p.y) * sin(p.x), sin(p.y));
    let v = vec3f(cos(q.y) * cos(q.x), cos(q.y) * sin(q.x), sin(q.y));
    let angle = acos(clamp(dot(u, v), -1.0, 1.0));
    var w = mix(u, v, t);
    if angle > 1e-5 {
        w = (sin((1.0 - t) * angle) * u + sin(t * angle) * v) / sin(angle);
    }
    var lon = degrees(atan2(w.y, w.x));
    // Keep the longitude on the side `a` is on, so the path does not jump across the antimeridian.
    lon += 360.0 * round((a.x - lon) / 360.0);
    return vec2f(lon, degrees(asin(clamp(w.z, -1.0, 1.0))));
}

// Point `i` of an edge's path: its first end, its bends, then its second end; or along the great
// circle between its ends. Each kind of point is made in one place, so shaders compile small.
fn end_point(row: u32, i: u32) -> PathPoint {
    let e = edge_at(row_at(row));
    if e.a == NONE || e.b == NONE || e.a == e.b {
        return hidden();
    }
    let a = vertex_slot(e.a);
    let b = vertex_slot(e.b);
    let bends = points_of(mark.geometry, row);
    let geodesic = bends.count == 0u && (mark.flags & GEODESIC) != 0u;
    // A great circle runs in as many arcs as its list kept for it.
    let last = select(bends.count + 1u, path_count(row), geodesic);
    if i == 0u || i >= last {
        var v = a;
        if i != 0u {
            v = b;
        }
        return vertex_point(v);
    }
    let t = f32(i) / f32(last);
    var xy = along_circle(a.hi + a.lo, b.hi + b.lo, t);
    if !geodesic {
        let w = point_bits(bends, i - 1u);
        if missing_bits(w.x) || missing_bits(w.y) {
            return hidden();
        }
        xy = vec2f(bitcast<f32>(w.x), bitcast<f32>(w.y));
    }
    let z = select(0.0, mix(a.elevation, b.elevation, t), geodesic);
    var p = position_point(xy, z, mix(unpack4x8unorm(a.color), unpack4x8unorm(b.color), t));
    p.shown = p.shown && (a.flags & PLACED) != 0u && (b.flags & PLACED) != 0u;
    return p;
}

// Point `i` of a trace: each bucket's least and greatest value at its middle, then the samples after
// the buckets, or with steps the corners between them.
fn trace_point(row: u32, k: u32) -> PathPoint {
    let buckets = 2u * trace_buckets();
    var value = 0u;
    var frame_index = 0u;
    if k < buckets {
        let span = 1u << (3u * trace_level());
        let bucket = trace_bucket_first() + k / 2u;
        value = trace_bucket(row, bucket, k % 2u);
        frame_index = bucket * span + span / 2u;
    } else {
        var across = k - buckets;
        var up = k - buckets;
        if buckets == 0u && (mark.flags & STEP_AFTER) != 0u {
            across = (k + 1u) / 2u;
            up = k / 2u;
        } else if buckets == 0u && (mark.flags & STEP_BEFORE) != 0u {
            across = k / 2u;
            up = (k + 1u) / 2u;
        }
        let first = trace_first();
        value = trace_value(row, first + up);
        frame_index = first + across;
    }
    if missing_bits(value) {
        return hidden();
    }
    let x = trace_axis(frame_index);
    var p: PathPoint;
    p.hi = vec2f(x.x, bitcast<f32>(value));
    p.lo = vec2f(x.y, 0.0);
    p.color = vec4f(1.0);
    p.shown = true;
    return p;
}

// Point `i` of a geometry column's path: polylines whose parts are broken by a missing point. While
// the mark eases, each point moves from the path it ran through when the transition began: point
// for point when both have as many, else from the old point at the same fraction along.
fn geometry_point(row: u32, i: u32) -> PathPoint {
    let now = points_of(mark.geometry, row);
    if i >= now.count {
        return hidden();
    }
    let w = point_bits(now, i);
    if missing_bits(w.x) || missing_bits(w.y) {
        return hidden();
    }
    var xy = vec2f(bitcast<f32>(w.x), bitcast<f32>(w.y));
    if mark.frozen != NONE && mark.frozen_geometry != NONE && now.count > 0u {
        let was = points_of(mark.frozen_geometry, row);
        if was.count > 0u {
            let along = f32(i) * f32(was.count - 1u) / f32(max(now.count, 2u) - 1u);
            let k = select(u32(round(along)), i, was.count == now.count);
            let o = point_bits(was, min(k, was.count - 1u));
            if !missing_bits(o.x) && !missing_bits(o.y) {
                xy = mix(vec2f(bitcast<f32>(o.x), bitcast<f32>(o.y)), xy, mark.motion);
            }
        }
    }
    return position_point(xy, 0.0, vec4f(1.0));
}

// Point `i` of row `row`'s path, whatever it runs through, placed in the world.
fn path_point(row: u32, i: u32) -> PathPoint {
    var p = hidden();
    switch PATH {
        case PATH_ENDS: { p = end_point(row, i); }
        case PATH_TRACE: { p = trace_point(row, i); }
        case PATH_GEOMETRY: { p = geometry_point(row, i); }
        default: {}
    }
    return placed_point(p);
}

// The two points segment `s` runs between: points `index` and `index + 1` of its row's path. One loop
// makes both, so the path is compiled once.
fn segment_ends(s: Segment) -> array<PathPoint, 2> {
    var ends: array<PathPoint, 2>;
    for (var e = 0u; e < 2u; e++) {
        ends[e] = path_point(s.row, s.index + e);
    }
    return ends;
}

// Whether segment `s` ends a part of its row's path: the path's last, or one before a break.
fn ends_part(s: Segment) -> bool {
    if PATH == PATH_GEOMETRY {
        let points = points_of(mark.geometry, s.row);
        let next = s.index + 2u;
        return next >= points.count || missing_bits(point_bits(points, next).x);
    }
    return s.index + 1u == path_count(s.row);
}

// Lanes from the middle that row `row` runs in among strokes joining the same two vertices.
fn lane(row: u32) -> f32 {
    if mark.lane == NONE || row >= mark.rows {
        return 0.0;
    }
    let bits = column_value(mark.lane, row).x;
    return select(bitcast<f32>(bits), 0.0, missing_bits(bits));
}

// Segment `s` on screen, its ends spread into the row's lane.
fn segment_screen(s: Segment) -> OnScreen {
    let ends = segment_ends(s);
    var out: OnScreen;
    out.ends = ends;
    out.ca = clip_of(ends[0].world);
    out.cb = clip_of(ends[1].world);
    out.shown = ends[0].shown && ends[1].shown && out.ca.w > 0.0 && out.cb.w > 0.0;
    out.a = to_screen(out.ca);
    out.b = to_screen(out.cb);
    // Strokes stop at the outlines of the vertices they end at, without passing each other.
    let along = out.b - out.a;
    let length_along = length(along);
    if length_along > 1e-3 {
        let dir = along / length_along;
        let room = 0.5 * length_along;
        out.a += dir * min(outline(ends[0], dir), room);
        out.b -= dir * min(outline(ends[1], dir), room);
    }
    let shift = lane(s.row) * frame.edge_spacing;
    if shift != 0.0 {
        let dir = normalize(out.b - out.a + vec2f(1e-6, 0.0));
        let normal = vec2f(-dir.y, dir.x);
        out.a += normal * shift;
        out.b += normal * shift;
    }
    return out;
}

// How row `row`'s path is stroked: never thinner than a hairline. Comets flow in length units per
// second, as their spacing is: CSS pixels, or units in a diagram.
fn stroke_style(row: u32) -> Style {
    var s: Style;
    if mark.kind == MARK_EDGES {
        let e = edge_at(row_at(row));
        s.width = px(e.width, EDGE_WIDTH);
        // An edge colored by its ends takes their colors where it draws; this only fades it.
        s.color = select(unpack4x8unorm(e.color), vec4f(1.0), ends_colored());
        s.color.a *= faded(row, e.flags);
        s.flow = e.flow * frame.unit;
        s.dash = (e.flags & DASH) != 0u;
        s.shown = (e.flags & VISIBLE) != 0u;
    } else {
        let l = line_at(row_at(row));
        s.width = px(l.width, LINE_WIDTH);
        s.color = unpack4x8unorm(l.color);
        s.color.a *= faded(row, l.flags);
        s.flow = l.flow * frame.unit;
        s.dash = (l.flags & DASH) != 0u;
        s.shown = (l.flags & VISIBLE) != 0u;
    }
    s.width = max(s.width, 0.75);
    return s;
}

// Whether a stroke's color blends its ends' colors.
fn ends_colored() -> bool {
    return mark.kind == MARK_EDGES && (mark.flags & ENDS_COLOR) != 0u;
}

fn segment_clip(p: PathPoint) -> vec4f {
    return clip_of(p.world);
}
