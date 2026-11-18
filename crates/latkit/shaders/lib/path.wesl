// Paths: the segments a stroke draws, for any mark kind. A row's path runs between an edge's ends
// (straight, through the bends of a geometry column, or along a great circle on the earth), through
// a line's samples across the axis, or through a geometry column's points (a net's star, or a path
// field). Edges joining the same two vertices run beside their path on screen (see `Lane`). Draws,
// probes, bounds, and labels all read segments through `segment_ends` and `segment_screen`, which
// also gives the joints where segments meet, so a path draws as one stroke (see `Joints`). A
// pipeline's `PATH` selects one kind of path, so each pipeline compiles only that kind.
//
// As in `lib/read.wesl`, paths read every word they might need and select the answer, with no early
// return and no short-circuit test (`&&`, `||`) around a read: the D3D compiler behind WebGL takes
// several times longer on code that branches around reads.

import package::lib::types::{
    NONE, VISIBLE, PLACED, DASH, ENDS_COLOR, GEODESIC, MARK_EDGES, PATH_ENDS, PATH_BENDS, PATH_TRACE,
    PATH_GEOMETRY, PATH_POLES, EDGE_WIDTH, LINE_WIDTH, GEODESIC_STEP, OWN_HEIGHT, TRIANGLES, MAX_PIECES,
    MISSING, MISSING_COLOR, FAMILY_LANES, CONVERGE_SQUEEZE, CONVERGE_FAN, SQUEEZE_FILL, PROJECTION_PLANAR,
    PROJECTION_DYNAMIC,
};
import package::lib::bind::{frame, eye, mark, focused};
import package::lib::state::{row_at, edge_at, line_at, end_vertex, same_vertex, Vertex, Edge};
import package::lib::project::{world, clip_of, plot_clip, shows, to_screen, geographic, PROJECTION};
import package::lib::read::{missing_bits, bits_value, points_of, point_bits, Points};
import package::lib::trace::{trace_sample, trace_pair, trace_around};
import package::lib::focus::{faded, growth};
import package::lib::mark::{px, px_per_length};
import package::lib::points::vertex_half;
import package::lib::lists::{list, list_entry, list_start, list_total};
import package::lib::drawn::{drawn_row, drawn_instance};

// The path kind a pipeline's strokes read, one of the `PATH_` codes, fixed when the pipeline is
// created.
override PATH: u32 = PATH_ENDS;

// Keep these constant decisions outside runtime conditions. The module optimizer propagates
// their literal results, removing unused geometry before the driver compiles a program.
fn has_end_vertices() -> bool {
    if PATH == PATH_ENDS { return true; }
    return PATH == PATH_BENDS;
}

fn clips_outlines() -> bool {
    if has_end_vertices() { return true; }
    return PATH == PATH_POLES;
}

// One segment of a row's path. `along` is the distance along the path where it starts, in position
// units (degrees on the earth). The segment list stores it. Without a list it is 0. `row` is the
// held row, whose state and columns it reads. `item` is the drawn row, which the mark's list
// numbers. While its tile fades in or out, the segment shows with opacity `presence` and scale
// `growth`, and a leaving segment ignores the pointer.
struct Segment {
    row: u32,
    item: u32,
    index: u32,
    along: f32,
    presence: f32,
    growth: f32,
    leaving: bool,
}

// Segment `index` of drawn row `item`'s path, starting at distance `along`.
fn path_segment(item: u32, index: u32, along: f32) -> Segment {
    let d = drawn_row(item);
    return Segment(d.row, item, index, along, d.presence, d.growth, d.leaving);
}

// A point on a path, in source coordinates. Projection happens once in `segment_screen`, after
// the geometry has chosen both points. Bounds and lengths never need projection.
struct PathPoint {
    hi: vec2f,
    lo: vec2f,
    z: f32,
    color: vec4f,
    // For a vertex, its half size in CSS pixels and whether it is a box (has its own height). Zero
    // elsewhere.
    half: vec2f,
    boxed: bool,
    // Whether it has a position.
    shown: bool,
}

// A segment has two named endpoints. Keeping this a record rather than a returned array lets
// shader translators preserve direct field access without temporary array copies or indexing.
struct PathEnds {
    a: PathPoint,
    b: PathPoint,
}

// How a row's path is stroked, including its comets' flow and how far they have traveled, and
// whether its color blends the colors of its ends.
struct Style {
    width: f32,
    color: vec4f,
    flow: f32,
    travel: f32,
    dash: bool,
    shown: bool,
    blends: bool,
}

// Where a segment meets the ones before and after it, on screen. Where a path runs on through a
// point, the two segments meeting there split the pixels around it along the line through it that
// halves the angle between them, and each draws only its own side (`owns` in `lib/stroke.wesl`).
// The path covers each pixel once, as one stroke does. On that line both segments lie equally far,
// so the stroke's edge, glow, dashes, and comets carry on across it.
struct Joints {
    // The split lines' normals at `a` and at `b`, pointing along the path.
    split: vec4f,
    // At each end, tan of half the angle the path turns there.
    turn: vec2f,
    // At each end, the shorter of the two segments meeting there, in CSS pixels.
    room: vec2f,
    // Whether the path runs on through each end: a point lies beyond it, all three points show in
    // front of the near plane, and the path does not turn back on itself there.
    through: vec2<bool>,
}

// A segment on screen: its end points in position units, its ends in CSS pixels and in clip space,
// whether it shows, the drawn part as fractions along it, and where it meets the segments beside it.
// The drawn part is cut at the near plane and stops at the markers of the vertices at its ends.
// A fan (`fan`, see `SegmentPoints`) has no length in position units.
struct OnScreen {
    ends: PathEnds,
    a: vec2f,
    b: vec2f,
    ca: vec4f,
    cb: vec4f,
    shown: bool,
    kept: vec2f,
    joints: Joints,
    fan: u32,
}

// Segment `instance` as the mark numbers them. Rows have a fixed number of segments, or the mark's
// list numbers them, with each entry holding a segment's drawn row and distance along.
fn numbered_segment(instance: u32) -> Segment {
    let per = max(mark.per_row, 1u);
    let entry = list_entry(mark.list, 2u * instance);
    let item = list(entry);
    let start = list_start(mark.list, item);
    let along = bitcast<f32>(list(entry + 1u));
    let listed = mark.per_row == NONE;
    return path_segment(
        select(instance / per, item, listed),
        select(instance % per, instance - start, listed),
        select(0.0, along, listed),
    );
}

// The segment drawn at position `instance`, which `drawn_instance` gives.
@if(!focused)
fn segment(instance: u32) -> Segment {
    // Traces have a fixed segment count and never sort by height. Keep their inner vertex loop
    // free of list and height-order traversal; drawn rows still handle a shared paged table.
    if PATH == PATH_TRACE {
        let per = max(mark.per_row, 1u);
        return path_segment(instance / per, instance % per, 0.0);
    }
    return numbered_segment(drawn_instance(instance));
}

// In the focus draw: segment `instance % mark.pieces` of lit row `instance / mark.pieces`, with its
// distance along from the list. Segments past the row's last draw nothing.
@if(focused)
fn segment(instance: u32) -> Segment {
    return lit_segment(instance);
}

fn lit_segment(instance: u32) -> Segment {
    let pieces = max(mark.pieces, 1u);
    let item = focused(mark.focused + instance / pieces);
    let index = instance % pieces;
    let along = bitcast<f32>(list(list_entry(mark.list, 2u * (list_start(mark.list, item) + index)) + 1u));
    let listed = (mark.per_row == NONE) & (item < mark.rows) & (index < path_count(item));
    return path_segment(item, index, select(0.0, along, listed));
}

// Distance between two path points in position units, which a segment adds to the distance along.
fn path_length(a: PathPoint, b: PathPoint) -> f32 {
    return length((b.hi + b.lo) - (a.hi + a.lo));
}

fn path_position(p: PathPoint) -> vec3f {
    return vec3f(p.hi + p.lo, p.z);
}

// Segments across all drawn rows' paths.
fn stroke_instances() -> u32 {
    return select(list_total(mark.list), mark.rows * mark.per_row, mark.per_row != NONE);
}

// Segments in drawn row `item`'s path.
fn path_count(item: u32) -> u32 {
    let listed = list_start(mark.list, item + 1u) - list_start(mark.list, item);
    return select(listed, mark.per_row, mark.per_row != NONE);
}

// Segments a geodesic from `a` to `b` takes: one per `GEODESIC_STEP` degrees of arc, leaving room
// for a fan at each end within `MAX_PIECES`.
fn arcs(a: vec2f, b: vec2f) -> u32 {
    let p = radians(a);
    let q = radians(b);
    let d = 2.0 * asin(min(1.0, sqrt(pow(sin(0.5 * (q.y - p.y)), 2.0) + cos(p.y) * cos(q.y) * pow(sin(0.5 * (q.x - p.x)), 2.0))));
    return clamp(u32(ceil(degrees(d) / GEODESIC_STEP)), 1u, MAX_PIECES - 2u);
}

// The geometry column's point count for held row `row`: an edge's bends, or a whole path. Rows that
// left have none.
fn geometry_count(row: u32) -> u32 {
    return select(points_of(mark.geometry, row).count, 0u, row >= mark.held - mark.exits);
}

// The segment count of held row `row`'s path, or an area's triangle count, as a segment list counts
// them. A path between two ends without bends takes one segment, or on a great circle one per
// `GEODESIC_STEP` degrees of arc. A parallel edge that fans into its vertices takes one more at each
// end (see `fans`).
fn row_segments(row: u32) -> u32 {
    switch PATH {
        case PATH_ENDS: { return end_segments(row); }
        case PATH_BENDS: { return end_segments(row); }
        case PATH_GEOMETRY: {
            let count = geometry_count(row);
            if mark.primitive == TRIANGLES {
                // An area's points start with its label anchor, then three per triangle.
                return select(0u, (count - 1u) / 3u, count > 0u);
            }
            return max(count, 1u) - 1u;
        }
        default: { return mark.per_row; }
    }
}

fn end_segments(row: u32) -> u32 {
    let e = edge_at(row_at(row));
    let a = end_vertex(0u, e.a);
    let b = end_vertex(1u, e.b);
    let fan = select(0u, 2u, fans(lane_of(row)));
    if PATH == PATH_BENDS {
        let middle = geometry_count(row);
        if middle > 0u { return middle + 1u + fan; }
    }
    if PROJECTION == PROJECTION_PLANAR { return 1u + fan; }
    if PROJECTION == PROJECTION_DYNAMIC {
        if !geographic() { return 1u + fan; }
    }
    if (mark.flags & GEODESIC) == 0u { return 1u + fan; }
    return select(0u, arcs(a.hi + a.lo, b.hi + b.lo) + fan, (e.a != NONE) & (e.b != NONE));
}

// Vertex `held` of end `end` as a path point.
fn vertex_point(end: u32, held: u32) -> PathPoint {
    return vertex_shape(end_vertex(end, held));
}

fn vertex_shape(v: Vertex) -> PathPoint {
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

// How far from `p`, along `dir`, a path leaves vertex `v`'s marker centered at `center`, in CSS
// pixels: to a box's outline, or a circle's. Zero where `p` lies outside the marker. From the
// center, it is the distance to the outline along `dir`.
fn exit_marker(v: PathPoint, center: vec2f, p: vec2f, dir: vec2f) -> f32 {
    let q = p - center;
    let t = (v.half - sign(dir) * q) / max(abs(dir), vec2f(1e-6));
    let boxed = select(0.0, min(t.x, t.y), all(abs(q) <= v.half));
    let along = dot(q, dir);
    let outside = dot(q, q) - v.half.x * v.half.x;
    let circle = select(0.0, sqrt(max(along * along - outside, 0.0)) - along, outside <= 0.0);
    return select(circle, boxed, v.boxed);
}

// How far vertex `v`'s marker reaches across a path whose sideways direction is `n`, from its
// center to its outline, in CSS pixels.
fn marker_across(v: PathPoint, n: vec2f) -> f32 {
    return select(v.half.x, abs(n.x) * v.half.x + abs(n.y) * v.half.y, v.boxed);
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

// The point a fraction `t` along the great circle from `a` to `b` (in degrees).
fn along_circle(a: vec2f, b: vec2f, t: f32) -> vec2f {
    let p = radians(a);
    let q = radians(b);
    let u = vec3f(cos(p.y) * cos(p.x), cos(p.y) * sin(p.x), sin(p.y));
    let v = vec3f(cos(q.y) * cos(q.x), cos(q.y) * sin(q.x), sin(q.y));
    // The arc's angle from its chord, which stays precise for the shortest arcs.
    let angle = 2.0 * asin(min(1.0, 0.5 * length(v - u)));
    var w = mix(u, v, t);
    if angle > 1e-5 {
        w = (sin((1.0 - t) * angle) * u + sin(t * angle) * v) / sin(angle);
    }
    var lon = degrees(atan2(w.y, w.x));
    // Keep the longitude on the side `a` is on, so the path does not jump across the antimeridian.
    lon += 360.0 * round((a.x - lon) / 360.0);
    return vec2f(lon, degrees(asin(clamp(w.z, -1.0, 1.0))));
}

// The point a fraction `t` from vertex `a` to `b`. A `GEODESIC` mark follows the great circle.
// Otherwise the point is offset from `a`'s high and low parts along a straight line, which keeps
// their precision.
fn between(a: Vertex, b: Vertex, t: f32) -> PathPoint {
    var p: PathPoint;
    p.z = mix(a.elevation, b.elevation, t);
    if PROJECTION != PROJECTION_PLANAR {
        if geographic() {
            if (mark.flags & GEODESIC) != 0u {
                p.hi = along_circle(a.hi + a.lo, b.hi + b.lo, t);
                return p;
            }
        }
    }
    let d = (b.hi - a.hi) + (b.lo - a.lo);
    p.hi = a.hi;
    p.lo = a.lo + d * t;
    return p;
}

// Point `i` of an edge's path of `count` segments, as a segment list numbers them: its first end,
// its bends, then its second end. Without bends, it runs between its ends in its own segments. A
// fan stays at its vertex in position units, so a row that fans repeats its first and last points.
// An end reads only its own vertex. Each kind of point is built in one place, which keeps compiled
// shaders small.
fn end_point(row: u32, count: u32, i: u32) -> PathPoint {
    let e = edge_at(row_at(row));
    let a = end_vertex(0u, e.a);
    let b = end_vertex(1u, e.b);
    let bends = bends_of(row);
    let fanned = fans(lane_of(row));
    let last = own_segments(bends, count, fanned);
    var p = edge_point(a, b, bends, last, select(i, min(max(i, 1u) - 1u, last), fanned));
    p.shown = p.shown & (e.a != NONE) & (e.b != NONE) & !same_vertex(e.a, e.b);
    return p;
}

// The segments of an edge's own path, without its fans: one past its bends, or of `count` listed.
fn own_segments(bends: Points, count: u32, fanned: bool) -> u32 {
    let own = select(count, max(count, 3u) - 2u, fanned);
    return select(bends.count + 1u, own, bends.count == 0u);
}

// Shared endpoint state is read once for a segment, including when both points lie on its path.
fn edge_point(a: Vertex, b: Vertex, bends: Points, last: u32, i: u32) -> PathPoint {
    let t = f32(i) / f32(max(last, 1u));
    var p = middle_point(a, b, bends, t, i);
    p.color = mix(unpack4x8unorm(a.color), unpack4x8unorm(b.color), t);
    p.shown = p.shown & ((a.flags & PLACED) != 0u) & ((b.flags & PLACED) != 0u);
    if i == 0u {
        p = vertex_shape(a);
    } else if i >= last {
        p = vertex_shape(b);
    }
    return p;
}

// Only a path with declared bends needs geometry-column traversal. Ordinary endpoint paths
// retain great circles through the same interpolation helper.
fn bends_of(row: u32) -> Points {
    if PATH == PATH_BENDS { return points_of(mark.geometry, row); }
    var empty: Points;
    return empty;
}

fn middle_point(a: Vertex, b: Vertex, bends: Points, t: f32, i: u32) -> PathPoint {
    var p = between(a, b, t);
    p.shown = true;
    if PATH == PATH_BENDS {
        // The bend is read whatever the count, and taken only where there are bends.
        let w = point_bits(bends, i - 1u);
        if bends.count > 0u {
            var bend: PathPoint;
            bend.hi = bitcast<vec2f>(w);
            bend.shown = !missing_bits(w.x) & !missing_bits(w.y);
            return bend;
        }
    }
    return p;
}

// Point `k` of a trace. In a run of buckets, each bucket gives its least and greatest value at its
// middle. In a run of frames, each frame gives its value, plus the corners between frames when the
// mark steps. A point past its run's last breaks the line before the next run.
fn trace_point(row: u32, k: u32) -> PathPoint {
    return sample_point(trace_sample(row, k));
}

fn sample_point(sample: vec3u) -> PathPoint {
    if missing_bits(sample.z) {
        return hidden();
    }
    var p: PathPoint;
    p.hi = vec2f(bitcast<f32>(sample.x), bitcast<f32>(sample.z));
    p.lo = vec2f(bitcast<f32>(sample.y), 0.0);
    p.color = vec4f(1.0);
    p.shown = true;
    return p;
}

// Point `i` of a geometry column's path: polylines whose parts are separated by missing points.
// During a transition, each point moves from the path at the transition's start: from the same
// point when both paths have the same count, else from the old point at the same fraction along.
fn geometry_point(row: u32, i: u32) -> PathPoint {
    // Like column reads, this reads both paths' points and selects (see `lib/read.wesl`).
    let now = points_of(mark.geometry, row);
    let w = point_bits(now, i);
    let xy = bitcast<vec2f>(w);
    let was = points_of(mark.frozen_geometry, row);
    let along = f32(i) * f32(max(was.count, 1u) - 1u) / f32(max(now.count, 2u) - 1u);
    let k = select(u32(round(along)), i, was.count == now.count);
    let o = point_bits(was, min(k, max(was.count, 1u) - 1u));
    let eased = (mark.frozen != NONE) & (mark.frozen_geometry != NONE) & (was.count > 0u) & !missing_bits(o.x)
        & !missing_bits(o.y);
    var p = position_point(select(xy, mix(bitcast<vec2f>(o), xy, mark.motion), eased), 0.0, vec4f(1.0));
    p.shown = (i < now.count) & !missing_bits(w.x) & !missing_bits(w.y);
    return p;
}

// Point `i` of a pole: the row's own vertex, then the ground below it.
fn pole_point(row: u32, i: u32) -> PathPoint {
    let e = edge_at(row_at(row));
    if e.a == NONE {
        return hidden();
    }
    var p = vertex_point(0u, e.a);
    if i > 0u {
        p.z = 0.0;
        p.half = vec2f(0.0);
    }
    return p;
}

// Point `i` of held row `row`'s path of `count` segments, for any path kind.
fn path_point(row: u32, count: u32, i: u32) -> PathPoint {
    switch PATH {
        case PATH_ENDS: { return end_point(row, count, i); }
        case PATH_BENDS: { return end_point(row, count, i); }
        case PATH_TRACE: { return trace_point(row, i); }
        case PATH_GEOMETRY: { return geometry_point(row, i); }
        case PATH_POLES: { return pole_point(row, i); }
        default: { return hidden(); }
    }
}

// An edge's path, read once for every point a segment takes from it: its ends, its bends, its own
// segments (`last`, without fans), its lane, whether it fans into its vertices, whether it draws,
// and its width before focus and fading, which its lane's step adds to.
struct EdgePath {
    a: Vertex,
    b: Vertex,
    bends: Points,
    last: u32,
    lane: Lane,
    fanned: bool,
    drawn: bool,
    width: f32,
}

fn edge_path(s: Segment, count: u32) -> EdgePath {
    let e = edge_at(row_at(s.row));
    let a = end_vertex(0u, e.a);
    let b = end_vertex(1u, e.b);
    let bends = bends_of(s.row);
    let l = lane_of(s.row);
    let fanned = fans(l);
    // A select, not `&`: Metal writes the struct below as a brace initializer (see `segment_of` in
    // `draw/strokes.wesl`).
    let drawn = select(false, (e.a != NONE) & (e.b != NONE), !same_vertex(e.a, e.b));
    return EdgePath(a, b, bends, own_segments(bends, count, fanned), l, fanned, drawn, max(edge_width(e), 0.75));
}

// Point `i` of edge path `e`, numbered along its own path.
fn edge_path_point(e: EdgePath, i: u32) -> PathPoint {
    var p = edge_point(e.a, e.b, e.bends, e.last, i);
    p.shown = p.shown & e.drawn;
    return p;
}

// Where segment `index` of edge path `e` lies: the own segment it draws or draws beside (x), and
// whether it is a fan into the first vertex (1), the last (2), or neither (0). A row that fans
// draws its own segments between its two fans.
fn piece_of(e: EdgePath, index: u32) -> vec2u {
    let fan = select(0u, select(select(0u, 2u, index > e.last), 1u, index == 0u), e.fanned);
    return vec2u(select(index, clamp(index, 1u, e.last) - 1u, e.fanned), fan);
}

// Segment `s`'s two end points in position units. An edge reads its shared state once for both
// positions. A fan stays at its vertex: it turns only on screen.
fn segment_ends(s: Segment) -> PathEnds {
    if PATH == PATH_TRACE {
        let samples = trace_pair(s.row, s.index);
        return PathEnds(sample_point(samples[0]), sample_point(samples[1]));
    }
    let count = path_count(s.item);
    if has_end_vertices() {
        let e = edge_path(s, count);
        let piece = piece_of(e, s.index);
        let a = select(piece.x, piece.x + 1u, piece.y == 2u);
        let b = select(piece.x + 1u, piece.x, piece.y == 1u);
        return PathEnds(edge_path_point(e, a), edge_path_point(e, b));
    }
    return PathEnds(path_point(s.row, count, s.index), path_point(s.row, count, s.index + 1u));
}

// Segment `s`'s points: the own segment of its row's path it draws, or for a fan draws beside
// (`ends`), the points before and after that segment, each hidden where the path does not run on
// through it, and for an edge, its lane, its vertices, and its width (see `EdgePath`).
struct SegmentPoints {
    before: PathPoint,
    ends: PathEnds,
    after: PathPoint,
    // Whether `ends` is its path's first own segment, and whether it is the last.
    first: bool,
    last: bool,
    // 1 for a fan into the first vertex, 2 into the last, else 0 (see `fans`).
    fan: u32,
    lane: Lane,
    vertex_a: PathPoint,
    vertex_b: PathPoint,
    width: f32,
}

// Segment `s`'s points, from one read of its row's path. Like every path read, it reads whatever it
// might need and hides what lies past the path.
fn segment_points(s: Segment) -> SegmentPoints {
    let count = path_count(s.item);
    var out: SegmentPoints;
    var i = s.index;
    var last = count;
    if PATH == PATH_TRACE {
        let samples = trace_around(s.row, s.index);
        out.before = sample_point(samples[0]);
        out.ends = PathEnds(sample_point(samples[1]), sample_point(samples[2]));
        out.after = sample_point(samples[3]);
    } else if has_end_vertices() {
        let e = edge_path(s, count);
        let piece = piece_of(e, s.index);
        i = piece.x;
        last = e.last;
        out.before = edge_path_point(e, max(i, 1u) - 1u);
        out.ends = PathEnds(edge_path_point(e, i), edge_path_point(e, i + 1u));
        out.after = edge_path_point(e, i + 2u);
        out.fan = piece.y;
        out.lane = e.lane;
        out.vertex_a = vertex_shape(e.a);
        out.vertex_b = vertex_shape(e.b);
        out.width = e.width;
    } else {
        out.before = path_point(s.row, count, max(i, 1u) - 1u);
        out.ends = PathEnds(path_point(s.row, count, i), path_point(s.row, count, i + 1u));
        out.after = path_point(s.row, count, i + 2u);
    }
    out.first = i == 0u;
    out.last = i + 1u >= last;
    out.before.shown = out.before.shown & !out.first;
    out.after.shown = out.after.shown & !out.last;
    return out;
}

// The joint at screen point `at`, between the segment from `before` and the one to `after`; z is 1
// where a point shows (see `point_screen`). Both segments meeting at a point compute it from the
// same three points, so they split its pixels along the same line. `miter` is how far, per pixel a
// parallel edge runs beside the path, the point moves: along the line halving the turn, so the two
// segments of a parallel edge still meet. A sharp turn moves it at most four times as far.
struct Joint {
    normal: vec2f,
    turn: f32,
    room: f32,
    through: bool,
    miter: vec2f,
}

fn joint(before: vec3f, at: vec3f, after: vec3f) -> Joint {
    let into = at.xy - before.xy;
    let onward = after.xy - at.xy;
    let lengths = vec2f(length(into), length(onward));
    let u = into / max(lengths.x, 1e-6);
    let v = onward / max(lengths.y, 1e-6);
    let straight = 1.0 + dot(u, v);
    // A select, not `&`: Metal writes the struct below as a brace initializer (see `segment_of` in
    // `draw/strokes.wesl`).
    let shown = min(before.z, min(at.z, after.z)) > 0.0;
    let through = select(false, all(lengths > vec2f(1e-3)) & (straight > 1e-3), shown);
    let sum = u + v;
    let reach = max(length(sum), 1e-6);
    let miter = beside(sum / reach) / max(0.5 * reach, 0.25);
    return Joint(sum, abs(u.x * v.y - u.y * v.x) / max(straight, 1e-3), min(lengths.x, lengths.y), through, miter);
}

fn joints_of(start: Joint, end: Joint) -> Joints {
    return Joints(
        vec4f(start.normal, end.normal),
        vec2f(start.turn, end.turn),
        vec2f(start.room, end.room),
        vec2<bool>(start.through, end.through)
    );
}

// The sideways direction, on screen, of a parallel edge whose path runs along `d`.
fn beside(d: vec2f) -> vec2f {
    return vec2f(-d.y, d.x);
}

// Point `p` on screen in CSS pixels, with z 1 where it shows in front of the near plane, else 0. It
// projects as `on_screen` projects a segment's ends, so segments meeting at a point find it at the
// same place.
fn point_screen(p: PathPoint) -> vec3f {
    let c = path_clip(p);
    return vec3f(to_screen(c), select(0.0, 1.0, p.shown & (c.w > 0.0) & (c.z <= c.w)));
}

fn path_clip(p: PathPoint) -> vec4f {
    if PATH == PATH_TRACE { return plot_clip(p.hi, p.lo); }
    return clip_of(world(p.hi, p.lo, p.z));
}

// A row's lane in its family of parallel edges, the edges joining the same two vertices: its offset
// from the middle in steps, its index in the family counted from one side, the step as a fraction of
// a full one, and the family's size. A family spreads at most `FAMILY_LANES` steps wide, so a larger
// family packs closer.
//
// A parallel edge runs beside its path on screen, its offset times a step apart, at any zoom. A step
// is its width plus the theme's gap (see `lane_step`). Its ends come together at its vertices as
// the theme's `converge` says: squeezed to fit the smaller vertex, fanned into each vertex's center
// (see `fans`), or kept straight to each vertex's outline, or beside it.
struct Lane {
    offset: f32,
    index: u32,
    step: f32,
    size: u32,
}

fn lane_of(row: u32) -> Lane {
    // The high 16 bits hold twice the lane's position from the middle, plus 32768. The low 16 bits
    // hold the family's size. Lanes are a derived static bit column, never joined or sampled channel
    // values. A row without a lane has offset 0 and step 1.
    let word = bits_value(mark.lane, row);
    let size = word & 0xffffu;
    let laned = (mark.lane != NONE) & (row < mark.held - mark.exits) & (word != NONE) & (word != MISSING) & (size >= 2u);
    let twice = i32(word >> 16u) - 32768;
    let step = min(1.0, FAMILY_LANES / f32(max(size, 1u)));
    return Lane(
        select(0.0, 0.5 * f32(twice) * step, laned),
        select(0u, u32((twice + i32(size) - 1) / 2), laned),
        select(1.0, step, laned),
        select(1u, size, laned),
    );
}

// Whether a row in lane `l` fans into its vertices: it lies off its family's middle while parallel
// edges converge by fanning. Such a row draws one more segment at each end, from its vertex's center
// out to its offset.
fn fans(l: Lane) -> bool {
    return (frame.converge == CONVERGE_FAN) & (l.offset != 0.0);
}

// The step between neighboring parallel edges of `p`'s family, in CSS pixels: an edge's width plus
// the theme's gap. Squeezed, the family fits within `SQUEEZE_FILL` of the smaller of its vertices,
// across the line between their centers on screen, `a` and `b`.
fn lane_step(p: SegmentPoints, a: vec2f, b: vec2f) -> f32 {
    let step = p.width + frame.gap;
    let across = beside(normalize(b - a + vec2f(1e-6, 0.0)));
    let room = SQUEEZE_FILL * min(marker_across(p.vertex_a, across), marker_across(p.vertex_b, across));
    // Half the family's width, in steps.
    let half = 0.5 * f32(max(p.lane.size, 1u) - 1u) * p.lane.step;
    return select(step, min(step, room / max(half, 1e-6)), frame.converge == CONVERGE_SQUEEZE);
}

// Whether lane `l` is left out where neighboring parallel edges, `apart` CSS pixels apart, would lie
// less than a pixel apart: only every `n`-th draws, `n` a power of two, so those drawn lie at least
// a pixel apart.
fn lane_thinned(l: Lane, apart: f32) -> bool {
    let n = max(u32(exp2(ceil(log2(1.0 / max(apart, 1e-6))))), 1u);
    return (apart < 1.0) & (l.index % n != 0u);
}

// How far a fan beside a segment from `a` to `b` on screen reaches along it before the parallel
// edge, `o` pixels beside the path, runs straight: a few steps, and less on a short segment.
fn fan_length(a: vec2f, b: vec2f, o: f32) -> f32 {
    return min(3.0 * abs(o) + 8.0, 0.3 * length(b - a));
}

// The part of the segment from clip position `ca` to `cb` in front of the near plane, as fractions
// along it. Depth is reversed, so a position lies in front where z <= w, and w - z is linear along
// the segment. A segment reaching behind the eye is cut where it crosses, not dropped. The range is
// empty when both ends lie behind.
fn in_front(ca: vec4f, cb: vec4f) -> vec2f {
    let da = ca.w - ca.z;
    let db = cb.w - cb.z;
    let t = da / (da - db);
    return vec2f(select(0.0, t, da < 0.0), select(1.0, t, db < 0.0));
}

// Segment `s` on screen (see `OnScreen`).
fn segment_screen(s: Segment) -> OnScreen {
    return on_screen(segment_points(s));
}

// The segment `p` holds on screen: the part in front of the near plane, with `kept` giving the drawn
// part. A parallel edge runs beside its path, and a fan from its vertex out to it.
fn on_screen(p: SegmentPoints) -> OnScreen {
    var out: OnScreen;
    // In position units a fan stays at its vertex.
    out.fan = p.fan;
    out.ends = p.ends;
    if p.fan == 1u { out.ends.b = p.ends.a; }
    if p.fan == 2u { out.ends.a = p.ends.b; }
    if !p.ends.a.shown | !p.ends.b.shown { return out; }
    var cut = vec2f(0.0, 1.0);
    if PATH == PATH_TRACE {
        out.ca = plot_clip(p.ends.a.hi, p.ends.a.lo);
        out.cb = plot_clip(p.ends.b.hi, p.ends.b.lo);
        out.shown = true;
    } else {
        let wa = world(p.ends.a.hi, p.ends.a.lo, p.ends.a.z);
        let wb = world(p.ends.b.hi, p.ends.b.lo, p.ends.b.z);
        let ca = clip_of(wa);
        let cb = clip_of(wb);
        out.ca = ca;
        out.cb = cb;
        // Most segments are wholly in front. Only a segment crossing the near plane needs a
        // division and endpoint interpolation, including when one end lies behind the eye.
        if (ca.z > ca.w) | (cb.z > cb.w) {
            cut = in_front(ca, cb);
            out.ca = mix(ca, cb, cut.x);
            out.cb = mix(ca, cb, cut.y);
        }
        // A segment reaching past the globe's edge still draws. The globe's depth clips it there.
        out.shown = (shows(wa) | shows(wb)) & (cut.x < cut.y);
    }
    // The own segment on screen, and its joints. An end cut at the near plane joins nothing. A path
    // of one segment has no joint, so it projects nothing more.
    let sa = to_screen(out.ca);
    let sb = to_screen(out.cb);
    let front = vec2f(select(0.0, 1.0, cut.x == 0.0), select(0.0, 1.0, cut.y == 1.0));
    var before = vec3f(0.0);
    var after = vec3f(0.0);
    let single = p.first & p.last;
    if !single {
        before = point_screen(p.before);
        after = point_screen(p.after);
    }
    var start = joint(before, vec3f(sa, front.x), vec3f(sb, front.y));
    var end = joint(vec3f(sa, front.x), vec3f(sb, front.y), after);
    let dir = normalize(sb - sa + vec2f(1e-6, 0.0));
    var a = sa;
    var b = sb;
    // Whether the drawn segment starts or ends at a vertex, which its stroke stops short of.
    var at_from = p.first;
    var at_to = p.last;
    if has_end_vertices() {
        var o = 0.0;
        if p.lane.offset != 0.0 {
            // A path of one segment runs between its vertices' centers. A longer one projects them.
            var centers = vec4f(sa, sb);
            if !single {
                centers = vec4f(point_screen(p.vertex_a).xy, point_screen(p.vertex_b).xy);
            }
            let step = lane_step(p, centers.xy, centers.zw);
            o = p.lane.offset * step;
            out.shown = out.shown & !lane_thinned(p.lane, step * p.lane.step);
        }
        // Each end moves sideways along the line halving the turn there, so the segments of a
        // bent path meet beside it too.
        a = sa + select(beside(dir), start.miter, start.through) * o;
        b = sb + select(beside(dir), end.miter, end.through) * o;
        if fans(p.lane) {
            // The fans run from each vertex's center to the edge's offset, a fan's length along the
            // path. The segments meeting there both compute that corner and its joint from the
            // first own segment, or the last.
            let reach = fan_length(sa, sb, o);
            let into = sa + beside(dir) * o + dir * reach;
            let out_of = sb + beside(dir) * o - dir * reach;
            let fan_start = joint(vec3f(sa, front.x), vec3f(into, front.x * front.y), vec3f(into + dir * reach, front.y));
            let fan_end = joint(vec3f(out_of - dir * reach, front.x), vec3f(out_of, front.x * front.y), vec3f(sb, front.y));
            if p.first {
                a = into;
                start = fan_start;
            }
            if p.last {
                b = out_of;
                end = fan_end;
            }
            if p.fan == 1u {
                a = sa;
                b = into;
                end = fan_start;
                start.through = false;
            }
            if p.fan == 2u {
                a = out_of;
                b = sb;
                start = fan_end;
                end.through = false;
            }
            at_from = p.fan == 1u;
            at_to = p.fan == 2u;
        }
    }
    out.kept = cut;
    // Strokes stop at the markers of their end vertices, and each end gives up at most half the
    // length. An end cut at the near plane has no vertex to stop at.
    if clips_outlines() {
        let along = b - a;
        let length_along = length(along);
        if length_along > 1e-3 {
            let u = along / length_along;
            let room = 0.5 * length_along;
            let stops = vec2f(
                select(0.0, exit_marker(p.ends.a, sa, a, u), at_from & (cut.x == 0.0)),
                select(0.0, exit_marker(p.ends.b, sb, b, -u), at_to & (cut.y == 1.0)),
            );
            let short = min(stops, vec2f(room));
            a += u * short.x;
            b -= u * short.y;
            out.kept = mix(vec2f(cut.x), vec2f(cut.y), vec2f(short.x, length_along - short.y) / length_along);
        }
    }
    out.a = a;
    out.b = b;
    out.joints = joints_of(start, end);
    return out;
}

// Whether segment `s` ends a part of its row's path: the path's last segment, or one before a
// break.
fn ends_part(s: Segment) -> bool {
    if PATH == PATH_GEOMETRY {
        let points = points_of(mark.geometry, s.row);
        let next = s.index + 2u;
        return (next >= points.count) | missing_bits(point_bits(points, next).x);
    }
    return s.index + 1u == path_count(s.item);
}

// How row `row`'s path is stroked, never thinner than 0.75 CSS pixels. Comet flow and travel are in
// the theme's flow unit.
fn stroke_style(row: u32) -> Style {
    // A fixed path kind also fixes its row type, except geometry paths shared by lines and nets.
    if PATH == PATH_TRACE { return line_style(row); }
    if has_end_vertices() { return edge_style(row); }
    if PATH == PATH_POLES { return edge_style(row); }
    if mark.kind == MARK_EDGES { return edge_style(row); }
    return line_style(row);
}

// Edge `e`'s width in CSS pixels, before focus and fading.
fn edge_width(e: Edge) -> f32 {
    return clamp(px(e.width, EDGE_WIDTH), mark.size_min, mark.size_max);
}

fn edge_style(row: u32) -> Style {
    var s: Style;
    let e = edge_at(row_at(row));
    s.width = edge_width(e) * growth(e.flags);
    // A missing color takes its endpoints' colors in the draw. Here it only fades.
    s.blends = ((mark.flags & ENDS_COLOR) != 0u) & (e.color == MISSING_COLOR);
    s.color = select(unpack4x8unorm(e.color), vec4f(1.0), s.blends);
    s.color.a *= faded(row, e.flags);
    s.flow = e.flow;
    s.travel = e.travel;
    s.dash = (e.flags & DASH) != 0u;
    s.shown = (e.flags & VISIBLE) != 0u;
    s.width = max(s.width, 0.75);
    return s;
}

fn line_style(row: u32) -> Style {
    let l = line_at(row_at(row));
    var s: Style;
    s.width = max(clamp(px(l.width, LINE_WIDTH), mark.size_min, mark.size_max) * growth(l.flags), 0.75);
    s.color = unpack4x8unorm(l.color);
    s.color.a *= faded(row, l.flags);
    s.flow = l.flow;
    s.travel = l.travel;
    s.dash = (l.flags & DASH) != 0u;
    s.shown = (l.flags & VISIBLE) != 0u;
    return s;
}
