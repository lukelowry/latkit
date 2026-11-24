import package::lib::types::{WordStep, NONE, PLACE_SPANS, PLACE_LIT};
import package::lib::record::{ProjectedStroke, projected_stroke, placed_stroke, record_position, PART_END, BEFORE, AFTER};
import package::lib::path::{Segment, segment_points,
    project_segment, ends_part, stroke_style};
import package::lib::placement::placement;
@if(projected) import package::lib::point_page::from_page;
import package::lib::screen::{paint_stroke, stroke_record};

@group(2) @binding(19) var<uniform> params: WordStep;

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) i: u32) -> ProjectedStroke {
    let instance = params.source + i;
    let at = record_position(i, corner, params);
    var empty: ProjectedStroke;
    empty.at = at;
    // Flat data comes from the first or last vertex, depending on the graphics backend.
    if corner == 1u { return empty; }
    let s = placement(instance, params.value);
    if s.item == NONE { return empty; }
    @if(projected) { return from_page(at, s, i, params); }
    @if(!projected) {
        let p = segment_points(s);
        return projected_stroke(at, s, p, project_segment(p), ends_part(s));
    }
}

@fragment
fn record(v: ProjectedStroke) -> @location(0) vec4u {
    let query = params.value >= PLACE_SPANS;
    var q = v;
    if query { q.row.w &= ~(BEFORE | AFTER); }
    let on = placed_stroke(q);
    let word = u32(v.at.x);
    // Both layouts start with the endpoints. Visibility lives in the record's flags, so
    // this texel needs no row style, colors or comet data.
    if (word & select(3u, 1u, query)) == 0u { return bitcast<vec4u>(vec4f(on.a, on.b)); }
    let style = stroke_style(v.row.x);
    if query {
        return vec4u(bitcast<vec3u>(vec3f(on.ca.z / on.ca.w, on.cb.z / on.cb.w, style.width)), u32(on.shown && style.shown));
    }
    let s = Segment(v.row.x, v.row.y, v.row.z, v.lengths.y, v.lengths.z, v.lengths.w, false);
    let r = stroke_record(paint_stroke(s, on, style, (v.row.w & PART_END) != 0u, params.value == PLACE_LIT));
    switch word & 3u {
        case 1u: { return r.t1; }
        case 2u: { return r.t2; }
        default: { return r.t3; }
    }
}
