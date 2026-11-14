// Visible trace points are planned once on the CPU. Each row block holds a ring of aligned records:
// coordinate high/low, absolute value address, and rows in that value's page. A missing address
// breaks the line. Drawing, picking, and bounds all read this same plan.
import package::lib::types::{NONE, MISSING};
import package::lib::bind::{program_words, mark, word};
import package::lib::words::word_quad;
import package::lib::read::page_of;

// The row block's records, point count, and row within each value page.
fn trace_cursor(row: u32) -> vec3u {
    let at = page_of(row);
    return vec3u(mark.trace + 4u * at.x * mark.trace_capacity, select(0u, mark.trace_points, at.x < mark.trace_rows), at.y);
}

// Coordinate high/low and value bits; a missing value represents a hidden point.
// Both words are read whatever the point, and a point past the plan or without a value selects
// missing (see `lib/read.wesl`).
fn trace_read(base: vec3u, point: u32) -> vec3u {
    let slot = (mark.trace_head + point) & (mark.trace_capacity - 1u);
    let cursor = word_quad(program_words, base.x + 4u * slot);
    let value = word(cursor.z + base.z);
    let missing = (point >= base.y) | (cursor.z == NONE) | (base.z >= cursor.w);
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
