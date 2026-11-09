// List construction uses counts, a prefix scan, and inverse lookup. Every output has one writer;
// no pass appends, scatters overlapping writes, or waits for a count to reach the CPU.
import package::lib::bind::{mark, program};
import package::lib::types::{WordStep, NONE, POINTS, TRIANGLES, PATH_TRACE, RUN_WORDS,
    FADE_IN, FADE_OUT, DRAWN_ENTERING, DRAWN_LEAVING, LIST_ITEMS, LIST_KEPT, WORD_WIDTH, WORD_HEIGHT, POINT_BITS,
    HEIGHT_BITS};
import package::lib::words::{word_read, word_quad, word_index, fullscreen};
import package::lib::lists::{list, list_start, list_total};
import package::lib::read::{last_at_most, points_of, point_address};
import package::lib::path::{row_segments, path_point, path_length, numbered_segment, segment_ends, PATH};
import package::lib::drawn::held_row;
import package::lib::state::{row_at, vertex_at};
import package::lib::reduce::ordered;

@group(2) @binding(18) var source: texture_2d_array<u32>;
@group(2) @binding(19) var<uniform> params: WordStep;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var clip = fullscreen(i);
    if params.other != 0u {
        // The GPU already knows the active prefix. Restrict its raster footprint without a CPU
        // readback; unused capacity is never consumed by the draw or a query.
        let words = min(params.count, list_total(mark.list)) * params.other;
        let start = params.layer * WORD_WIDTH * WORD_HEIGHT * 4u;
        let remaining = words - min(words, start);
        let rows = min((remaining + WORD_WIDTH * 4u - 1u) / (WORD_WIDTH * 4u), params.size.y);
        clip.y = 1.0 + (clip.y - 1.0) * f32(rows) / f32(params.size.y);
    }
    return clip;
}
fn index(position: vec4f) -> u32 { return word_index(position, params.layer) - params.destination; }

fn drawn(i: u32) -> u32 {
    if i >= params.count { return 0u; }
    let run = last_at_most(mark.row_runs + 1u, max(program(mark.row_runs), 1u), RUN_WORDS, 0u, i);
    let fade = program(run + 2u);
    return (program(run + 1u) + i - program(run))
        | select(0u, DRAWN_ENTERING, (fade & FADE_IN) != 0u)
        | select(0u, DRAWN_LEAVING, (fade & FADE_OUT) != 0u);
}

@fragment
fn expand_runs(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position);
    return vec4u(drawn(i), drawn(i + 1u), drawn(i + 2u), drawn(i + 3u));
}

fn count(i: u32) -> u32 {
    if i >= params.count { return 0u; }
    return min(row_segments(held_row(i)), 0xffffffffu / max(params.count, 1u));
}

@fragment
fn count_segments(@builtin(position) position: vec4f) -> @location(0) vec4u {
    // One geometry evaluation per invocation. Four serial evaluations in one fragment make
    // geographic shaders expensive to compile and leave less parallelism for the GPU.
    return vec4u(count(index(position) / 4u), 0u, 0u, 0u);
}

fn count_word(i: u32) -> u32 {
    if i >= params.count { return 0u; }
    return word_quad(source, params.source + 4u * i).x;
}

@fragment
fn pack_counts(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position);
    return vec4u(count_word(i), count_word(i + 1u), count_word(i + 2u), count_word(i + 3u));
}

// The row owning an instance in the compacted list.
fn owner(i: u32) -> u32 {
    if i >= list_total(mark.list) { return NONE; }
    var lo = 0u;
    var hi = list(mark.list + LIST_ITEMS);
    while hi - lo > 1u {
        let mid = (lo + hi) / 2u;
        if list_start(mark.list, mid) <= i { lo = mid; } else { hi = mid; }
    }
    return lo;
}

// Solid paths need only their row indices. Write two final records directly, without computing
// endpoint geometry, scanning lengths, or repacking a temporary four-word record.
@fragment
fn segments_unmeasured(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position) / 2u;
    return vec4u(owner(i), 0u, owner(i + 1u), 0u);
}

// Area entries retain the first corner's address when all three corners share a piece. A rare
// piece crossing retains NONE and resolves through the page table while drawing. Neither case
// changes the two-word list layout, and column-page changes invalidate the prepared addresses.
fn area_record(i: u32) -> vec2u {
    let item = owner(i);
    if item == NONE { return vec2u(NONE); }
    let points = points_of(mark.geometry, held_row(item));
    let corner = 3u * (i - list_start(mark.list, item)) + 1u;
    if corner + 2u >= points.count || ((points.first + corner) >> POINT_BITS) != ((points.first + corner + 2u) >> POINT_BITS) {
        return vec2u(item, NONE);
    }
    return vec2u(item, point_address(points, corner));
}

@fragment
fn area_segments(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position) / 2u;
    return vec4u(area_record(i), area_record(i + 1u));
}

@fragment
fn segments(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position) / 4u;
    let lo = owner(i);
    if lo == NONE { return vec4u(NONE, 0u, 0u, 0u); }
    var length = 0.0;
    if PATH != PATH_TRACE {
        if mark.primitive != TRIANGLES {
            let start = list_start(mark.list, lo);
            let count = list_start(mark.list, lo + 1u) - start;
            let row = held_row(lo);
            let a = path_point(row, count, i - start);
            let b = path_point(row, count, i - start + 1u);
            if a.shown && b.shown { length = path_length(a, b); }
        }
    }
    return vec4u(lo, bitcast<u32>(length), 0u, 0u);
}

fn instances() -> u32 {
    if mark.primitive == POINTS { return mark.rows + mark.exits; }
    if mark.per_row != NONE { return (mark.rows + mark.exits) * mark.per_row; }
    return list_total(mark.list);
}

// The low HEIGHT_BITS bits sort: rows that left after the rest, each lowest first. The top bits of
// a height's order-preserving bits keep its sign, exponent, and 14 bits of mantissa.
fn height_key(height: f32, left: bool) -> u32 {
    let order = ordered(select(height, 0.0, height == 0.0)) >> (33u - HEIGHT_BITS);
    return select(0u, 1u << (HEIGHT_BITS - 1u), left) | order;
}

@fragment
fn height_keys(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position) / 4u;
    var key = NONE;
    if i < instances() {
        if mark.primitive == POINTS { key = height_key(vertex_at(row_at(held_row(i))).elevation, i >= mark.rows); }
        else {
            let s = numbered_segment(i);
            let ends = segment_ends(s);
            key = height_key(0.5 * (ends.a.z + ends.b.z), s.item >= mark.rows);
        }
    }
    return vec4u(key, i, 0u, 0u);
}

@fragment
fn pack_segments(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position) / 2u;
    return vec4u(word_quad(source, params.source + 4u * i).xy, word_quad(source, params.source + 4u * (i + 1u)).xy);
}

@fragment
fn pack_order(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position);
    return vec4u(word_read(source, params.source + 4u * i + 1u), word_read(source, params.source + 4u * i + 5u),
        word_read(source, params.source + 4u * i + 9u), word_read(source, params.source + 4u * i + 13u));
}
