// Projects each referenced path point into the contiguous scratch page before fitting strokes.
import package::lib::types::{WordStep, PATH_BENDS, NONE};
import package::lib::bind::mark;
import package::lib::path::{PATH, path_count, edge_path, edge_path_point, geometry_point, place, path_position, piece_of, PathPoint};
import package::lib::project::shows;
import package::lib::read::points_of;
import package::lib::placement::placement;
import package::lib::point_page::dense;

@group(2) @binding(19) var<uniform> params: WordStep;

struct Point {
    @builtin(position) at: vec4f,
    @location(0) @interpolate(flat) clip: vec4f,
    @location(1) @interpolate(flat) shape: vec4f,
    @location(2) @interpolate(flat) color: vec4f,
    @location(3) @interpolate(flat) info: vec4u,
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) slot: u32) -> Point {
    var out: Point;
    let contiguous = dense(params.value);
    let stride = select(6u, 3u, contiguous);
    let i = slot / stride;
    let role = slot % stride;
    let texels = select(2u, 4u, PATH == PATH_BENDS);
    let texel = texels * slot;
    let pixel = vec2u(texel % params.size.x, texel / params.size.x)
        + vec2u(select(0u, 2u * texels, corner == 1u), u32(corner == 2u));
    out.at = vec4f(vec2f(pixel) / vec2f(params.size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
    if corner == 1u { return out; }
    // A capped list can end mid-path. Its last segment still needs the next two source points.
    let source = params.source + i;
    let seed = min(source, params.other);
    var s = placement(seed, params.value);
    s.index += source - seed;
    if s.item == NONE { return out; }
    if contiguous && role < 2u && i > 0u && s.index > 0u { return out; }
    let count = path_count(s.item);
    var last = count;
    var k = s.index;
    var p: PathPoint;
    var width = 0.0;
    var bent = false;
    if PATH == PATH_BENDS {
        let e = edge_path(s, count);
        last = e.last;
        width = e.width;
        bent = e.bends.count > 0u;
        if !contiguous { k = piece_of(e, s.index).x + role - 3u; }
        if role >= 2u && (k == 0u || k >= last) { return out; }
        if role == 0u { k = 0u; }
        if role == 1u { k = last; }
        p = edge_path_point(e, min(k, last));
    } else {
        if !contiguous { k += role - 3u; }
        if role >= 2u && (k == 0u || k >= last) { return out; }
        if role == 0u { k = 0u; }
        if role == 1u { k = last; }
        p = geometry_point(points_of(mark.geometry, s.row), points_of(mark.frozen_geometry, s.row), min(k, last));
    }
    let pos = place(p);
    out.clip = pos.clip;
    out.shape = vec4f(path_position(p).xy, p.half);
    out.color = p.color;
    let flags = u32(p.shown) | (u32(p.boxed) << 1u) | (u32(shows(pos.world)) << 2u) | (u32(bent) << 3u);
    out.info = vec4u(flags, bitcast<u32>(width), last, 0u);
    return out;
}

@fragment
fn point(v: Point) -> @location(0) vec4u {
    if v.info.z == 0u { discard; }
    if PATH != PATH_BENDS {
        if (u32(v.at.x) & 1u) == 0u { return bitcast<vec4u>(v.clip); }
        return vec4u(bitcast<vec2u>(v.shape.xy), v.info.x, v.info.z);
    }
    switch u32(v.at.x) & 3u {
        case 0u: { return bitcast<vec4u>(v.clip); }
        case 1u: { return bitcast<vec4u>(v.shape); }
        case 2u: { return bitcast<vec4u>(v.color); }
        default: { return v.info; }
    }
}
