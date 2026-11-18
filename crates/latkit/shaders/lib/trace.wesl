// Visible trace points are planned once on the CPU. Each row block holds a ring of aligned records:
// coordinate high/low, absolute value address, and a word of the rows in that value's page, how
// many entries the point reads, and whether it draws their greatest. A missing address breaks the
// line. Drawing, picking, and bounds all read this same plan.
import package::lib::types::{NONE, MISSING, TRACE_ROWS, TRACE_COUNT, TRACE_MOST, TRACE_GREATEST};
import package::lib::bind::{program_words, mark, word};
import package::lib::words::word_quad;
import package::lib::read::{page_of, missing_bits};

// The row block's records, point count, and row within each value page.
fn trace_cursor(row: u32) -> vec3u {
    let at = page_of(row);
    return vec3u(mark.trace + 4u * at.x * mark.trace_capacity, select(0u, mark.trace_points, at.x < mark.trace_rows), at.y);
}

// Coordinate high/low and value bits; a missing value represents a hidden point. A point standing
// for a pixel column reads its few entries, a page row apart, and draws the least of them, or the
// greatest when its record says so. Missing entries are passed over, and a column with none is
// missing. The record and its entries are read whatever the point, and a point past the plan or
// without a value selects missing (see `lib/read.wesl`).
fn trace_read(base: vec3u, point: u32) -> vec3u {
    let slot = (mark.trace_head + point) & (mark.trace_capacity - 1u);
    let cursor = word_quad(program_words, base.x + 4u * slot);
    let per = cursor.w & TRACE_ROWS;
    let count = clamp((cursor.w >> TRACE_COUNT) & 0xFFu, 1u, TRACE_MOST);
    let greatest = (cursor.w & TRACE_GREATEST) != 0u;
    var value = MISSING;
    var best = 0.0;
    for (var i = 0u; i < count; i++) {
        let bits = word(cursor.z + i * per + base.z);
        let v = bitcast<f32>(bits);
        let below = v < best;
        let above = v > best;
        let better = missing_bits(value) | select(below, above, greatest);
        let takes = !missing_bits(bits) & better;
        value = select(value, bits, takes);
        best = select(best, v, takes);
    }
    let missing = (point >= base.y) | (cursor.z == NONE) | (base.z >= per);
    return select(vec3u(cursor.xy, value), vec3u(0u, 0u, MISSING), missing);
}

fn trace_sample(row: u32, point: u32) -> vec3u {
    return trace_read(trace_cursor(row), point);
}

// Adjacent segment endpoints share the descriptor and header lookup.
fn trace_pair(row: u32, point: u32) -> array<vec3u, 2> {
    let base = trace_cursor(row);
    return array<vec3u, 2>(trace_read(base, point), trace_read(base, point + 1u));
}

// The points before, at the ends of, and after segment `point`, sharing one lookup. Before the first
// point the index wraps past the plan and reads missing.
fn trace_around(row: u32, point: u32) -> array<vec3u, 4> {
    let base = trace_cursor(row);
    return array<vec3u, 4>(
        trace_read(base, point - 1u),
        trace_read(base, point),
        trace_read(base, point + 1u),
        trace_read(base, point + 2u)
    );
}
