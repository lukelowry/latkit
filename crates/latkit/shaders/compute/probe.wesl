// Probes: what lies under a point, through the same geometry the draws use. `nearest` keeps the
// least key over every primitive instance (the distance in sixty-fourths of a pixel, then the mark
// drawn last); `topmost` keeps the last instance of that mark at that key; `describe` writes where
// the hit lies. Rows behind what the frame drew are not reached. `under` writes the nearest depth
// drawn around the point, which gestures turn and zoom about.
//
// Queries list what they find through the mark's query list: `hits` every instance within reach of
// a point, `boxed` every instance in a box, each counted and then written at its scanned place.
// `locate` writes where one row lies on screen.

import package::lib::types::{
    NONE, FADE_OUT, POINTS, STROKES, TRIANGLES, MARK_EDGES, PATH_GEOMETRY, PROBE_KEY, PROBE_INSTANCE, PROBE_DEPTH,
    PROBE_X, PROBE_Y, PROBE_UNDER, PROBE_ROW, PROBE_SEGMENT, PROBE_LOCATE_X, PROBE_LOCATE_Y, PROBE_LOCATED,
    LIST_KEPT, LIST_ITEMS,
};
import package::lib::bind::{frame, eye, mark, state};
import package::lib::state::row_at;
import package::lib::project::{to_screen, clip_of};
import package::lib::points::{point, port_at};
import package::lib::path::{PATH, Segment, segment, segment_screen, stroke_style, stroke_instances, path_count};
import package::lib::triangles::{triangle_corner, triangle_row, triangle_instances, area_anchor};
import package::lib::marker::outline_distance;
import package::lib::lists::{lists, list_counts, list_entry};

// The primitive this pipeline probes: each pipeline is made for one, so it holds only that one's
// geometry and compiles quickly.
override PROBED: u32 = 0u;

@group(2) @binding(5) var<storage, read_write> probe: array<atomic<u32>>;
@if(multisampled)
@group(2) @binding(6) var depth: texture_depth_multisampled_2d;
@else
@group(2) @binding(6) var depth: texture_depth_2d;

struct Reach {
    distance: f32,
    depth: f32,
    point: vec2f,
    row: u32,
    segment: u32,
}

fn unreached() -> Reach {
    return Reach(1e30, 0.0, vec2f(0.0), NONE, 0u);
}

// A clip position on screen, with its depth as z.
fn screen(clip: vec4f) -> vec3f {
    return vec3f(to_screen(clip), clip.z / clip.w);
}

// The nearest point of segment `a`–`b` to `p`, depth interpolated.
fn nearest_on(p: vec2f, a: vec3f, b: vec3f) -> vec3f {
    let ab = b.xy - a.xy;
    let t = clamp(dot(p - a.xy, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
    return mix(a, b, t);
}

// Whether a row is fading out: it no longer answers the pointer.
fn leaving(row: u32) -> bool {
    return (state[row_at(row) + mark.stride - 1u] & FADE_OUT) != 0u;
}

// A point's marker, or past the rows one of their ports: its segment is the port's number from 1.
fn point_reach(instance: u32, p: vec2f) -> Reach {
    let port = select(0u, instance - mark.rows, instance >= mark.rows);
    let row = select(instance, port / max(mark.ports, 1u), instance >= mark.rows);
    let pt = point(row);
    if !pt.shown || leaving(row) {
        return unreached();
    }
    let s = screen(pt.clip);
    if instance >= mark.rows {
        let k = port % max(mark.ports, 1u);
        let port = port_at(pt, k);
        return Reach(max(length(p - port.center) - port.half, 0.0), s.z, port.center, row, k + 1u);
    }
    let d = outline_distance((p - s.xy) * vec2f(1.0, -1.0), max(pt.half, vec2f(0.5)));
    return Reach(max(d, 0.0), s.z, s.xy, row, 0u);
}

fn segment_reach(instance: u32, p: vec2f) -> Reach {
    let s = segment(instance);
    if s.row >= mark.rows || leaving(s.row) {
        return unreached();
    }
    let style = stroke_style(s.row);
    let on = segment_screen(s);
    if !style.shown || !on.shown {
        return unreached();
    }
    let q = nearest_on(p, vec3f(on.a, on.ca.z / on.ca.w), vec3f(on.b, on.cb.z / on.cb.w));
    let a = on.a;
    let b = on.b;
    // The nearer end names the sample a trace's hit lies at; for an edge, which of its ends.
    var end = select(s.index, s.index + 1u, length(q.xy - b) < length(q.xy - a));
    if mark.kind == MARK_EDGES {
        end = u32(2u * end >= path_count(s.row));
    }
    return Reach(max(length(p - q.xy) - 0.5 * style.width, 0.0), q.z, q.xy, s.row, end);
}

// A triangle: a face, or one of an area's.
fn triangle_reach(instance: u32, p: vec2f) -> Reach {
    let row = triangle_row(instance);
    if row >= mark.rows || leaving(row) {
        return unreached();
    }
    let ka = triangle_corner(instance, 0u);
    let kb = triangle_corner(instance, 1u);
    let kc = triangle_corner(instance, 2u);
    let ca = clip_of(ka.world);
    let cb = clip_of(kb.world);
    let cc = clip_of(kc.world);
    let ahead = ka.ahead || kb.ahead || kc.ahead;
    if !ka.shown || !kb.shown || !kc.shown || !ahead || ca.w <= 0.0 || cb.w <= 0.0 || cc.w <= 0.0 {
        return unreached();
    }
    let a = screen(ca);
    let b = screen(cb);
    let c = screen(cc);
    let area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if abs(area) > 1e-9 {
        let wb = ((p.x - a.x) * (c.y - a.y) - (p.y - a.y) * (c.x - a.x)) / area;
        let wc = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / area;
        if wb >= 0.0 && wc >= 0.0 && wb + wc <= 1.0 {
            return Reach(0.0, a.z + (b.z - a.z) * wb + (c.z - a.z) * wc, p, row, 0u);
        }
    }
    var q = nearest_on(p, a, b);
    let q2 = nearest_on(p, b, c);
    let q3 = nearest_on(p, c, a);
    q = select(q, q2, length(p - q2.xy) < length(p - q.xy));
    q = select(q, q3, length(p - q3.xy) < length(p - q.xy));
    return Reach(length(p - q.xy), q.z, q.xy, row, 0u);
}

// Instance `instance` of the mark's primitive, measured from `p`.
fn reach(instance: u32, p: vec2f) -> Reach {
    switch PROBED {
        case POINTS: { return point_reach(instance, p); }
        case STROKES: { return segment_reach(instance, p); }
        case TRIANGLES: { return triangle_reach(instance, p); }
        default: { return unreached(); }
    }
}

fn drawn_depth(texel: vec2i) -> f32 {
    return textureLoad(depth, texel, 0);
}

// Whether the frame drew nothing in front of `r`. Depth is reversed: nearer is greater.
fn shown(r: Reach) -> bool {
    let size = vec2f(textureDimensions(depth));
    let texel = vec2i(clamp(r.point * eye.pixel_ratio, vec2f(0.0), size - 1.0));
    return drawn_depth(texel) <= r.depth * 1.01 + 1e-7;
}

// Instances of the mark's primitive: rows and their ports, a stroke's segments, or triangles.
fn instances() -> u32 {
    if PROBED == STROKES {
        return stroke_instances();
    }
    if PROBED == POINTS {
        return mark.rows * (1u + mark.ports);
    }
    return triangle_instances();
}

fn key(instance: u32) -> u32 {
    if instance >= instances() {
        return NONE;
    }
    let r = reach(instance, frame.probe);
    if !(r.distance <= frame.probe_radius) || !shown(r) {
        return NONE;
    }
    return (min(u32(r.distance * 64.0), 0xffffffu) << 8u) | (255u - min(mark.index, 255u));
}

@compute @workgroup_size(256)
fn nearest(@builtin(global_invocation_id) id: vec3u) {
    let k = key(id.x);
    if k != NONE {
        atomicMin(&probe[PROBE_KEY], k);
    }
}

@compute @workgroup_size(256)
fn topmost(@builtin(global_invocation_id) id: vec3u) {
    if key(id.x) == atomicLoad(&probe[PROBE_KEY]) && atomicLoad(&probe[PROBE_KEY]) != NONE {
        atomicMax(&probe[PROBE_INSTANCE], id.x + 1u);
    }
}

@compute @workgroup_size(1)
fn describe() {
    let k = atomicLoad(&probe[PROBE_KEY]);
    let instance = atomicLoad(&probe[PROBE_INSTANCE]);
    if k == NONE || instance == 0u || 255u - (k & 255u) != min(mark.index, 255u) {
        return;
    }
    let r = reach(instance - 1u, frame.probe);
    atomicStore(&probe[PROBE_DEPTH], bitcast<u32>(r.depth));
    atomicStore(&probe[PROBE_X], bitcast<u32>(r.point.x));
    atomicStore(&probe[PROBE_Y], bitcast<u32>(r.point.y));
    atomicStore(&probe[PROBE_ROW], r.row);
    atomicStore(&probe[PROBE_SEGMENT], r.segment);
}

// Entries a query keeps per mark: more are counted but not written.
fn kept() -> u32 {
    return lists[mark.query + LIST_KEPT];
}

// Instance `i` as the query's point reaches it, unreached when out of reach.
fn query_hit(i: u32) -> Reach {
    if i >= instances() {
        return unreached();
    }
    let r = reach(i, frame.query.xy);
    if !(r.distance <= frame.query.z) || !shown(r) {
        return unreached();
    }
    return r;
}

// Items the query's list counts: as many as the CPU sized it for, which a stroke's segment list may
// draw fewer of. Every one is counted, 0 past what draws, so no word left from before is summed.
fn query_items() -> u32 {
    return lists[mark.query + LIST_ITEMS];
}

@compute @workgroup_size(256)
fn count_hits(@builtin(global_invocation_id) id: vec3u) {
    if id.x < query_items() {
        lists[list_counts(mark.query) + id.x] = u32(query_hit(id.x).row != NONE);
    }
}

@compute @workgroup_size(256)
fn write_hits(@builtin(global_invocation_id) id: vec3u) {
    let r = query_hit(id.x);
    if r.row == NONE {
        return;
    }
    let at = lists[list_counts(mark.query) + id.x];
    if at < kept() {
        let e = list_entry(mark.query, 6u * at);
        lists[e] = r.row;
        lists[e + 1u] = min(u32(r.distance * 64.0), 0xffffffu);
        lists[e + 2u] = r.segment;
        lists[e + 3u] = bitcast<u32>(r.point.x);
        lists[e + 4u] = bitcast<u32>(r.point.y);
        lists[e + 5u] = bitcast<u32>(r.depth);
    }
}

fn in_box(p: vec2f) -> bool {
    return all(p >= frame.query.xy) && all(p <= frame.query.zw);
}

// Whether instance `i` lies in the query's box: a point's center, any part of a segment, or a
// triangle's corner.
fn boxed_row(i: u32) -> u32 {
    if i >= instances() {
        return NONE;
    }
    switch PROBED {
        case POINTS: {
            if i >= mark.rows {
                return NONE;
            }
            let pt = point(i);
            if !pt.shown || leaving(i) || pt.clip.w <= 0.0 || !in_box(to_screen(pt.clip)) {
                return NONE;
            }
            return i;
        }
        case STROKES: {
            let s = segment(i);
            if s.row >= mark.rows || leaving(s.row) || !stroke_style(s.row).shown {
                return NONE;
            }
            let on = segment_screen(s);
            if !on.shown {
                return NONE;
            }
            let a = on.a;
            let b = on.b;
            // The segment crosses the box when its ends do, or it passes through it.
            for (var k = 0u; k <= 8u; k++) {
                if in_box(mix(a, b, f32(k) / 8.0)) {
                    return s.row;
                }
            }
            return NONE;
        }
        default: {
            let row = triangle_row(i);
            if row >= mark.rows || leaving(row) {
                return NONE;
            }
            for (var k = 0u; k < 3u; k++) {
                let c = triangle_corner(i, k);
                let clip = clip_of(c.world);
                if c.shown && c.ahead && clip.w > 0.0 && in_box(to_screen(clip)) {
                    return row;
                }
            }
            return NONE;
        }
    }
}

@compute @workgroup_size(256)
fn count_boxed(@builtin(global_invocation_id) id: vec3u) {
    if id.x < query_items() {
        lists[list_counts(mark.query) + id.x] = u32(boxed_row(id.x) != NONE);
    }
}

@compute @workgroup_size(256)
fn write_boxed(@builtin(global_invocation_id) id: vec3u) {
    let row = boxed_row(id.x);
    if row == NONE {
        return;
    }
    let at = lists[list_counts(mark.query) + id.x];
    if at < kept() {
        lists[list_entry(mark.query, at)] = row;
    }
}

// Where the row the query names lies on screen, if it shows.
@compute @workgroup_size(1)
fn locate() {
    let row = bitcast<u32>(frame.query.x);
    if row >= mark.rows {
        return;
    }
    var at = vec4f(0.0);
    switch PROBED {
        case POINTS: {
            let pt = point(row);
            if pt.shown && pt.clip.w > 0.0 {
                at = vec4f(to_screen(pt.clip), 1.0, 0.0);
            }
        }
        case TRIANGLES: {
            if PATH == PATH_GEOMETRY {
                // An area lies where its label hangs.
                let anchor = area_anchor(row);
                let clip = clip_of(anchor.world);
                if anchor.shown && anchor.ahead && clip.w > 0.0 {
                    at = vec4f(to_screen(clip), 1.0, 0.0);
                }
            } else {
                var sum = vec2f(0.0);
                var shown = 0.0;
                for (var k = 0u; k < 3u; k++) {
                    let clip = clip_of(triangle_corner(row, k).world);
                    if clip.w > 0.0 {
                        sum += to_screen(clip);
                        shown += 1.0;
                    }
                }
                if shown == 3.0 {
                    at = vec4f(sum / 3.0, 1.0, 0.0);
                }
            }
        }
        default: {
            // A path lies where its middle segment's middle is.
            let on = segment_screen(Segment(row, path_count(row) / 2u, 0.0));
            if on.shown {
                at = vec4f(0.5 * (on.a + on.b), 1.0, 0.0);
            }
        }
    }
    atomicStore(&probe[PROBE_LOCATE_X], bitcast<u32>(at.x));
    atomicStore(&probe[PROBE_LOCATE_Y], bitcast<u32>(at.y));
    atomicStore(&probe[PROBE_LOCATED], u32(at.z));
}

@compute @workgroup_size(1)
fn under() {
    let size = vec2i(textureDimensions(depth));
    let at = vec2i(frame.probe * eye.pixel_ratio);
    var nearest = 0.0;
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            nearest = max(nearest, drawn_depth(clamp(at + vec2i(dx, dy), vec2i(0), size - 1)));
        }
    }
    atomicStore(&probe[PROBE_UNDER], bitcast<u32>(nearest));
}
