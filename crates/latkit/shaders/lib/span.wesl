// Screen-space geometry used by picking and label placement. A frame supplies either the base
// paint records, compact unjoined segments in source order, or one compact anchor per row.
import package::lib::types::{WordStep, NONE, MARK_EDGES, PATH_TRACE, READ_EMPTY, READ_PAINT, READ_ANCHORS, READ_ONE};
import package::lib::bind::mark;
import package::lib::screen::{record_word, STROKE_SHOWN};
import package::lib::lists::list_start;
import package::lib::path::{PATH, Segment, trace_screen, stroke_style, edge_style, line_style, path_count, path_segment};

struct StrokeSpan {
    ends: vec4f,
    depth: vec2f,
    width: f32,
    shown: bool,
}

fn representative(item: u32, count: u32) -> Segment {
    return path_segment(item, select(count / 2u, max(count, 1u) - 1u, PATH == PATH_TRACE), 0.0);
}

fn stroke_span(g: Segment, params: WordStep) -> StrokeSpan {
    if PATH == PATH_TRACE {
        let style = stroke_style(g.row);
        let on = trace_screen(g);
        return StrokeSpan(vec4f(on.a, on.b), vec2f(on.ca.z / on.ca.w, on.cb.z / on.cb.w), style.width, style.shown && on.shown);
    }
    var out: StrokeSpan;
    var i = params.record_first;
    switch params.record_kind {
        case READ_EMPTY: { return out; }
        case READ_ONE: {}
        case READ_ANCHORS: { i += g.item; }
        default: {
            let start = select(list_start(mark.list, g.item), g.item * mark.per_row, mark.per_row != NONE);
            i += start + g.index;
        }
    }
    let paint = params.record_kind == READ_PAINT;
    let stride = select(2u, 4u, paint);
    out.ends = bitcast<vec4f>(record_word(i, 0u, stride));
    let info = record_word(i, 1u, stride);
    out.depth = bitcast<vec2f>(info.xy);
    if paint {
        out.shown = ((record_word(i, 3u, 4u).x >> 24u) & STROKE_SHOWN) != 0u;
        // Picking uses the row's width before its tile grows and before half-float packing.
        if mark.kind == MARK_EDGES { out.width = edge_style(g.row).width; }
        else { out.width = line_style(g.row).width; }
    } else {
        out.width = bitcast<f32>(info.z);
        out.shown = info.w != 0u;
    }
    return out;
}
