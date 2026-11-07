// Geometry shared by raster hover and queries.
import package::lib::types::{
    NONE, FADE_OUT, POINTS, STROKES, MARK_EDGES, PROBE_KEY, PROBE_INSTANCE, PROBE_DEPTH, PROBE_X, PROBE_Y,
    PROBE_UNDER, PROBE_ROW, PROBE_SEGMENT, PROBE_LOCATE_X, PROBE_LOCATE_Y, PROBE_LOCATED,
    HIT_WORDS, PATH_TRACE,
};
import package::lib::bind::{frame, eye, mark, word};
import package::lib::state::row_at;
import package::lib::project::{to_screen, clip_of};
import package::lib::points::point;
import package::lib::path::{PATH, Segment, segment, path_segment, segment_screen, stroke_style, stroke_instances, path_count};
import package::lib::triangles::{area_source, area_anchor, triangle_corner, triangle_instances};
import package::lib::marker::outline_distance;
import package::lib::mark::PRIMITIVE;
import package::lib::drawn::{drawn_row, drawn_instance};


// A non-filtering float binding reads a depth texture without a comparison sampler. This is
// supported by wgpu and maps to WebGL2's ordinary sampler2D/texelFetch path.
@group(2) @binding(6) var depth: texture_2d<f32>;
// How far the probe lies from an instance, and the instance's nearest point: its depth, and the
// depth the frame drew it at there, which for a marker is its radius nearer the camera.
struct Reach {
    distance: f32,
    depth: f32,
    point: vec2f,
    row: u32,
    segment: u32,
    drawn: f32,
}

fn unreached() -> Reach {
    return Reach(1e30, 0.0, vec2f(0.0), NONE, 0u, 0.0);
}

// An instance as the frame drew it, on screen, with depth as z: a point's center, a segment's ends,
// or a triangle's corners with whether each is shown, ahead of the globe's horizon, and in front of
// the eye. `item` is its drawn row and `row` that row's held row. `part` is a segment's index
// along its path.
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
    // A point's half size, or a stroke's width as x.
    half: vec2f,
    // The depth a point's marker draws at.
    drawn: f32,
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

// The marker drawn at position `instance`.
fn seen_point(instance: u32, locating: bool) -> Seen {
    var s: Seen;
    s.item = instance;
    if !locating { s.item = drawn_instance(instance); }
    let d = drawn_row(s.item);
    s.row = d.row;
    let pt = point(s.row);
    s.kept = answers(s.item, s.row, d.leaving);
    s.shown = pt.shown;
    s.a = screen(pt.clip);
    s.drawn = pt.drawn_z;
    s.front = vec3<bool>(pt.clip.w > 0.0);
    s.half = max(pt.half, vec2f(0.5));
    return s;
}

// A stroke segment.
fn seen_segment(instance: u32, locating: bool) -> Seen {
    var s: Seen;
    var g: Segment;
    if locating {
        let count = path_count(instance);
        if count == 0u { return s; }
        g = path_segment(instance, select(count / 2u, count - 1u, PATH == PATH_TRACE), 0.0);
    } else {
        g = segment(instance);
    }
    s.item = g.item;
    s.row = g.row;
    s.part = g.index;
    s.kept = locating || answers(g.item, g.row, g.leaving);
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

// One of an area's triangles.
fn seen_triangle(instance: u32, locating: bool) -> Seen {
    var s: Seen;
    if locating {
        let d = drawn_row(instance);
        let anchor = area_anchor(d.row);
        let clip = clip_of(anchor.world);
        s.a = screen(clip);
        s.shown = anchor.shown && anchor.ahead && clip.w > 0.0;
        return s;
    }
    let part = segment(instance);
    s.item = part.item;
    let d = drawn_row(s.item);
    s.row = d.row;
    s.kept = answers(s.item, s.row, d.leaving);
    if !s.kept {
        return s;
    }
    let source = area_source(s.row);
    let ka = triangle_corner(part, source, 0u);
    let kb = triangle_corner(part, source, 1u);
    let kc = triangle_corner(part, source, 2u);
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

// One primitive instance, or the representative primitive of drawn row `instance` when locating.
// Both select their source first, then share the same projection and visibility calculation.
fn seen(instance: u32, locating: bool) -> Seen {
    switch PRIMITIVE {
        case POINTS: { return seen_point(instance, locating); }
        case STROKES: { return seen_segment(instance, locating); }
        default: { return seen_triangle(instance, locating); }
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
            let d = outline_distance((p - s.a.xy) * vec2f(1.0, -1.0), s.half);
            return Reach(max(d, 0.0), s.a.z, s.a.xy, s.row, 0u, s.drawn);
        }
        case STROKES: {
            let q = nearest_on(p, s.a, s.b);
            // The nearer end gives the sample a trace's hit is at. For an edge, it gives which end.
            var end = select(s.part, s.part + 1u, length(q.xy - s.b.xy) < length(q.xy - s.a.xy));
            if mark.kind == MARK_EDGES {
                end = u32(2u * end >= path_count(s.item));
            }
            return Reach(max(length(p - q.xy) - 0.5 * s.half.x, 0.0), q.z, q.xy, s.row, end, q.z);
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
                    let z = a.z + (b.z - a.z) * wb + (c.z - a.z) * wc;
                    return Reach(0.0, z, p, s.row, 0u, z);
                }
            }
            var q = nearest_on(p, a, b);
            let q2 = nearest_on(p, b, c);
            let q3 = nearest_on(p, c, a);
            q = select(q, q2, length(p - q2.xy) < length(p - q.xy));
            q = select(q, q3, length(p - q3.xy) < length(p - q.xy));
            return Reach(length(p - q.xy), q.z, q.xy, s.row, 0u, q.z);
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
            return s.shown && s.front.x && in_box(s.a.xy);
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
    return textureLoad(depth, texel, 0).x;
}

// Whether the frame drew nothing in front of `r`. Depth is reversed: nearer is greater.
fn shown(r: Reach) -> bool {
    let size = vec2f(textureDimensions(depth));
    let texel = vec2i(clamp(r.point * eye.pixel_ratio, vec2f(0.0), size - 1.0));
    return drawn_depth(texel) <= r.drawn * 1.01 + 1e-7;
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

// Instances of the mark's primitive: rows, a stroke's segments, or triangles.
fn instances() -> u32 {
    if PRIMITIVE == STROKES {
        return stroke_instances();
    }
    if PRIMITIVE == POINTS {
        return mark.rows;
    }
    return triangle_instances();
}

// Whether the hover's steps may find the row reached at `r`: not the row the frame passes over, in
// its area and off its covers, and within 45° of its way from the probe unless that is zero.
fn allowed(r: Reach) -> bool {
    let p = r.point;
    if (mark.index == frame.probe_skip.x && r.row == frame.probe_skip.y) || any(p < frame.probe_area.xy)
        || any(p > frame.probe_area.zw) {
        return false;
    }
    for (var k = 0u; k < min(frame.probe_covers, 4u); k++) {
        let cover = frame.probe_cover[k];
        if all(p >= cover.xy) && all(p <= cover.zw) {
            return false;
        }
    }
    let offset = p - frame.probe;
    return all(frame.probe_way == vec2f(0.0)) || dot(offset, frame.probe_way) > length(offset) * 0.70710678;
}

