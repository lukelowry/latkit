import package::lib::types::{WordStep, NONE, STROKES, PATH_TRACE};
import package::lib::bind::{frame, mark};
import package::lib::probe::{seen, reach, shown, allowed, instances, under, boxed};
import package::lib::mark::PRIMITIVE;
import package::lib::path::PATH;
import package::lib::words::{word_quad, word_read, word_index, fullscreen};
@group(2) @binding(18) var source: texture_2d_array<u32>;
@group(2) @binding(20) var details: texture_2d_array<u32>;
@group(2) @binding(19) var<uniform> params: WordStep;
@vertex
fn vertex(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f { return fullscreen(v); }

@fragment
fn probe(@builtin(position) p: vec4f) -> @location(0) vec4u {
    // One geometry program serves hover, hits, row locations, and box selection.
    // Hits retain only occupancy until the scan selects the results that fit in the answer.
    let describe = params.other == 1u;
    let hits = params.other >= 2u;
    let gather = params.other == 3u;
    let locating = params.other == 4u;
    let boxing = params.other == 5u;
    var best = vec4u(0u);
    let record = word_index(p, params.layer) / 4u;
    var i = record;
    if locating {
        i = bitcast<u32>(frame.query.x);
        if i >= mark.rows { return vec4u(0u); }
    } else if describe {
        best = word_quad(source, params.source);
        if best.z == 0u { return vec4u(0u); }
        i = best.z - 1u;
    } else if gather {
        let count = word_read(source, params.count);
        if record == 0u { return vec4u(count, params.value, 0u, 0u); }
        let rank = (record - 1u) / 2u;
        if rank >= min(count, params.value) { return vec4u(0u); }
        var lo = 0u;
        var hi = params.count;
        while lo < hi {
            let mid = lo + (hi - lo) / 2u;
            if word_read(source, mid + 1u) <= rank { lo = mid + 1u; } else { hi = mid; }
        }
        i = lo;
    } else if i >= instances() { return vec4u(0u); }
    // Every step uses exactly the same geometry and reach computation.
    let s = seen(i, locating);
    if locating {
        var at = s.a.xy;
        if PRIMITIVE == STROKES { at = select(0.5 * (s.a.xy + s.b.xy), s.b.xy, PATH == PATH_TRACE); }
        return vec4u(bitcast<vec2u>(at), u32(s.shown), 0u);
    }
    if boxing { return vec4u(u32(boxed(s)), s.row, 0u, 0u); }
    let r = reach(s, select(frame.probe, frame.query.xy, hits));
    if gather {
        if (record & 1u) != 0u {
            return vec4u(r.row, min(u32(r.distance * 64.0), 0xffffffu), r.segment, bitcast<u32>(r.point.x));
        }
        return vec4u(bitcast<u32>(r.point.y), bitcast<u32>(r.depth), 1u, 0u);
    }
    if describe {
        if word_index(p, params.layer) == 0u { return vec4u(r.row, ~best.x, r.segment, bitcast<u32>(r.point.x)); }
        return vec4u(bitcast<u32>(r.point.y), bitcast<u32>(r.depth), 1u, 0u);
    }
    if hits { return vec4u(u32(r.distance <= frame.query.z && shown(r)), 0u, 0u, 0u); }
    if !(r.distance <= frame.probe_radius) || !shown(r) || !allowed(r) { return vec4u(0u); }
    return vec4u(~min(u32(r.distance * 64.0), 0xffffffu), mark.index + 1u, i + 1u, params.value);
}

@fragment
fn finish(@builtin(position) p: vec4f) -> @location(0) vec4u {
    let best = word_quad(source, 0u);
    let a = word_quad(details, best.w * 8u);
    let b = word_quad(details, best.w * 8u + 4u);
    let at = word_index(p, params.layer);
    if at == 0u { return vec4u(select(NONE, ~best.x, best.z != 0u), best.z, b.y, a.w); }
    if at == 4u { return vec4u(b.x, bitcast<u32>(under()), a.x, a.z); }
    return vec4u(0u, 0u, 0u, best.y - 1u);
}
