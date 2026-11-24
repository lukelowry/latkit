// Within a dense page each row stores its two endpoints at its first slot.
// Interior point k uses segment slot k. A two-segment overlap covers joints and fans.
// Sparse focus and anchor instances own six slots: two ends and four neighboring points.
import package::lib::types::{WordStep, PATH_BENDS, PLACE_ROWS, PLACE_SPANS};
import package::lib::words::word_quad;
import package::lib::path::{PATH, Segment, SegmentPoints, ProjectedSegment, PathPoint,
    lane_of, fans, clipped_segment, screen_point, ends_part};
import package::lib::project::to_screen;
import package::lib::record::{ProjectedStroke, projected_stroke};

@group(2) @binding(18) var point_page: texture_2d_array<u32>;

fn dense(mode: u32) -> bool { return mode == PLACE_ROWS || mode == PLACE_SPANS; }

// Point attributes stay in their own texels. An adjacent point contributes only
// its position and marker shape, while the two ends also supply paint colors.
fn point_word(slot: u32, part: u32) -> vec4u {
    if PATH == PATH_BENDS { return word_quad(point_page, slot * 16u + part * 4u); }
    let v = word_quad(point_page, slot * 8u + min(part, 1u) * 4u);
    if part == 3u { return vec4u(v.z, 0u, v.w, 0u); }
    return v;
}

fn point_clip(slot: u32) -> vec4f {
    return bitcast<vec4f>(point_word(slot, 0u));
}

fn point_shape(slot: u32, flags: u32) -> PathPoint {
    let shape = bitcast<vec4f>(point_word(slot, 1u));
    var p: PathPoint;
    p.hi = shape.xy;
    if PATH == PATH_BENDS { p.half = shape.zw; }
    p.shown = (flags & 1u) != 0u;
    p.boxed = (flags & 2u) != 0u;
    return p;
}

fn adjacent_slot(slot: u32, index: u32, last: u32, head: u32) -> u32 {
    if index == 0u { return head; }
    if index >= last { return head + 1u; }
    return slot;
}

fn from_page(at: vec4f, s: Segment, i: u32, params: WordStep) -> ProjectedStroke {
    let contiguous = dense(params.value);
    let local = params.source + i - params.other;
    let head = select(local * 6u, (local - min(local, s.index)) * 3u, contiguous);
    let info = point_word(head, 3u);
    let last = info.z;
    var p: SegmentPoints;
    p.width = bitcast<f32>(info.y);
    p.bent = (info.x & 8u) != 0u;
    var k = s.index;
    if PATH == PATH_BENDS {
        p.lane = lane_of(s.row);
        if fans(p.lane) {
            p.fan = select(select(0u, 2u, k > last), 1u, k == 0u);
            k = clamp(k, 1u, last) - 1u;
        }
    }
    p.first = k == 0u;
    p.last = k + 1u >= last;
    let offset = vec4u(0u, 1u, 2u, 3u);
    let indices = vec4u(max(k, 1u) - 1u, k, k + 1u, k + 2u);
    let interior = select(vec4u(local * 6u + 2u) + offset, (vec4u(local - s.index) + indices) * 3u + 2u, contiguous);
    let slots = vec4u(adjacent_slot(interior.x, indices.x, last, head), adjacent_slot(interior.y, indices.y, last, head),
        adjacent_slot(interior.z, indices.z, last, head), adjacent_slot(interior.w, indices.w, last, head));
    let af = point_word(slots.y, 3u).x;
    let bf = point_word(slots.z, 3u).x;
    p.ends.a = point_shape(slots.y, af);
    p.ends.b = point_shape(slots.z, bf);
    if PATH == PATH_BENDS {
        p.ends.a.color = bitcast<vec4f>(point_word(slots.y, 2u));
        p.ends.b.color = bitcast<vec4f>(point_word(slots.z, 2u));
    } else {
        p.ends.a.color = vec4f(1.0);
        p.ends.b.color = vec4f(1.0);
    }
    var q: ProjectedSegment;
    if p.ends.a.shown && p.ends.b.shown {
        var before = vec3f(0.0);
        var after = vec3f(0.0);
        if !p.first {
            p.before = point_shape(slots.x, point_word(slots.x, 3u).x);
            before = screen_point(p.before, point_clip(slots.x));
        }
        if !p.last {
            p.after = point_shape(slots.w, point_word(slots.w, 3u).x);
            after = screen_point(p.after, point_clip(slots.w));
        }
        var centers = vec4f(0.0);
        if PATH == PATH_BENDS {
            p.vertex_a = point_shape(head, info.x);
            p.vertex_b = point_shape(head + 1u, point_word(head + 1u, 3u).x);
            centers = vec4f(to_screen(point_clip(head)), to_screen(point_clip(head + 1u)));
        }
        q = clipped_segment(point_clip(slots.y), point_clip(slots.z), before, after, centers, ((af | bf) & 4u) != 0u);
    }
    return projected_stroke(at, s, p, q, ends_part(s));
}
