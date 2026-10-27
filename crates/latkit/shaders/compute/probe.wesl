// Probes and queries against a drawn frame, using the same geometry as the draws. One program,
// compiled per primitive, answers every question in steps, and a dispatch's uniform selects the
// step. Each step that reads instances projects each one to the screen once (`seen`) and tests what
// the step needs.
//
// The hover takes three steps over every mark it reaches. `nearest` keeps the least key over all
// instances within the probe's radius: the distance in 1/64 pixel, then the mark drawn last.
// `topmost` keeps the last instance of that mark at that key, and `describe` writes where that hit
// lies. Rows hidden behind other drawn marks are not hit. `under` writes the nearest depth drawn
// around the probe, which gestures rotate and zoom about.
//
// Queries write after the probe's words, each mark from the word its `query` names. `hits` appends
// every instance within the query's radius of its point while the mark has space for hits. `boxed`
// sets a bit for every row with an instance in the query's box, whether or not something drawn
// covers it. `locate` writes where one drawn row lies on screen. Every row an answer names is a
// held row, which the view maps to a table row using its record of that frame.

import package::lib::types::{
    NONE, FADE_OUT, POINTS, STROKES, MARK_EDGES, PROBE_KEY, PROBE_INSTANCE, PROBE_DEPTH, PROBE_X, PROBE_Y,
    PROBE_UNDER, PROBE_ROW, PROBE_SEGMENT, PROBE_LOCATE_X, PROBE_LOCATE_Y, PROBE_LOCATED, STEP_NEAREST, STEP_TOPMOST,
    STEP_DESCRIBE, STEP_HITS, STEP_BOXED, STEP_LOCATE, STEP_UNDER, HIT_WORDS, item,
};
import package::lib::bind::{frame, eye, mark, word};
import package::lib::state::row_at;
import package::lib::project::{to_screen, clip_of};
import package::lib::points::{point, port_at};
import package::lib::path::{segment, segment_screen, stroke_style, stroke_instances, path_count};
import package::lib::triangles::{triangle_corner, triangle_item, triangle_instances};
import package::lib::marker::outline_distance;
import package::lib::mark::PRIMITIVE;
import package::lib::drawn::drawn_row;
import package::lib::center::{row_center, Center};

// Which step a dispatch takes.
struct Step {
    step: u32,
}

@group(2) @binding(5) var<storage, read_write> probe: array<atomic<u32>>;
@if(multisampled)
@group(2) @binding(6) var depth: texture_depth_multisampled_2d;
@else
@group(2) @binding(6) var depth: texture_depth_2d;
@group(2) @binding(17) var<uniform> step: Step;

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

// An instance as the frame drew it, on screen, with depth as z: a point's center (and for a port,
// the port's center as `b`), a segment's ends, or a triangle's corners with whether each is shown,
// ahead of the globe's horizon, and in front of the eye. `item` is its drawn row and `row` that
// row's held row. `part` is a port's number from 1, or a segment's index along its path.
struct Seen {
    item: u32,
    row: u32,
    part: u32,
    // The row is a drawn row, not an exit, and neither it nor its tile is fading out.
    kept: bool,
    // A point is shown. A stroke's style is shown and its segment is on screen. A triangle's
    // corners are all shown and in front of the eye, and one is ahead of the horizon.
    shown: bool,
    a: vec3f,
    b: vec3f,
    c: vec3f,
    corners: vec3<bool>,
    ahead: vec3<bool>,
    front: vec3<bool>,
    // A point's half size, a port's radius as x, a stroke's width as x.
    half: vec2f,
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

// Whether drawn row `item` (held row `row`) responds to the pointer: it is not an exit, its tile is
// not `leaving`, and the row is not fading out.
fn answers(item: u32, row: u32, leaving: bool) -> bool {
    return item < mark.rows && !leaving && (word(row_at(row) + mark.stride - 1u) & FADE_OUT) == 0u;
}

// A point's marker, or for an instance past the rows, one of their ports.
fn seen_point(instance: u32) -> Seen {
    var s: Seen;
    let port = select(0u, instance - mark.rows, instance >= mark.rows);
    s.item = select(instance, port / max(mark.ports, 1u), instance >= mark.rows);
    let d = drawn_row(s.item);
    s.row = d.row;
    let pt = point(s.row);
    s.kept = answers(s.item, s.row, d.leaving);
    s.shown = pt.shown;
    s.a = screen(pt.clip);
    s.front = vec3<bool>(pt.clip.w > 0.0);
    s.half = max(pt.half, vec2f(0.5));
    if instance >= mark.rows {
        let k = port % max(mark.ports, 1u);
        let at = port_at(pt, k);
        s.part = k + 1u;
        s.b = vec3f(at.center, s.a.z);
        s.half = vec2f(at.half, 0.0);
    }
    return s;
}

// A stroke segment.
fn seen_segment(instance: u32) -> Seen {
    var s: Seen;
    let g = segment(instance);
    s.item = g.item;
    s.row = g.row;
    s.part = g.index;
    s.kept = answers(g.item, g.row, g.leaving);
    if !s.kept {
        return s;
    }
    let style = stroke_style(g.row);
    let on = segment_screen(g);
    s.shown = style.shown && on.shown;
    s.front = vec3<bool>(on.shown);
    s.a = vec3f(on.a, on.ca.z / on.ca.w);
    s.b = vec3f(on.b, on.cb.z / on.cb.w);
    s.half = vec2f(style.width, 0.0);
    return s;
}

// A triangle: a face, or one of an area's.
fn seen_triangle(instance: u32) -> Seen {
    var s: Seen;
    s.item = triangle_item(instance);
    let d = drawn_row(s.item);
    s.row = d.row;
    s.kept = answers(s.item, s.row, d.leaving);
    if !s.kept {
        return s;
    }
    let ka = triangle_corner(instance, 0u);
    let kb = triangle_corner(instance, 1u);
    let kc = triangle_corner(instance, 2u);
    let ca = clip_of(ka.world);
    let cb = clip_of(kb.world);
    let cc = clip_of(kc.world);
    s.corners = vec3<bool>(ka.shown, kb.shown, kc.shown);
    s.ahead = vec3<bool>(ka.ahead, kb.ahead, kc.ahead);
    s.front = vec3<bool>(ca.w > 0.0, cb.w > 0.0, cc.w > 0.0);
    s.shown = all(s.corners) && any(s.ahead) && all(s.front);
    s.a = screen(ca);
    s.b = screen(cb);
    s.c = screen(cc);
    return s;
}

// Instance `instance` of the mark's primitive on screen.
fn seen(instance: u32) -> Seen {
    switch PRIMITIVE {
        case POINTS: { return seen_point(instance); }
        case STROKES: { return seen_segment(instance); }
        default: { return seen_triangle(instance); }
    }
}

// How far `p` lies from the instance's drawn shape, and the shape's nearest point on screen, with
// its depth.
fn reach(s: Seen, p: vec2f) -> Reach {
    if !s.kept || !s.shown {
        return unreached();
    }
    switch PRIMITIVE {
        case POINTS: {
            if s.part > 0u {
                return Reach(max(length(p - s.b.xy) - s.half.x, 0.0), s.a.z, s.b.xy, s.row, s.part);
            }
            let d = outline_distance((p - s.a.xy) * vec2f(1.0, -1.0), s.half);
            return Reach(max(d, 0.0), s.a.z, s.a.xy, s.row, 0u);
        }
        case STROKES: {
            let q = nearest_on(p, s.a, s.b);
            // The nearer end gives the sample a trace's hit is at. For an edge, it gives which end.
            var end = select(s.part, s.part + 1u, length(q.xy - s.b.xy) < length(q.xy - s.a.xy));
            if mark.kind == MARK_EDGES {
                end = u32(2u * end >= path_count(s.item));
            }
            return Reach(max(length(p - q.xy) - 0.5 * s.half.x, 0.0), q.z, q.xy, s.row, end);
        }
        default: {
            let a = s.a;
            let b = s.b;
            let c = s.c;
            let area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if abs(area) > 1e-9 {
                let wb = ((p.x - a.x) * (c.y - a.y) - (p.y - a.y) * (c.x - a.x)) / area;
                let wc = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / area;
                if wb >= 0.0 && wc >= 0.0 && wb + wc <= 1.0 {
                    return Reach(0.0, a.z + (b.z - a.z) * wb + (c.z - a.z) * wc, p, s.row, 0u);
                }
            }
            var q = nearest_on(p, a, b);
            let q2 = nearest_on(p, b, c);
            let q3 = nearest_on(p, c, a);
            q = select(q, q2, length(p - q2.xy) < length(p - q.xy));
            q = select(q, q3, length(p - q3.xy) < length(p - q.xy));
            return Reach(length(p - q.xy), q.z, q.xy, s.row, 0u);
        }
    }
}

fn in_box(p: vec2f) -> bool {
    return all(p >= frame.query.xy) && all(p <= frame.query.zw);
}

// Whether the instance lies in the query's box: a point's center, any part of a segment, or a
// triangle's corner.
fn boxed(s: Seen) -> bool {
    if !s.kept {
        return false;
    }
    switch PRIMITIVE {
        case POINTS: {
            return s.part == 0u && s.shown && s.front.x && in_box(s.a.xy);
        }
        case STROKES: {
            if !s.shown {
                return false;
            }
            // Tests nine evenly spaced points along the segment, its ends included.
            for (var k = 0u; k <= 8u; k++) {
                if in_box(mix(s.a.xy, s.b.xy, f32(k) / 8.0)) {
                    return true;
                }
            }
            return false;
        }
        default: {
            let corner = s.corners & s.ahead & s.front;
            return (corner.x && in_box(s.a.xy)) || (corner.y && in_box(s.b.xy)) || (corner.z && in_box(s.c.xy));
        }
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

// The nearest depth drawn around the probe.
fn under() -> f32 {
    let size = vec2i(textureDimensions(depth));
    let at = vec2i(frame.probe * eye.pixel_ratio);
    var nearest = 0.0;
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            nearest = max(nearest, drawn_depth(clamp(at + vec2i(dx, dy), vec2i(0), size - 1)));
        }
    }
    return nearest;
}

// Instances of the mark's primitive: rows and their ports, a stroke's segments, or triangles.
fn instances() -> u32 {
    if PRIMITIVE == STROKES {
        return stroke_instances();
    }
    if PRIMITIVE == POINTS {
        return mark.rows * (1u + mark.ports);
    }
    return triangle_instances();
}

// Appends hit `r` to the mark's hits while there is room. At `mark.query` lie the number found and
// the number kept, then the hits, `HIT_WORDS` each.
fn append(r: Reach) {
    let at = atomicAdd(&probe[mark.query], 1u);
    if at >= atomicLoad(&probe[mark.query + 1u]) {
        return;
    }
    let entry = mark.query + 2u + HIT_WORDS * at;
    atomicStore(&probe[entry], r.row);
    atomicStore(&probe[entry + 1u], min(u32(r.distance * 64.0), 0xffffffu));
    atomicStore(&probe[entry + 2u], r.segment);
    atomicStore(&probe[entry + 3u], bitcast<u32>(r.point.x));
    atomicStore(&probe[entry + 4u], bitcast<u32>(r.point.y));
    atomicStore(&probe[entry + 5u], bitcast<u32>(r.depth));
}

// Writes where drawn row `item` lies on screen, and whether it shows there.
fn locate(item: u32) {
    var center = Center(vec2f(0.0), false);
    if item < mark.rows {
        center = row_center(item);
    }
    atomicStore(&probe[PROBE_LOCATE_X], bitcast<u32>(center.at.x));
    atomicStore(&probe[PROBE_LOCATE_Y], bitcast<u32>(center.at.y));
    atomicStore(&probe[PROBE_LOCATED], u32(center.shown));
}

@compute @workgroup_size(256)
fn answer(@builtin(global_invocation_id) id: vec3u) {
    let s = step.step;
    // Steps that read a single item use one invocation.
    if s == STEP_UNDER || s == STEP_LOCATE || s == STEP_DESCRIBE {
        if any(id != vec3u(0u)) {
            return;
        }
    }
    if s == STEP_UNDER {
        atomicStore(&probe[PROBE_UNDER], bitcast<u32>(under()));
        return;
    }
    // Locating reads the drawn row the query names.
    if s == STEP_LOCATE {
        locate(bitcast<u32>(frame.query.x));
        return;
    }
    // Describing reads the topmost instance the hover found, if it belongs to this mark. Every step
    // that reads an instance goes through the single `seen` call below.
    var i = item(id);
    if s == STEP_DESCRIBE {
        let key = atomicLoad(&probe[PROBE_KEY]);
        let instance = atomicLoad(&probe[PROBE_INSTANCE]);
        if key == NONE || instance == 0u || 255u - (key & 255u) != min(mark.index, 255u) {
            return;
        }
        i = instance - 1u;
    } else if i >= instances() {
        return;
    }
    let drawn = seen(i);
    if s == STEP_BOXED {
        if boxed(drawn) {
            atomicOr(&probe[mark.query + drawn.row / 32u], 1u << (drawn.row % 32u));
        }
        return;
    }
    let hits = s == STEP_HITS;
    let r = reach(drawn, select(frame.probe, frame.query.xy, hits));
    if !(r.distance <= select(frame.probe_radius, frame.query.z, hits)) || !shown(r) {
        return;
    }
    let key = (min(u32(r.distance * 64.0), 0xffffffu) << 8u) | (255u - min(mark.index, 255u));
    switch s {
        case STEP_NEAREST: {
            atomicMin(&probe[PROBE_KEY], key);
        }
        case STEP_TOPMOST: {
            if key == atomicLoad(&probe[PROBE_KEY]) {
                atomicMax(&probe[PROBE_INSTANCE], i + 1u);
            }
        }
        case STEP_DESCRIBE: {
            atomicStore(&probe[PROBE_DEPTH], bitcast<u32>(r.depth));
            atomicStore(&probe[PROBE_X], bitcast<u32>(r.point.x));
            atomicStore(&probe[PROBE_Y], bitcast<u32>(r.point.y));
            atomicStore(&probe[PROBE_ROW], r.row);
            atomicStore(&probe[PROBE_SEGMENT], r.segment);
        }
        default: {
            append(r);
        }
    }
}
