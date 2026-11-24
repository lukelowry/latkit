import package::lib::types::{WordStep, PLACE_SPANS};
import package::lib::path::{Segment, SegmentPoints, ProjectedSegment, Lane, OnScreen, fit_segment, path_position};

// One triangle covers one record. Its vertices expand the path and project the points.
// Flat varyings carry those coordinates to the fragment that fits lanes and busbars.
struct ProjectedStroke {
    @builtin(position) at: vec4f,
    @location(0) @interpolate(flat) ca: vec4f,
    @location(1) @interpolate(flat) cb: vec4f,
    @location(2) @interpolate(flat) adjacent: vec4f,
    @location(3) @interpolate(flat) vertices: vec4f,
    @location(4) @interpolate(flat) end_size: vec4f,
    @location(5) @interpolate(flat) adjacent_size: vec4f,
    @location(6) @interpolate(flat) vertex_size: vec4f,
    @location(7) @interpolate(flat) source_xy: vec4f,
    @location(8) @interpolate(flat) color_a: vec4f,
    @location(9) @interpolate(flat) color_b: vec4f,
    @location(10) @interpolate(flat) lane: vec4u,
    @location(11) @interpolate(flat) lengths: vec4f,
    @location(12) @interpolate(flat) row: vec4u,
    @location(13) @interpolate(flat) cut: vec2f,
}

const SHOWN: u32 = 1u;
const FIRST: u32 = 2u;
const LAST: u32 = 4u;
const BENT: u32 = 8u;
const PART_END: u32 = 16u;
const BEFORE: u32 = 32u;
const AFTER: u32 = 64u;

// At the row's pixel centers this triangle covers exactly stride consecutive texels.
fn record_position(i: u32, corner: u32, params: WordStep) -> vec4f {
    let stride = select(4u, 2u, params.value >= PLACE_SPANS);
    let texel = params.destination + i * stride;
    let pixel = vec2u(texel % params.size.x, texel / params.size.x)
        + vec2u(select(0u, 2u * stride, corner == 1u), u32(corner == 2u));
    return vec4f(vec2f(pixel) / vec2f(params.size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}

fn projected_stroke(at: vec4f, s: Segment, p: SegmentPoints, q: ProjectedSegment, last: bool) -> ProjectedStroke {
    let flags = u32(q.shown) | select(0u, FIRST, p.first) | select(0u, LAST, p.last)
        | select(0u, BENT, p.bent) | select(0u, PART_END, last) | select(0u, BEFORE, q.before.z > 0.0)
        | select(0u, AFTER, q.after.z > 0.0) | (p.fan << 8u)
        | (u32(p.ends.a.boxed) << 10u) | (u32(p.ends.b.boxed) << 11u)
        | (u32(p.before.boxed) << 12u) | (u32(p.after.boxed) << 13u)
        | (u32(p.vertex_a.boxed) << 14u) | (u32(p.vertex_b.boxed) << 15u);
    return ProjectedStroke(at, q.ca, q.cb, vec4f(q.before.xy, q.after.xy), q.vertices,
        vec4f(p.ends.a.half, p.ends.b.half), vec4f(p.before.half, p.after.half),
        vec4f(p.vertex_a.half, p.vertex_b.half), vec4f(path_position(p.ends.a).xy, path_position(p.ends.b).xy),
        p.ends.a.color, p.ends.b.color, vec4u(bitcast<u32>(p.lane.offset), p.lane.index, bitcast<u32>(p.lane.step), p.lane.size),
        vec4f(p.width, s.along, s.presence, s.growth), vec4u(s.row, s.item, s.index, flags), q.cut);
}

fn placed_stroke(v: ProjectedStroke) -> OnScreen {
    let flags = v.row.w;
    var p: SegmentPoints;
    p.ends.a.hi = v.source_xy.xy;
    p.ends.b.hi = v.source_xy.zw;
    p.ends.a.color = v.color_a;
    p.ends.b.color = v.color_b;
    p.ends.a.half = v.end_size.xy;
    p.ends.b.half = v.end_size.zw;
    p.before.half = v.adjacent_size.xy;
    p.after.half = v.adjacent_size.zw;
    p.vertex_a.half = v.vertex_size.xy;
    p.vertex_b.half = v.vertex_size.zw;
    p.ends.a.boxed = (flags & (1u << 10u)) != 0u;
    p.ends.b.boxed = (flags & (1u << 11u)) != 0u;
    p.before.boxed = (flags & (1u << 12u)) != 0u;
    p.after.boxed = (flags & (1u << 13u)) != 0u;
    p.vertex_a.boxed = (flags & (1u << 14u)) != 0u;
    p.vertex_b.boxed = (flags & (1u << 15u)) != 0u;
    p.first = (flags & FIRST) != 0u;
    p.last = (flags & LAST) != 0u;
    p.bent = (flags & BENT) != 0u;
    p.fan = (flags >> 8u) & 3u;
    p.lane = Lane(bitcast<f32>(v.lane.x), v.lane.y, bitcast<f32>(v.lane.z), v.lane.w);
    p.width = v.lengths.x;
    let before = vec3f(v.adjacent.xy, f32((flags & BEFORE) != 0u));
    let after = vec3f(v.adjacent.zw, f32((flags & AFTER) != 0u));
    return fit_segment(p, ProjectedSegment(v.ca, v.cb, before, after, v.vertices, v.cut, (flags & SHOWN) != 0u));
}
