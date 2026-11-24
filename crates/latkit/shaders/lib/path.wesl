// Paths: the segments a stroke draws, for any mark kind. A row's path runs between an edge's ends
// (straight, through the bends of a geometry column, or along a great circle on the earth), through
// a line's samples across the axis, or through a geometry column's points (a net's star, or a path
// field). Edges joining the same two vertices run beside their path on screen (see `Lane`). Bounds and lengths read
// source endpoints. Drawing and queries read the records produced from projected segments. A
// pipeline's `PATH` selects one kind of path, so each pipeline compiles only that kind.
//
// As in `lib/read.wesl`, paths read every word they might need and select the answer, with no early
// return and no short-circuit test (`&&`, `||`) around a read: the D3D compiler behind WebGL takes
// several times longer on code that branches around reads. That compiler also inlines every call,
// so a segment reads its points at one call (`path_points`) and projects them at one (`project_segment`),
// each in a loop: a pipeline compiles a path's geometry and its projection once, however many
// points it takes.

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

// Whether the pipeline's edges end where their paths meet their vertices' markers (`meet:
// 'nearest'`), fixed when the pipeline is created. Only the pipelines of such edges hold the code,
// so other edges compile and run as if there were none.
override MEET: bool = false;

// Keep these constant decisions outside runtime conditions. The module optimizer propagates
// their literal results, removing unused geometry before the driver compiles a program.
fn has_end_vertices() -> bool {
    if PATH == PATH_ENDS { return true; }
    return PATH == PATH_BENDS;
}

fn straight_planar() -> bool {
    if PATH != PATH_ENDS { return false; }
    return PROJECTION == PROJECTION_PLANAR;
}

fn clips_outlines() -> bool {
    if has_end_vertices() { return true; }
    return PATH == PATH_POLES;
}

// Whether the pipeline joins each segment with the ones before and after it, which only strokes do
// (`joined`). Elsewhere the points beside a segment are never read or projected.
@if(joined)
fn joins() -> bool {
    return true;
}

@if(!joined)
fn joins() -> bool {
    return false;
}

// One segment of a row's path. `along` is the distance along the path where it ends, in the unit
// its list measures (see `segments` in `raster/lists.wesl`). The segment list stores it. Without a
// list it is 0. `row` is the
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

// Segment `index` of drawn row `item`'s path, ending at distance `along`.
fn path_segment(item: u32, index: u32, along: f32) -> Segment {
    let d = drawn_row(item);
    return Segment(d.row, item, index, along, d.presence, d.growth, d.leaving);
}

// A point on a path, in source coordinates. Projection happens in `project_segment`, after
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
// The drawn part is cut at the near plane and stops at the markers of its path's end vertices
// (`stops` says at which of its ends it does), on whichever segment the path leaves or reaches
// them: a segment that lies wholly on one draws nothing.
// `chord` is the length in CSS pixels, between its points and cut at the near plane, of the path's
// segment it draws or runs beside, as a segment list measures it (see `screen_length`), and
// `visible` the drawn part as fractions of that cut segment. A fan (`fan`, see `SegmentPoints`)
// keeps the ends of the segment it fans from, and stands for one end of it (see `fit_segment`).
struct OnScreen {
    ends: PathEnds,
    a: vec2f,
    b: vec2f,
    ca: vec4f,
    cb: vec4f,
    shown: bool,
    kept: vec2f,
    chord: f32,
    visible: vec2f,
    joints: Joints,
    fan: u32,
    stops: vec2<bool>,
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
fn drawn_segment(instance: u32) -> Segment {
    // Traces have a fixed segment count and never sort by height. Keep their inner vertex loop
    // free of list and height-order traversal; drawn rows still handle a shared paged table.
    if PATH == PATH_TRACE {
        let per = max(mark.per_row, 1u);
        return path_segment(instance / per, instance % per, 0.0);
    }
    return numbered_segment(drawn_instance(instance));
}

@if(!focused)
fn segment(instance: u32) -> Segment {
    return drawn_segment(instance);
}

// In the focus draw: segment `instance % mark.pieces` of lit row `instance / mark.pieces`, with its
// distance along from the list. Segments past the row's last draw nothing.
@if(focused)
fn segment(instance: u32) -> Segment {
    return lit_segment(instance);
}

// The segment a stroke mark draws at position `instance`: in its rows' draws, or with `lit`, in its
// focus draw. The screen pass writes both kinds of record with one program.
fn stroke_segment(instance: u32, lit: bool) -> Segment {
    if lit {
        return lit_segment(instance);
    }
    return drawn_segment(instance);
}

fn lit_segment(instance: u32) -> Segment {
    let pieces = max(mark.pieces, 1u);
    let item = focused(mark.focused + instance / pieces);
    let index = instance % pieces;
    let along = bitcast<f32>(list(list_entry(mark.list, 2u * (list_start(mark.list, item) + index)) + 1u));
    let listed = (mark.per_row == NONE) & (item < mark.rows) & (index < path_count(item));
    return path_segment(item, index, select(0.0, along, listed));
}

// The length of drawn row `item`'s whole path, in the unit its list measures: where its last listed
// segment ends.
fn path_total(item: u32) -> f32 {
    let last = max(list_start(mark.list, item + 1u), 1u) - 1u;
    return bitcast<f32>(list(list_entry(mark.list, 2u * last) + 1u));
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
    let e = edge_at(row_at(row));
    let a = end_vertex(0u, e.a);
    let b = end_vertex(1u, e.b);
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

// Where a path whose next point lies at `next` meets vertex `v`'s marker centered at `center`, all
// on screen: the point of its box nearest `next`, or of its circle. A path point that is no vertex
// has no size, and stays where it is.
fn meet_marker(v: PathPoint, center: vec2f, next: vec2f) -> vec2f {
    let q = next - center;
    let boxed = clamp(q, -v.half, v.half);
    let round = q * min(1.0, v.half.x / max(length(q), 1e-6));
    return center + select(round, boxed, v.boxed);
}

// The farthest vertex `v`'s marker reaches from its center, in CSS pixels: its radius, or a box's
// half diagonal. No path leaves the marker farther out (see `exit_marker`).
fn marker_reach(v: PathPoint) -> f32 {
    return select(v.half.x, length(v.half), v.boxed);
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
fn between(a: PathPoint, b: PathPoint, t: f32) -> PathPoint {
    var p: PathPoint;
    p.z = mix(a.z, b.z, t);
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

// The segments of an edge's own path, without its fans: one past its bends, or of `count` listed.
fn own_segments(bends: Points, count: u32, fanned: bool) -> u32 {
    let own = select(count, max(count, 3u) - 2u, fanned);
    return select(bends.count + 1u, own, bends.count == 0u);
}

// Shared endpoint state is read once for a segment, including when both points lie on its path.
fn edge_point(a: PathPoint, b: PathPoint, bends: Points, last: u32, i: u32) -> PathPoint {
    let t = f32(i) / f32(max(last, 1u));
    var p = middle_point(a, b, bends, t, i);
    p.color = mix(a.color, b.color, t);
    p.shown = p.shown & a.shown & b.shown;
    if i == 0u {
        p = a;
    } else if i >= last {
        p = b;
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

fn middle_point(a: PathPoint, b: PathPoint, bends: Points, t: f32, i: u32) -> PathPoint {
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
fn geometry_point(now: Points, was: Points, i: u32) -> PathPoint {
    // Like column reads, this reads both paths' points and selects (see `lib/read.wesl`).
    let w = point_bits(now, i);
    let xy = bitcast<vec2f>(w);
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

// An edge's path, read once for every point a segment takes from it: its ends, its bends, its own
// segments (`last`, without fans), its lane, whether it fans into its vertices, whether it draws,
// and its width before focus and fading, which its lane's step adds to.
struct EdgePath {
    a: PathPoint,
    b: PathPoint,
    bends: Points,
    last: u32,
    lane: Lane,
    fanned: bool,
    drawn: bool,
    width: f32,
}

fn edge_path(s: Segment, count: u32) -> EdgePath {
    let e = edge_at(row_at(s.row));
    let a = vertex_point(0u, e.a);
    let b = vertex_point(1u, e.b);
    let bends = bends_of(s.row);
    let l = lane_of(s.row);
    let fanned = fans(l);
    // Selects, not `&`: Metal writes the struct below as a brace initializer (see `segment_of` in
    // `draw/strokes.wesl`).
    let drawn = select(false, select(false, e.a != NONE, e.b != NONE), !same_vertex(e.a, e.b));
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

// Point `i` of segment `s`'s row path: through its edge path `e` for an edge, else from its row.
fn path_at(s: Segment, e: EdgePath, now: Points, was: Points, i: u32) -> PathPoint {
    if has_end_vertices() { return edge_path_point(e, i); }
    switch PATH {
        case PATH_TRACE: { return trace_point(s.row, i); }
        case PATH_GEOMETRY: { return geometry_point(now, was, i); }
        case PATH_POLES: { return pole_point(s.row, i); }
        default: { return hidden(); }
    }
}

// Points of a row's path that a segment reads (see `path_points`). Those not read stay hidden.
struct PathPoints {
    a: PathPoint,
    b: PathPoint,
    before: PathPoint,
    after: PathPoint,
}

// Points `at` of segment `s`'s row path of `count` segments, through edge path `e` for an edge:
// `a` and `b` at `at.x` and `at.y`, then `before` at `at.z` and `after` at `at.w` unless they are
// NONE. Every point is read at one call in a loop. The D3D compiler behind WebGL inlines every
// call, so a call per point would compile a path's whole geometry once for each, and a loop whose
// count it can work out it unrolls into as many copies. The count is at most one past the path's
// segments, which only the row knows, so the loop stays a loop.
fn path_points(s: Segment, count: u32, e: EdgePath, at: vec4u) -> PathPoints {
    var out: PathPoints;
    var now: Points;
    var was: Points;
    if PATH == PATH_GEOMETRY {
        now = points_of(mark.geometry, s.row);
        was = points_of(mark.frozen_geometry, s.row);
    }
    let wanted = 2u + select(0u, 1u, at.z != NONE) + select(0u, 1u, at.w != NONE);
    let n = min(wanted, count + 1u);
    for (var j = 0u; j < n; j++) {
        // In order: `a`, `b`, `before` where read, then `after`.
        let k = select(j, 3u, (j == 2u) & (at.z == NONE));
        let i = select(select(select(at.x, at.y, k == 1u), at.z, k == 2u), at.w, k == 3u);
        let p = path_at(s, e, now, was, i);
        if k == 0u { out.a = p; }
        if k == 1u { out.b = p; }
        if k == 2u { out.before = p; }
        if k == 3u { out.after = p; }
    }
    return out;
}

// Segment `s`'s two end points in position units. An edge reads its shared state once for both
// positions. A fan stays at its vertex: it turns only on screen.
fn segment_ends(s: Segment) -> PathEnds {
    if PATH == PATH_TRACE {
        let samples = trace_pair(s.row, s.index);
        return PathEnds(sample_point(samples[0]), sample_point(samples[1]));
    }
    let count = path_count(s.item);
    var e: EdgePath;
    var at = vec4u(s.index, s.index + 1u, NONE, NONE);
    if has_end_vertices() {
        e = edge_path(s, count);
        let piece = piece_of(e, s.index);
        at.x = select(piece.x, piece.x + 1u, piece.y == 2u);
        at.y = select(piece.x + 1u, piece.x, piece.y == 1u);
    }
    let points = path_points(s, count, e, at);
    return PathEnds(points.a, points.b);
}

// Segment `s`'s points: the own segment of its row's path it draws, or for a fan draws beside
// (`ends`), the points before and after that segment, each hidden where the path does not run on
// through it, and for an edge, its lane, its vertices, and its width (see `EdgePath`). Only strokes
// read the points beside a segment, to join it with its neighbors (`joined`): elsewhere they stay
// hidden, and a parallel edge's segment moves sideways by its own normal.
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
    // Whether its row's path passes through bends, which may lie on the markers of its end vertices.
    bent: bool,
}

// Segment `s`'s points, from one read of its row's path. Like every path read, it reads whatever it
// might need and hides what lies past the path.
fn segment_points(s: Segment) -> SegmentPoints {
    let count = path_count(s.item);
    var out: SegmentPoints;
    var i = s.index;
    var last = count;
    var e: EdgePath;
    if has_end_vertices() {
        e = edge_path(s, count);
        let piece = piece_of(e, s.index);
        i = piece.x;
        last = e.last;
        out.fan = piece.y;
        out.lane = e.lane;
        out.vertex_a = e.a;
        out.vertex_b = e.b;
        out.width = e.width;
        out.bent = e.bends.count > 0u;
        // A straight planar edge has one segment between its vertices. Fans reuse
        // those endpoints and turn on screen. No neighboring points need a lookup.
        if straight_planar() {
            out.ends = PathEnds(out.vertex_a, out.vertex_b);
            out.ends.a.shown = out.ends.a.shown & e.drawn;
            out.ends.b.shown = out.ends.b.shown & e.drawn;
            out.first = true;
            out.last = true;
            return out;
        }
    }
    // The points beside the segment, where the path runs on through its ends.
    let before = select(NONE, i - 1u, joins() & (i > 0u));
    let after = select(NONE, i + 2u, joins() & (i + 1u < last));
    let points = path_points(s, count, e, vec4u(i, i + 1u, before, after));
    out.ends = PathEnds(points.a, points.b);
    out.before = points.before;
    out.after = points.after;
    out.first = i == 0u;
    out.last = i + 1u >= last;
    out.before.shown = out.before.shown & !out.first;
    out.after.shown = out.after.shown & !out.last;
    return out;
}

// A monitor reads its visible sample buckets directly. It never allocates path records.
fn trace_points(s: Segment) -> SegmentPoints {
    var out: SegmentPoints;
    @if(joined) {
        let samples = trace_around(s.row, s.index);
        out.before = sample_point(samples[0]);
        out.ends = PathEnds(sample_point(samples[1]), sample_point(samples[2]));
        out.after = sample_point(samples[3]);
    }
    @if(!joined) {
        let samples = trace_pair(s.row, s.index);
        out.ends = PathEnds(sample_point(samples[0]), sample_point(samples[1]));
    }
    out.first = s.index == 0u;
    out.last = s.index + 1u >= path_count(s.item);
    out.before.shown = out.before.shown & !out.first;
    out.after.shown = out.after.shown & !out.last;
    return out;
}

// The joint at screen point `at`, between the segment from `before` and the one to `after`; z is 1
// where a point shows (see `screen_point`). Both segments meeting at a point compute it from the
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
    // Selects, not `&`: Metal writes the struct below as a brace initializer (see `segment_of` in
    // `draw/strokes.wesl`).
    let shown = min(before.z, min(at.z, after.z)) > 0.0;
    let through = select(false, select(false, all(lengths > vec2f(1e-3)), straight > 1e-3), shown);
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

// Where a path point lies: in the world, and in clip space. A trace's points lie on the plot.
struct Placed {
    world: vec3f,
    clip: vec4f,
}

fn place(p: PathPoint) -> Placed {
    if PATH == PATH_TRACE { return Placed(vec3f(0.0), plot_clip(p.hi, p.lo)); }
    let w = world(p.hi, p.lo, p.z);
    return Placed(w, clip_of(w));
}

// Point `p`, placed at clip position `c`, on screen in CSS pixels, with z 1 where it shows in front
// of the near plane, else 0. Every point projects alike, so segments meeting at a point find it at
// the same place.
fn screen_point(p: PathPoint, c: vec4f) -> vec3f {
    return vec3f(to_screen(c), select(0.0, 1.0, p.shown & (c.w > 0.0) & (c.z <= c.w)));
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

// The length in CSS pixels of the part in front of the near plane of the segment from clip position
// `ca` to `cb`, as `fit_segment` finds its `chord`. A segment list measures distances along in CSS
// pixels with it.
fn screen_length(ca: vec4f, cb: vec4f) -> f32 {
    var cut = vec2f(0.0, 1.0);
    if (ca.z > ca.w) | (cb.z > cb.w) {
        cut = in_front(ca, cb);
    }
    let a = to_screen(mix(ca, cb, cut.x));
    let b = to_screen(mix(ca, cb, cut.y));
    return select(0.0, length(b - a), cut.x < cut.y);
}

// Segment `s` on screen (see `OnScreen`).
fn trace_screen(s: Segment) -> OnScreen {
    let p = trace_points(s);
    return fit_segment(p, project_segment(p));
}

// Clip coordinates of the visible endpoints and screen positions needed to join or offset them.
struct ProjectedSegment {
    ca: vec4f,
    cb: vec4f,
    before: vec3f,
    after: vec3f,
    vertices: vec4f,
    cut: vec2f,
    shown: bool,
}

fn project_segment(p: SegmentPoints) -> ProjectedSegment {
    var out: ProjectedSegment;
    if !p.ends.a.shown | !p.ends.b.shown { return out; }
    // The points the segment projects, each placed at one call in a loop, as `path_points` reads
    // them: its ends, then where a stroke joins its neighbors (`joined`) the points beside them,
    // then where a parallel edge runs beside a longer path its vertices' centers. A path of one
    // segment joins nothing and runs between its ends.
    let single = straight_planar() | (p.first & p.last);
    let neighbors = joins() & !single;
    let centers = has_end_vertices() & ((p.lane.offset != 0.0) | p.bent) & !single;
    let n = 2u + select(0u, 2u, neighbors) + select(0u, 2u, centers);
    var wa = vec3f(0.0);
    var wb = vec3f(0.0);
    var ca = vec4f(0.0);
    var cb = vec4f(0.0);
    var before = vec3f(0.0);
    var after = vec3f(0.0);
    var vertex_a = vec3f(0.0);
    var vertex_b = vec3f(0.0);
    for (var j = 0u; j < n; j++) {
        // 0 and 1: the ends; 2 and 3: the points beside them; 4 and 5: the vertices.
        let k = select(j, j + 2u, (j >= 2u) & !neighbors);
        var q = p.ends.a;
        if k == 1u { q = p.ends.b; }
        if k == 2u { q = p.before; }
        if k == 3u { q = p.after; }
        if k == 4u { q = p.vertex_a; }
        if k == 5u { q = p.vertex_b; }
        let at = place(q);
        let on = screen_point(q, at.clip);
        if k == 0u {
            wa = at.world;
            ca = at.clip;
        }
        if k == 1u {
            wb = at.world;
            cb = at.clip;
        }
        if k == 2u { before = on; }
        if k == 3u { after = on; }
        if k == 4u { vertex_a = on; }
        if k == 5u { vertex_b = on; }
    }
    var cut = vec2f(0.0, 1.0);
    out.ca = ca;
    out.cb = cb;
    if PATH == PATH_TRACE {
        out.shown = true;
    } else {
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
    out.before = before;
    out.after = after;
    out.vertices = vec4f(vertex_a.xy, vertex_b.xy);
    out.cut = cut;
    return out;
}

// Clip marker outlines and fit parallel lanes in screen space. This stage reads no path data.
fn fit_segment(p: SegmentPoints, projected: ProjectedSegment) -> OnScreen {
    var out: OnScreen;
    out.ends = p.ends;
    out.fan = p.fan;
    out.shown = projected.shown;
    if !out.shown { return out; }
    out.ca = projected.ca;
    out.cb = projected.cb;
    let cut = projected.cut;
    var before = projected.before;
    var after = projected.after;
    let vertex_a = projected.vertices.xy;
    let vertex_b = projected.vertices.zw;
    let single = straight_planar() | (p.first & p.last);
    let centers = has_end_vertices() & ((p.lane.offset != 0.0) | p.bent) & !single;
    // The own segment on screen, and its joints. An end cut at the near plane joins nothing.
    let center_a = to_screen(out.ca);
    let center_b = to_screen(out.cb);
    out.chord = length(center_b - center_a);
    var sa = center_a;
    var sb = center_b;
    // The part of the segment between its points that the drawn piece stands for, as fractions of
    // it. Where an edge fans, its fans stand for the first and last `reach` of its path, and the
    // path between them for the rest, so distances along run on through the fans.
    var span = vec2f(0.0, 1.0);
    if MEET {
        // Each end lies on its vertex's marker, at the point nearest the path's next point. A path
        // of one segment joins the nearest points of its two markers. Two boxes meet where they
        // face: along an axis they overlap on, at the middle of the overlap. A box meets a round
        // marker at its point nearest that marker's center, and a round marker aims at where the
        // other is met, or at another round marker's center. The points beside the segment move
        // the same way, so both segments that share a first or last bend compute its joint from
        // the same points. An end cut at the near plane has no vertex to meet.
        let half_a = select(vec2f(p.ends.a.half.x), p.ends.a.half, p.ends.a.boxed);
        let half_b = select(vec2f(p.ends.b.half.x), p.ends.b.half, p.ends.b.boxed);
        let facing = 0.5 * (max(center_a - half_a, center_b - half_b) + min(center_a + half_a, center_b + half_b));
        let boxes = p.ends.a.boxed & p.ends.b.boxed;
        let aim_a = select(center_b, facing, boxes);
        let aim_b = select(center_a, facing, boxes);
        let box_a = center_a + clamp(aim_a - center_a, -half_a, half_a);
        let box_b = center_b + clamp(aim_b - center_b, -half_b, half_b);
        let toward_a = select(center_a, box_a, p.ends.a.boxed);
        let toward_b = select(center_b, box_b, p.ends.b.boxed);
        let next_a = select(center_b, select(toward_b, aim_a, p.ends.a.boxed), single);
        let next_b = select(center_a, select(toward_a, aim_b, p.ends.b.boxed), single);
        let met_a = meet_marker(p.ends.a, center_a, next_a);
        let met_b = meet_marker(p.ends.b, center_b, next_b);
        before = vec3f(meet_marker(p.before, before.xy, center_a), before.z);
        after = vec3f(meet_marker(p.after, after.xy, center_b), after.z);
        sa = select(center_a, met_a, p.first & (cut.x == 0.0));
        sb = select(center_b, met_b, p.last & (cut.y == 1.0));
        // The piece stands for as much of its segment as it is long, at the end that is no vertex,
        // so dashes and comets keep their size and run on through the bend.
        let met = length(sb - sa) / max(out.chord, 1e-6);
        let both = vec2f(0.5 - 0.5 * met, 0.5 + 0.5 * met);
        let one = select(vec2f(0.0, met), vec2f(1.0 - met, 1.0), p.first);
        span = select(span, select(one, both, single), p.first | p.last);
    }
    let front = vec2f(select(0.0, 1.0, cut.x == 0.0), select(0.0, 1.0, cut.y == 1.0));
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
            let step = lane_step(p, select(center_a, vertex_a.xy, centers), select(center_b, vertex_b.xy, centers));
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
            let r = reach / max(out.chord, 1e-6);
            let into = sa + beside(dir) * o + dir * reach;
            let out_of = sb + beside(dir) * o - dir * reach;
            let fan_start = joint(vec3f(sa, front.x), vec3f(into, front.x * front.y), vec3f(into + dir * reach, front.y));
            let fan_end = joint(vec3f(out_of - dir * reach, front.x), vec3f(out_of, front.x * front.y), vec3f(sb, front.y));
            if p.first {
                a = into;
                start = fan_start;
                span.x = r;
            }
            if p.last {
                b = out_of;
                end = fan_end;
                span.y = 1.0 - r;
            }
            if p.fan == 1u {
                a = sa;
                b = into;
                end = fan_start;
                start.through = false;
                span = vec2f(0.0, r);
            }
            if p.fan == 2u {
                a = out_of;
                b = sb;
                start = fan_end;
                end.through = false;
                span = vec2f(1.0 - r, 1.0);
            }
            at_from = p.fan == 1u;
            at_to = p.fan == 2u;
        }
    }
    // Strokes stop at the markers of their end vertices, and each end gives up at most half the
    // length. An end cut at the near plane has no vertex to stop at. `drawn` is what is left, as
    // fractions of the piece.
    var drawn = vec2f(0.0, 1.0);
    if clips_outlines() {
        let along = b - a;
        let length_along = length(along);
        if length_along > 1e-3 {
            let u = along / length_along;
            let room = 0.5 * length_along;
            // On a path through bends, a segment that is not the first may still start on the first
            // vertex's marker, where a bend lies on it, and one that is not the last may end on the
            // last's. Each stops at that marker too, and one that lies wholly on it draws nothing.
            let inner = p.bent & !single;
            let stops = vec2f(
                select(0.0, exit_marker(p.ends.a, center_a, a, u), at_from & (cut.x == 0.0)),
                select(0.0, exit_marker(p.ends.b, center_b, b, -u), at_to & (cut.y == 1.0)),
            ) + vec2f(
                select(0.0, exit_marker(p.vertex_a, vertex_a.xy, a, u), inner & !at_from & (cut.x == 0.0)),
                select(0.0, exit_marker(p.vertex_b, vertex_b.xy, b, -u), inner & !at_to & (cut.y == 1.0)),
            );
            out.shown = out.shown & !(inner & any(stops >= vec2f(length_along)));
            out.stops = stops > vec2f(0.0);
            let short = min(stops, vec2f(room));
            a += u * short.x;
            b -= u * short.y;
            drawn = vec2f(short.x, length_along - short.y) / length_along;
        }
    }
    // What is drawn, within what the piece stands for, within what lies in front of the near plane.
    out.visible = mix(vec2f(span.x), vec2f(span.y), drawn);
    out.kept = mix(vec2f(cut.x), vec2f(cut.y), out.visible);
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
