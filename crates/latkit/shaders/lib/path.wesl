// Paths: the segments a stroke draws, for any mark kind. A row's path runs between an edge's ends
// (straight, through the bends of a geometry column, or along a great circle on the earth, bowed
// into its lane), through a line's samples across the axis, or through a geometry column's points
// (a net's star, or a path field). Draws, probes, bounds, and labels all
// read segments through `segment_ends` and `segment_screen`. A pipeline's `PATH` selects one kind
// of path, so each pipeline compiles only that kind.
//
// As in `lib/read.wesl`, paths read every word they might need and select the answer, with no early
// return and no short-circuit test (`&&`, `||`) around a read: the D3D compiler behind WebGL takes
// several times longer on code that branches around reads.

import package::lib::types::{
    NONE, VISIBLE, PLACED, DASH, ENDS_COLOR, GEODESIC, MARK_EDGES, PATH_ENDS, PATH_BENDS, PATH_TRACE,
    PATH_GEOMETRY, PATH_POLES, EDGE_WIDTH, LINE_WIDTH, GEODESIC_STEP, OWN_HEIGHT, TRIANGLES, MAX_PIECES, BOW_PIECES,
    MISSING, MISSING_COLOR, FAMILY_LANES, PROJECTION_PLANAR, PROJECTION_DYNAMIC,
};
import package::lib::bind::{frame, eye, mark, focused};
import package::lib::state::{row_at, edge_at, line_at, end_vertex, same_vertex, Vertex};
import package::lib::project::{world, clip_of, plot_clip, shows, to_screen, geographic, PROJECTION};
import package::lib::read::{missing_bits, bits_value, points_of, point_bits, Points};
import package::lib::trace::{trace_sample, trace_pair};
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

// A segment on screen: its end points, its ends in CSS pixels and in clip space, whether it shows,
// and the drawn part as fractions along it. The drawn part is cut at the near plane and stops short
// of the vertices at its ends.
struct OnScreen {
    ends: PathEnds,
    a: vec2f,
    b: vec2f,
    ca: vec4f,
    cb: vec4f,
    shown: bool,
    kept: vec2f,
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

// Segments a geodesic from `a` to `b` takes: one per `GEODESIC_STEP` degrees of arc.
fn arcs(a: vec2f, b: vec2f) -> u32 {
    let p = radians(a);
    let q = radians(b);
    let d = 2.0 * asin(min(1.0, sqrt(pow(sin(0.5 * (q.y - p.y)), 2.0) + cos(p.y) * cos(q.y) * pow(sin(0.5 * (q.x - p.x)), 2.0))));
    return clamp(u32(ceil(degrees(d) / GEODESIC_STEP)), 1u, MAX_PIECES);
}

// The geometry column's point count for held row `row`: an edge's bends, or a whole path. Rows that
// left have none.
fn geometry_count(row: u32) -> u32 {
    return select(points_of(mark.geometry, row).count, 0u, row >= mark.held - mark.exits);
}

// Whether a segment list keeps lane `l` of the edge from vertex `a` to vertex `b`. A family keeps
// only the lanes the screen can show apart, so a family of thousands of lanes costs only as many lanes
// as the screen resolves, in draws and probes alike. A lane whose curve lies off screen is not kept,
// except on a plane, where a list keeps a band of zooms. Where neighboring lanes lie less than a pixel
// apart, only every `step`-th lane is kept (see `lane_thinned`). A lane with an end behind the eye is
// kept, cut at the near plane. The caller has read the ends.
fn lane_drawn(a: Vertex, b: Vertex, l: Lane, planning: bool) -> bool {
    let ca = clip_of(world(a.hi, a.lo, a.elevation));
    let cb = clip_of(world(b.hi, b.lo, b.elevation));
    let banded = planning & (frame.lane_scale > 0.0);
    // The curve stays within the triangle of its ends and its control point, which lies twice as far
    // out as the curve's middle. A great circle is not tested.
    let d = (b.hi - a.hi) + (b.lo - a.lo);
    let control = a.lo + 0.5 * d + vec2f(-d.y, d.x) * 2.0 * l.offset * frame.bow;
    let cc = clip_of(world(a.hi, control, mix(a.elevation, b.elevation, 0.5)));
    let sa = to_screen(ca);
    let sb = to_screen(cb);
    let sc = to_screen(cc);
    // Room for the stroke's width past the curve.
    let margin = vec2f(64.0);
    let lo = min(min(sa, sb), sc) - margin;
    let hi = max(max(sa, sb), sc) + margin;
    let tested = !banded & ((mark.flags & GEODESIC) == 0u) & (cc.w > 0.0);
    let off = tested & (any(hi < vec2f(0.0)) | any(lo > eye.size));
    let thinned = lane_thinned(ca, cb, l, select(1.0, frame.lane_scale, banded));
    return (ca.w <= 0.0) | (cb.w <= 0.0) | (!off & !thinned);
}

// Whether lane `l`, between ends at clip positions `ca` and `cb`, is left out where neighboring
// lanes lie less than a pixel apart: only every `step`-th lane draws, `step` a power of two, so drawn
// lanes are at least a pixel apart. `scale` is the zoom a planned band of zooms measures at, as a
// factor of the current one. An end behind the eye leaves nothing out.
fn lane_thinned(ca: vec4f, cb: vec4f, l: Lane, scale: f32) -> bool {
    // Pixels between neighboring lanes at their middle.
    let apart = distance(to_screen(ca), to_screen(cb)) * abs(frame.bow) * l.step * scale;
    let step = max(u32(exp2(ceil(log2(1.0 / max(apart, 1e-6))))), 1u);
    return (ca.w > 0.0) & (cb.w > 0.0) & (apart < 1.0) & (l.index % step != 0u);
}

// The segment count of held row `row`'s path, or an area's triangle count, as a segment list counts
// them. A path between two ends without bends takes one segment, or `BOW_PIECES` when bowed into a
// lane, and none when its lane is not drawn (`lane_drawn`). On a great circle it takes one segment
// per `GEODESIC_STEP` degrees of arc instead, when that is more (up to `MAX_PIECES`).
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
    let l = lane_of(row);
    if PATH == PATH_BENDS {
        let middle = geometry_count(row);
        if middle > 0u { return middle + 1u; }
    }
    if l.offset != 0.0 {
        if !lane_drawn(a, b, l, true) { return 0u; }
    }
    let pieces = select(1u, BOW_PIECES, l.offset != 0.0);
    if PROJECTION == PROJECTION_PLANAR { return pieces; }
    if PROJECTION == PROJECTION_DYNAMIC {
        if !geographic() { return pieces; }
    }
    if (mark.flags & GEODESIC) == 0u { return pieces; }
    return select(0u, max(pieces, arcs(a.hi + a.lo, b.hi + b.lo)), (e.a != NONE) & (e.b != NONE));
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

// CSS pixels from a vertex's center to its outline along `dir`, for a box or a circle.
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

// The point a fraction `t` along the great circle from `a` to `b` (in degrees), offset to the left
// by `bow` times the arc's length.
fn along_circle(a: vec2f, b: vec2f, t: f32, bow: f32) -> vec2f {
    let p = radians(a);
    let q = radians(b);
    let u = vec3f(cos(p.y) * cos(p.x), cos(p.y) * sin(p.x), sin(p.y));
    let v = vec3f(cos(q.y) * cos(q.x), cos(q.y) * sin(q.x), sin(q.y));
    // The arc's angle from its chord, which stays precise for the shortest arcs.
    let angle = 2.0 * asin(min(1.0, 0.5 * length(v - u)));
    var w = mix(u, v, t);
    if angle > 1e-5 {
        w = (sin((1.0 - t) * angle) * u + sin(t * angle) * v) / sin(angle);
        w = normalize(w + normalize(cross(u, v)) * bow * angle);
    }
    var lon = degrees(atan2(w.y, w.x));
    // Keep the longitude on the side `a` is on, so the path does not jump across the antimeridian.
    lon += 360.0 * round((a.x - lon) / 360.0);
    return vec2f(lon, degrees(asin(clamp(w.z, -1.0, 1.0))));
}

// The point a fraction `t` from vertex `a` to `b`, offset to the left by `bow` times their
// distance. A `GEODESIC` mark follows the great circle. Otherwise the point is offset from `a`'s
// high and low parts along a straight line, which keeps their precision.
fn between(a: Vertex, b: Vertex, t: f32, bow: f32) -> PathPoint {
    var p: PathPoint;
    p.z = mix(a.elevation, b.elevation, t);
    if PROJECTION != PROJECTION_PLANAR {
        if geographic() {
            if (mark.flags & GEODESIC) != 0u {
                p.hi = along_circle(a.hi + a.lo, b.hi + b.lo, t, bow);
                return p;
            }
        }
    }
    let d = (b.hi - a.hi) + (b.lo - a.lo);
    p.hi = a.hi;
    p.lo = a.lo + d * t + vec2f(-d.y, d.x) * bow;
    return p;
}

// Point `i` of an edge's path: its first end, its bends, then its second end. Without
// bends, it runs between its ends in `count` segments, and a lane bows in world space, so its curve
// stays fixed as the camera moves. An end reads only its own vertex. Each kind of point is built in
// one place, which keeps compiled shaders small.
fn end_point(row: u32, count: u32, i: u32) -> PathPoint {
    let e = edge_at(row_at(row));
    let a = end_vertex(0u, e.a);
    let b = end_vertex(1u, e.b);
    let bends = bends_of(row);
    let last = select(bends.count + 1u, count, bends.count == 0u);
    var p = edge_point(a, b, bends, last, lane(row) * frame.bow, i);
    p.shown = p.shown & (e.a != NONE) & (e.b != NONE) & !same_vertex(e.a, e.b);
    return p;
}

// Shared endpoint state is read once for a segment, including when both points lie on its curve.
fn edge_point(a: Vertex, b: Vertex, bends: Points, last: u32, bow: f32, i: u32) -> PathPoint {
    let t = f32(i) / f32(max(last, 1u));
    var p = middle_point(a, b, bends, t, bow, i);
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
// retain great circles and lane bows through the same interpolation helper.
fn bends_of(row: u32) -> Points {
    if PATH == PATH_BENDS { return points_of(mark.geometry, row); }
    var empty: Points;
    return empty;
}

fn middle_point(a: Vertex, b: Vertex, bends: Points, t: f32, bow: f32, i: u32) -> PathPoint {
    var p = between(a, b, t, bow * 4.0 * t * (1.0 - t));
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

// Segment `s`'s two end points. An edge reads its shared state once for both positions.
fn segment_ends(s: Segment) -> PathEnds {
    if PATH == PATH_TRACE {
        let samples = trace_pair(s.row, s.index);
        return PathEnds(sample_point(samples[0]), sample_point(samples[1]));
    }
    let count = path_count(s.item);
    if has_end_vertices() {
        let e = edge_at(row_at(s.row));
        let a = end_vertex(0u, e.a);
        let b = end_vertex(1u, e.b);
        let bends = bends_of(s.row);
        let l = lane_of(s.row);
        let last = select(bends.count + 1u, count, bends.count == 0u);
        var drawn = (e.a != NONE) & (e.b != NONE) & !same_vertex(e.a, e.b);
        // On a plane a list keeps the lanes a band of zooms draws, so at the current zoom some lie
        // less than a pixel apart. Geographic lists keep exactly the lanes they draw. A kept lane off
        // screen needs no test: its quads lie off screen.
        if !geographic() {
            if (bends.count == 0u) & (frame.lane_scale > 0.0) & (l.offset != 0.0) {
                let ca = clip_of(world(a.hi, a.lo, a.elevation));
                let cb = clip_of(world(b.hi, b.lo, b.elevation));
                drawn = drawn & !lane_thinned(ca, cb, l, 1.0);
            }
        }
        let bow = l.offset * frame.bow;
        var ends = PathEnds(edge_point(a, b, bends, last, bow, s.index), edge_point(a, b, bends, last, bow, s.index + 1u));
        ends.a.shown = ends.a.shown & drawn;
        ends.b.shown = ends.b.shown & drawn;
        return ends;
    }
    return PathEnds(path_point(s.row, count, s.index), path_point(s.row, count, s.index + 1u));
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

// A row's lane in its family (the edges joining the same two vertices): its offset from the middle
// in lanes of the theme's bow, its index in the family counted from one side, and the step between
// lanes. A family spreads at most `FAMILY_LANES` lanes wide, so a larger family packs its lanes
// closer, `step` apart.
struct Lane {
    offset: f32,
    index: u32,
    step: f32,
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
    );
}

fn lane(row: u32) -> f32 {
    return lane_of(row).offset;
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

// Segment `s` on screen: the part in front of the near plane, with `kept` giving the drawn part.
fn segment_screen(s: Segment) -> OnScreen {
    let ends = segment_ends(s);
    var out: OnScreen;
    out.ends = ends;
    if !ends.a.shown | !ends.b.shown { return out; }
    if PATH == PATH_TRACE {
        out.ca = plot_clip(ends.a.hi, ends.a.lo);
        out.cb = plot_clip(ends.b.hi, ends.b.lo);
        out.a = to_screen(out.ca);
        out.b = to_screen(out.cb);
        out.kept = vec2f(0.0, 1.0);
        out.shown = true;
        return out;
    }
    let wa = world(ends.a.hi, ends.a.lo, ends.a.z);
    let wb = world(ends.b.hi, ends.b.lo, ends.b.z);
    let ca = clip_of(wa);
    let cb = clip_of(wb);
    var cut = vec2f(0.0, 1.0);
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
    let ahead = shows(wa) | shows(wb);
    out.shown = ahead & (cut.x < cut.y);
    out.a = to_screen(out.ca);
    out.b = to_screen(out.cb);
    out.kept = cut;
    // Strokes stop at the outlines of their end vertices, and each end gives up at most half the
    // length. An end cut at the near plane has no vertex to stop at.
    let along = out.b - out.a;
    let length_along = length(along);
    if clips_outlines() {
        if length_along > 1e-3 {
            let dir = along / length_along;
            let room = 0.5 * length_along;
            let outlines = vec2f(select(outline(ends.a, dir), 0.0, cut.x > 0.0), select(outline(ends.b, dir), 0.0, cut.y < 1.0));
            let short = min(outlines, vec2f(room));
            out.a += dir * short.x;
            out.b -= dir * short.y;
            out.kept = mix(vec2f(cut.x), vec2f(cut.y), vec2f(short.x, length_along - short.y) / length_along);
        }
    }
    return out;
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

fn edge_style(row: u32) -> Style {
    var s: Style;
    let e = edge_at(row_at(row));
    s.width = clamp(px(e.width, EDGE_WIDTH), mark.size_min, mark.size_max) * growth(e.flags);
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
