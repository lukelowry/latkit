// Paths: the segments a stroke draws, for any mark kind. A row's path runs between an edge's ends
// (straight, through the bends of a geometry column, or along a great circle on the earth, bowed
// into its lane), through a line's samples across the axis, or through a geometry column's points
// (a route computed for a diagram's sheet, or a path field). Draws, probes, bounds, and labels all
// read segments through `segment_ends` and `segment_screen`. A pipeline's `PATH` selects one kind
// of path, so each pipeline compiles only that kind.

import package::lib::types::{
    NONE, VISIBLE, PLACED, DASH, ENDS_COLOR, GEODESIC, STEP_BEFORE, STEP_AFTER, MARK_EDGES, PATH_ENDS, PATH_TRACE,
    PATH_GEOMETRY, PATH_POLES, EDGE_WIDTH, LINE_WIDTH, GEODESIC_STEP, OWN_HEIGHT, TRIANGLES, MAX_PIECES, BOW_PIECES,
    MISSING, MISSING_COLOR, FAMILY_LANES,
};
import package::lib::bind::{frame, eye, mark, focused};
import package::lib::state::{row_at, edge_at, line_at, end_vertex, same_vertex, Vertex};
import package::lib::project::{world, clip_of, shows, to_screen};
import package::lib::read::{missing_bits, column_value, points_of, point_bits};
import package::lib::trace::{trace_run, trace_level, trace_axis, trace_entry};
import package::lib::focus::{faded, growth};
import package::lib::mark::{px, px_per_length};
import package::lib::points::vertex_half;
import package::lib::lists::{lists, list_entry, list_start, list_total};
import package::lib::drawn::drawn_row;

// The path kind a pipeline's strokes read, one of the `PATH_` codes, fixed when the pipeline is
// created.
override PATH: u32 = PATH_ENDS;

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

// A point on a path. Its source sets its position as high and low parts plus elevation, and
// `placed_point` sets the same point in world and position units. It also has a color and whether
// it shows.
struct PathPoint {
    hi: vec2f,
    lo: vec2f,
    z: f32,
    world: vec3f,
    position: vec3f,
    color: vec4f,
    // For a vertex, its half size in CSS pixels and whether it is a box (has its own height). Zero
    // elsewhere.
    half: vec2f,
    boxed: bool,
    // Whether it has a position, and whether it lies in front of the globe's horizon.
    shown: bool,
    ahead: bool,
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
    ends: array<PathPoint, 2>,
    a: vec2f,
    b: vec2f,
    ca: vec4f,
    cb: vec4f,
    shown: bool,
    kept: vec2f,
}

// The segment drawn as instance `instance`. Rows have a fixed number of segments, or the mark's
// list numbers them, with each entry holding a segment's drawn row and distance along.
@if(!focused)
fn segment(instance: u32) -> Segment {
    if mark.per_row != NONE {
        let per = max(mark.per_row, 1u);
        return path_segment(instance / per, instance % per, 0.0);
    }
    let entry = list_entry(mark.list, 2u * instance);
    let item = lists[entry];
    return path_segment(item, instance - list_start(mark.list, item), bitcast<f32>(lists[entry + 1u]));
}

// In the focus draw: segment `instance % mark.pieces` of lit row `instance / mark.pieces`, with its
// distance along from the list. Segments past the row's last draw nothing.
@if(focused)
fn segment(instance: u32) -> Segment {
    let pieces = max(mark.pieces, 1u);
    let item = focused[mark.focused + instance / pieces];
    let index = instance % pieces;
    var along = 0.0;
    if mark.per_row == NONE && item < mark.rows && index < path_count(item) {
        along = bitcast<f32>(lists[list_entry(mark.list, 2u * (list_start(mark.list, item) + index)) + 1u]);
    }
    return path_segment(item, index, along);
}

// Distance between two path points in position units, which a segment adds to the distance along.
fn path_length(a: PathPoint, b: PathPoint) -> f32 {
    return length(b.position.xy - a.position.xy);
}

// Segments across all drawn rows' paths.
fn stroke_instances() -> u32 {
    if mark.per_row != NONE {
        return mark.rows * mark.per_row;
    }
    return list_total(mark.list);
}

// Segments in drawn row `item`'s path.
fn path_count(item: u32) -> u32 {
    if mark.per_row != NONE {
        return mark.per_row;
    }
    return list_start(mark.list, item + 1u) - list_start(mark.list, item);
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
    if row >= mark.held - mark.exits {
        return 0u;
    }
    return points_of(mark.geometry, row).count;
}

// Whether lane `l` of edge row `row` draws. A family draws only the lanes the screen can show
// apart, so a family of thousands of lanes costs only as many lanes as the screen resolves, in
// draws and probes alike. A lane whose curve lies off screen draws nothing. Where neighboring lanes
// lie less than a pixel apart, only every `step`-th lane draws, `step` a power of two, so drawn
// lanes are at least a pixel apart.
fn lane_drawn(row: u32, l: Lane) -> bool {
    let e = edge_at(row_at(row));
    let a = end_vertex(0u, e.a);
    let b = end_vertex(1u, e.b);
    let ca = clip_of(world(a.hi, a.lo, a.elevation));
    let cb = clip_of(world(b.hi, b.lo, b.elevation));
    if ca.w <= 0.0 || cb.w <= 0.0 {
        return true;
    }
    let sa = to_screen(ca);
    let sb = to_screen(cb);
    if (mark.flags & GEODESIC) == 0u {
        // The curve stays within the triangle of its ends and its control point, which lies twice
        // as far out as the curve's middle.
        let c = between(a, b, 0.5, 2.0 * l.offset * frame.bow);
        let cc = clip_of(world(c.hi, c.lo, c.z));
        if cc.w > 0.0 {
            let sc = to_screen(cc);
            // Room for the stroke's width past the curve.
            let margin = vec2f(64.0);
            let lo = min(min(sa, sb), sc) - margin;
            let hi = max(max(sa, sb), sc) + margin;
            if any(hi < vec2f(0.0)) || any(lo > eye.size) {
                return false;
            }
        }
    }
    // Pixels between neighboring lanes at their middle.
    let apart = distance(sa, sb) * abs(frame.bow) * l.step;
    if !(apart < 1.0) {
        return true;
    }
    let step = u32(exp2(ceil(log2(1.0 / max(apart, 1e-6)))));
    return l.index % step == 0u;
}

// The segment count of held row `row`'s path, or an area's triangle count, as a segment list counts
// them. A path between two ends without bends takes one segment, or `BOW_PIECES` when bowed into a
// lane, and none when its lane is not drawn (`lane_drawn`). On a great circle it takes one segment
// per `GEODESIC_STEP` degrees of arc instead, when that is more (up to `MAX_PIECES`).
fn row_segments(row: u32) -> u32 {
    switch PATH {
        case PATH_ENDS: {
            let middle = geometry_count(row);
            if middle > 0u {
                return middle + 1u;
            }
            let l = lane_of(row);
            if l.offset != 0.0 && !lane_drawn(row, l) {
                return 0u;
            }
            let pieces = select(1u, BOW_PIECES, l.offset != 0.0);
            if (mark.flags & GEODESIC) == 0u {
                return pieces;
            }
            let e = edge_at(row_at(row));
            if e.a == NONE || e.b == NONE {
                return 0u;
            }
            let a = end_vertex(0u, e.a);
            let b = end_vertex(1u, e.b);
            return max(pieces, arcs(a.hi + a.lo, b.hi + b.lo));
        }
        case PATH_GEOMETRY: {
            let count = geometry_count(row);
            if mark.primitive == TRIANGLES {
                // An area's points start with its label anchor, then three per triangle.
                return select(0u, (count - 1u) / 3u, count > 0u);
            }
            return max(count, 1u) - 1u;
        }
        default: {
            return mark.per_row;
        }
    }
}

// Vertex `held` of end `end` as a placed path point.
fn vertex_point(end: u32, held: u32) -> PathPoint {
    let v = end_vertex(end, held);
    var p: PathPoint;
    p.hi = v.hi;
    p.lo = v.lo;
    p.z = v.elevation;
    p.color = unpack4x8unorm(v.color);
    p.half = vertex_half(v);
    p.boxed = (v.flags & OWN_HEIGHT) != 0u;
    p.shown = (v.flags & PLACED) != 0u;
    return placed_point(p);
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

// `p` with `world`, `position`, and `ahead` computed.
fn placed_point(p: PathPoint) -> PathPoint {
    var out = p;
    out.world = world(p.hi, p.lo, p.z);
    out.position = vec3f(p.hi + p.lo, p.z);
    out.ahead = shows(out.world);
    return out;
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
    if (mark.flags & GEODESIC) != 0u {
        p.hi = along_circle(a.hi + a.lo, b.hi + b.lo, t, bow);
        return p;
    }
    let d = (b.hi - a.hi) + (b.lo - a.lo);
    p.hi = a.hi;
    p.lo = a.lo + d * t + vec2f(-d.y, d.x) * bow;
    return p;
}

// Point `i` of an edge's path, placed: its first end, its bends, then its second end. Without
// bends, it runs between its ends in `count` segments, and a lane bows in world space, so its curve
// stays fixed as the camera moves. An end reads only its own vertex. Each kind of point is built in
// one place, which keeps compiled shaders small.
fn end_point(row: u32, count: u32, i: u32) -> PathPoint {
    let e = edge_at(row_at(row));
    if e.a == NONE || e.b == NONE || same_vertex(e.a, e.b) {
        return hidden();
    }
    let bends = points_of(mark.geometry, row);
    let last = select(bends.count + 1u, count, bends.count == 0u);
    if i == 0u || i >= last {
        return vertex_point(select(1u, 0u, i == 0u), select(e.b, e.a, i == 0u));
    }
    let a = end_vertex(0u, e.a);
    let b = end_vertex(1u, e.b);
    let t = f32(i) / f32(last);
    var p: PathPoint;
    if bends.count == 0u {
        p = between(a, b, t, lane(row) * frame.bow * 4.0 * t * (1.0 - t));
    } else {
        let w = point_bits(bends, i - 1u);
        if missing_bits(w.x) || missing_bits(w.y) {
            return hidden();
        }
        p.hi = vec2f(bitcast<f32>(w.x), bitcast<f32>(w.y));
    }
    p.color = mix(unpack4x8unorm(a.color), unpack4x8unorm(b.color), t);
    p.shown = (a.flags & PLACED) != 0u && (b.flags & PLACED) != 0u;
    return placed_point(p);
}

// Point `k` of a trace. In a run of buckets, each bucket gives its least and greatest value at its
// middle. In a run of frames, each frame gives its value, plus the corners between frames when the
// mark steps. A point past its run's last breaks the line before the next run.
fn trace_point(row: u32, k: u32) -> PathPoint {
    let run = trace_run(k);
    let local = k - run.point;
    var value = 0u;
    var entry = 0u;
    if trace_level(run.slot) > 0u {
        if local >= 2u * run.entries {
            return hidden();
        }
        entry = run.first + local / 2u;
        value = trace_entry(row, run.slot, entry, local % 2u);
    } else {
        var across = local;
        var up = local;
        var count = run.entries;
        if (mark.flags & STEP_AFTER) != 0u {
            across = (local + 1u) / 2u;
            up = local / 2u;
            count = 2u * run.entries - 1u;
        } else if (mark.flags & STEP_BEFORE) != 0u {
            across = local / 2u;
            up = (local + 1u) / 2u;
            count = 2u * run.entries - 1u;
        }
        if local >= count {
            return hidden();
        }
        entry = run.first + across;
        value = trace_entry(row, run.slot, run.first + up, 0u);
    }
    if missing_bits(value) {
        return hidden();
    }
    let x = trace_axis(run.slot, entry);
    var p: PathPoint;
    p.hi = vec2f(x.x, bitcast<f32>(value));
    p.lo = vec2f(x.y, 0.0);
    p.color = vec4f(1.0);
    p.shown = true;
    return p;
}

// Point `i` of a geometry column's path: polylines whose parts are separated by missing points.
// During a transition, each point moves from the path at the transition's start: from the same
// point when both paths have the same count, else from the old point at the same fraction along.
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
        p = placed_point(p);
    }
    return p;
}

// Point `i` of held row `row`'s path of `count` segments, for any path kind, placed in the world.
fn path_point(row: u32, count: u32, i: u32) -> PathPoint {
    switch PATH {
        case PATH_ENDS: { return end_point(row, count, i); }
        case PATH_TRACE: { return placed_point(trace_point(row, i)); }
        case PATH_GEOMETRY: { return placed_point(geometry_point(row, i)); }
        case PATH_POLES: { return pole_point(row, i); }
        default: { return hidden(); }
    }
}

// Segment `s`'s two end points: points `index` and `index + 1` of its row's path. One loop computes
// both, so the path code is compiled once.
fn segment_ends(s: Segment) -> array<PathPoint, 2> {
    var ends: array<PathPoint, 2>;
    for (var e = 0u; e < 2u; e++) {
        ends[e] = path_point(s.row, path_count(s.item), s.index + e);
    }
    return ends;
}

// Whether segment `s` ends a part of its row's path: the path's last segment, or one before a
// break.
fn ends_part(s: Segment) -> bool {
    if PATH == PATH_GEOMETRY {
        let points = points_of(mark.geometry, s.row);
        let next = s.index + 2u;
        return next >= points.count || missing_bits(point_bits(points, next).x);
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
    if mark.lane == NONE || row >= mark.held - mark.exits {
        return Lane(0.0, 0u, 1.0);
    }
    // The high 16 bits hold twice the lane's position from the middle, plus 32768. The low 16 bits
    // hold the family's size.
    let word = column_value(mark.lane, row).x;
    let size = word & 0xffffu;
    if word == NONE || word == MISSING || size < 2u {
        return Lane(0.0, 0u, 1.0);
    }
    let twice = i32(word >> 16u) - 32768;
    let step = min(1.0, FAMILY_LANES / f32(size));
    return Lane(0.5 * f32(twice) * step, u32((twice + i32(size) - 1) / 2), step);
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
    let ca = clip_of(ends[0].world);
    let cb = clip_of(ends[1].world);
    let cut = in_front(ca, cb);
    // A segment reaching past the globe's edge still draws. The globe's depth clips it there.
    let ahead = ends[0].ahead || ends[1].ahead;
    out.shown = ends[0].shown && ends[1].shown && ahead && cut.x < cut.y;
    out.ca = mix(ca, cb, cut.x);
    out.cb = mix(ca, cb, cut.y);
    out.a = to_screen(out.ca);
    out.b = to_screen(out.cb);
    out.kept = cut;
    // Strokes stop at the outlines of their end vertices, and each end gives up at most half the
    // length. An end cut at the near plane has no vertex to stop at.
    let along = out.b - out.a;
    let length_along = length(along);
    if length_along > 1e-3 {
        let dir = along / length_along;
        let room = 0.5 * length_along;
        let outlines = vec2f(select(outline(ends[0], dir), 0.0, cut.x > 0.0), select(outline(ends[1], dir), 0.0, cut.y < 1.0));
        let short = min(outlines, vec2f(room));
        out.a += dir * short.x;
        out.b -= dir * short.y;
        out.kept = mix(vec2f(cut.x), vec2f(cut.y), vec2f(short.x, length_along - short.y) / length_along);
    }
    return out;
}

// How row `row`'s path is stroked, never thinner than 0.75 CSS pixels. Comet flow and travel are in
// the theme's flow unit.
fn stroke_style(row: u32) -> Style {
    var s: Style;
    if mark.kind == MARK_EDGES {
        let e = edge_at(row_at(row));
        s.width = clamp(px(e.width, EDGE_WIDTH), mark.size_min, mark.size_max) * growth(e.flags);
        // An edge of a mark colored by its ends, whose color is missing, gets their colors in the
        // draw. Here it only fades.
        s.blends = ends_colored() && e.color == MISSING_COLOR;
        s.color = select(unpack4x8unorm(e.color), vec4f(1.0), s.blends);
        s.color.a *= faded(row, e.flags);
        s.flow = e.flow;
        s.travel = e.travel;
        s.dash = (e.flags & DASH) != 0u;
        s.shown = (e.flags & VISIBLE) != 0u;
    } else {
        let l = line_at(row_at(row));
        s.width = clamp(px(l.width, LINE_WIDTH), mark.size_min, mark.size_max) * growth(l.flags);
        s.color = unpack4x8unorm(l.color);
        s.color.a *= faded(row, l.flags);
        s.flow = l.flow;
        s.travel = l.travel;
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
