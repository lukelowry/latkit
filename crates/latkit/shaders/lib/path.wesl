// Paths: the segments a stroke draws, whatever mark it belongs to. A row's path runs between an
// edge's ends (through its bends or route, or along the great circle on the earth), from each of a
// net's terminals to its junction, through a line's samples across the axis, or through points the
// view wrote. Draws, casts, probes, bounds, and labels all read a segment through `segment_ends` and
// `segment_screen`. Which path a pipeline reads is its `PATH`, so each compiles one kind of path.

import package::lib::types::{
    NONE, MISSING, VISIBLE, PINNED, PLACED, DASH, ENDS_COLOR, GEODESIC, STEP_BEFORE, STEP_AFTER,
    MARK_EDGES, PATH_ENDS, PATH_TRACE, PATH_GEOMETRY, PATH_NET, EDGE_WIDTH, LINE_WIDTH, VERTEX_WORDS,
    VERTEX_HALF, TERMINAL_WORDS, GEODESIC_STEP, OWN_HEIGHT,
};
import package::lib::bind::{eye, frame, mark, program};
import package::lib::state::{row_at, edge_at, line_at, vertex_at, vertex_slot, resolved, Vertex};
import package::lib::project::{world, clip_of, facing, to_screen};
import package::lib::read::missing_bits;
import package::lib::trace::{
    trace_first, trace_axis, trace_value, trace_level, trace_bucket_first, trace_buckets, trace_bucket,
};
import package::lib::focus::faded;
import package::lib::mark::px;
import package::lib::points::{port_place, vertex_half};
import package::lib::lists::{lists, list_entry, list_start, list_total};

// The path a pipeline's strokes read: one of the `PATH_` codes, fixed when the pipeline is made.
override PATH: u32 = PATH_ENDS;

// One segment of a row's path.
struct Segment {
    row: u32,
    index: u32,
}

// A point a path runs through: where it stands (position units as high and low parts, elevation),
// in world units and in position units, its color, CSS pixels it sits from there on screen (a port's
// place on its vertex), and whether it is shown. Sources set where it stands; `path_point` places
// it in the world once.
struct PathPoint {
    hi: vec2f,
    lo: vec2f,
    z: f32,
    world: vec3f,
    position: vec3f,
    color: vec4f,
    offset: vec2f,
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

// Points written for row `row` beside the program: where they start, and how many.
fn written(row: u32) -> vec2u {
    if mark.paths == NONE || row >= mark.rows {
        return vec2u(0u);
    }
    let start = program[mark.paths + row];
    return vec2u(start, program[mark.paths + row + 1u] - start);
}

// Written point `i`: x and y.
fn written_point(i: u32) -> vec2u {
    let at = mark.paths + mark.rows + 1u + 2u * i;
    return vec2u(program[at], program[at + 1u]);
}

// Row `row`'s net terminals: where they start, and how many.
fn terminals(row: u32) -> vec2u {
    if mark.terminals == NONE || row >= mark.rows {
        return vec2u(0u);
    }
    let start = program[mark.terminals + row];
    return vec2u(start, program[mark.terminals + row + 1u] - start);
}

// Segments a geodesic from `a` to `b` takes: one per few degrees of arc.
fn arcs(a: vec2f, b: vec2f) -> u32 {
    let p = radians(a);
    let q = radians(b);
    let d = 2.0 * asin(min(1.0, sqrt(pow(sin(0.5 * (q.y - p.y)), 2.0) + cos(p.y) * cos(q.y) * pow(sin(0.5 * (q.x - p.x)), 2.0))));
    return clamp(u32(ceil(degrees(d) / GEODESIC_STEP)), 1u, 64u);
}

// Segments row `row`'s path has: the count a list over the mark's rows counts.
fn row_segments(row: u32) -> u32 {
    switch PATH {
        case PATH_ENDS: {
            let middle = written(row).y;
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
        case PATH_NET: {
            let k = terminals(row).y;
            return select(select(0u, 1u, k == 2u), k, k > 2u);
        }
        case PATH_GEOMETRY: {
            return max(written(row).y, 1u) - 1u;
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
    p.shown = (v.flags & (PINNED | PLACED)) != 0u;
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

// Point `i` of an edge's path: its first end, the points written between, then its second end; or
// along the great circle between its ends. Each kind of point is made in one place, so shaders
// compile small.
fn end_point(row: u32, i: u32) -> PathPoint {
    let e = edge_at(row_at(row));
    if e.a == NONE || e.b == NONE {
        return hidden();
    }
    // An edge inside one collapsed group has nowhere to run.
    let ends = vec2u(resolved(e.a), resolved(e.b));
    if ends.x == ends.y {
        return hidden();
    }
    let a = vertex_at(ends.x * VERTEX_WORDS);
    let b = vertex_at(ends.y * VERTEX_WORDS);
    let middle = written(row);
    let geodesic = middle.y == 0u && (mark.flags & GEODESIC) != 0u;
    // A great circle runs in as many arcs as its list kept for it.
    let last = select(middle.y + 1u, path_count(row), geodesic);
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
        let w = written_point(middle.x + i - 1u);
        xy = vec2f(bitcast<f32>(w.x), bitcast<f32>(w.y));
    }
    let z = select(0.0, mix(a.elevation, b.elevation, t), geodesic);
    var p = position_point(xy, z, mix(unpack4x8unorm(a.color), unpack4x8unorm(b.color), t));
    p.shown = p.shown && (a.flags & (PINNED | PLACED)) != 0u && (b.flags & (PINNED | PLACED)) != 0u;
    return p;
}

// Terminal `k` of the net row `row`: its vertex's point, at its port.
fn terminal_point(row: u32, k: u32) -> PathPoint {
    let t = mark.terminals + mark.rows + 1u + TERMINAL_WORDS * (terminals(row).x + k);
    let first = program[mark.ends + program[t]];
    if first == NONE {
        return hidden();
    }
    let v = vertex_slot(first + program[t + 1u]);
    var p = vertex_point(v);
    p.offset = port_place(vertex_half(v), program[t + 2u]);
    // A port is on the outline already.
    p.half = vec2f(0.0);
    return p;
}

// Point `i` of a net's path: segment `i / 2` runs from terminal `i / 2` to the junction; a net of
// two terminals runs between them.
fn net_point(row: u32, i: u32) -> PathPoint {
    let k = terminals(row).y;
    if k == 2u || i % 2u == 0u {
        return terminal_point(row, select(i / 2u, min(i, 1u), k == 2u));
    }
    // The junction: the middle of the terminals, in the first one's color.
    var sum = vec3f(0.0);
    var shown = true;
    var color = vec4f(1.0);
    for (var j = 0u; j < k; j++) {
        let p = terminal_point(row, j);
        sum += vec3f(p.hi + p.lo, p.z);
        shown = shown && p.shown;
        if j == 0u {
            color = p.color;
        }
    }
    var p = position_point(sum.xy / f32(k), sum.z / f32(k), color);
    p.shown = p.shown && shown;
    return p;
}

// Point `k` of a trace: each bucket's least and greatest value at its middle, then the samples after
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

// Point `i` of points the view wrote: polylines whose parts are broken by a missing point.
fn geometry_point(row: u32, i: u32) -> PathPoint {
    let w = written_point(written(row).x + i);
    if missing_bits(w.x) || missing_bits(w.y) {
        return hidden();
    }
    return position_point(vec2f(bitcast<f32>(w.x), bitcast<f32>(w.y)), 0.0, vec4f(1.0));
}

// Point `i` of row `row`'s path, whatever it runs through, placed in the world.
fn path_point(row: u32, i: u32) -> PathPoint {
    var p = hidden();
    switch PATH {
        case PATH_ENDS: { p = end_point(row, i); }
        case PATH_TRACE: { p = trace_point(row, i); }
        case PATH_GEOMETRY: { p = geometry_point(row, i); }
        case PATH_NET: { p = net_point(row, i); }
        default: {}
    }
    return placed_point(p);
}

// The two points segment `s` runs between: points `index` and `index + 1` of its row's path, or of
// a net's, `2 index` and `2 index + 1`. One loop makes both, so the path is compiled once.
fn segment_ends(s: Segment) -> array<PathPoint, 2> {
    let first = select(s.index, 2u * s.index, PATH == PATH_NET);
    var ends: array<PathPoint, 2>;
    for (var e = 0u; e < 2u; e++) {
        ends[e] = path_point(s.row, first + e);
    }
    return ends;
}

// Lanes from the middle that row `row` runs in among strokes joining the same two vertices.
fn lane(row: u32) -> f32 {
    if mark.lanes == NONE || row >= mark.rows {
        return 0.0;
    }
    return bitcast<f32>(program[mark.lanes + row]);
}

// Segment `s` on screen, its ends moved to their ports and spread into the row's lane.
fn segment_screen(s: Segment) -> OnScreen {
    let ends = segment_ends(s);
    var out: OnScreen;
    out.ends = ends;
    out.ca = clip_of(ends[0].world);
    out.cb = clip_of(ends[1].world);
    out.shown = ends[0].shown && ends[1].shown && out.ca.w > 0.0 && out.cb.w > 0.0;
    out.a = to_screen(out.ca) + ends[0].offset;
    out.b = to_screen(out.cb) + ends[1].offset;
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

// How row `row`'s path is stroked.
fn stroke_style(row: u32) -> Style {
    var s: Style;
    if mark.kind == MARK_EDGES {
        let e = edge_at(row_at(row));
        s.width = px(e.width, EDGE_WIDTH);
        // An edge colored by its ends takes their colors where it draws; this only fades it.
        s.color = select(unpack4x8unorm(e.color), vec4f(1.0), ends_colored());
        s.color.a *= faded(row, e.flags);
        s.flow = e.flow;
        s.dash = (e.flags & DASH) != 0u;
        s.shown = (e.flags & VISIBLE) != 0u;
    } else {
        let l = line_at(row_at(row));
        s.width = px(l.width, LINE_WIDTH);
        s.color = unpack4x8unorm(l.color);
        s.color.a *= faded(row, l.flags);
        s.flow = l.flow;
        s.dash = (l.flags & DASH) != 0u;
        s.shown = (l.flags & VISIBLE) != 0u;
    }
    return s;
}

// Whether a stroke's color blends its ends' colors.
fn ends_colored() -> bool {
    return mark.kind == MARK_EDGES && (mark.flags & ENDS_COLOR) != 0u;
}

fn segment_clip(p: PathPoint) -> vec4f {
    return clip_of(p.world);
}
