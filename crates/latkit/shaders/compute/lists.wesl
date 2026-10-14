// The scan of a list: each block of 256 counts scans in its workgroup and leaves its total, one
// workgroup scans the totals, and every count adds its block's offset. Counts become where each
// item's entries start, the total follows them, and the header's indirect arguments take the
// entries the list keeps. Each count is held to its share of a u32, so the total never wraps.
// Reduce-then-scan needs no forward progress between workgroups, so it is safe on every device.

import package::lib::bind::mark;
import package::lib::types::{
    LIST_ITEMS, LIST_COUNTS, LIST_SUMS, LIST_ENTRIES, LIST_DRAW, LIST_DISPATCH, LIST_KEPT, PATH_TRACE, TRIANGLES,
};
import package::lib::lists::{lists, list_start};
import package::lib::path::{row_segments, path_point, path_length, PATH};

var<workgroup> tile: array<u32, 256>;
var<workgroup> shared_items: u32;

// The list this dispatch scans: the one the mark's query builds, or the mark's own.
@if(query)
fn header() -> u32 {
    return mark.query;
}

@if(!query)
fn header() -> u32 {
    return mark.list;
}

// Inclusive scan of `tile` across the workgroup.
fn scan_tile(local: u32) {
    for (var d = 1u; d < 256u; d *= 2u) {
        let before = select(0u, tile[max(local, d) - d], local >= d);
        workgroupBarrier();
        tile[local] += before;
        workgroupBarrier();
    }
}

@compute @workgroup_size(256)
fn scan_blocks(@builtin(local_invocation_id) l: vec3u, @builtin(workgroup_id) g: vec3u) {
    let h = header();
    let n = lists[h + LIST_ITEMS];
    let counts = lists[h + LIST_COUNTS];
    let i = g.x * 256u + l.x;
    // Whatever the counts, the starts climb, so every item's writes end.
    let share = 0xffffffffu / max(n, 1u);
    let own = select(0u, min(lists[counts + min(i, max(n, 1u) - 1u)], share), i < n);
    tile[l.x] = own;
    workgroupBarrier();
    scan_tile(l.x);
    if i < n {
        lists[counts + i] = tile[l.x] - own;
    }
    if l.x == 255u {
        lists[lists[h + LIST_SUMS] + g.x] = tile[255];
    }
}

@compute @workgroup_size(256)
fn scan_sums(@builtin(local_invocation_id) l: vec3u) {
    let h = header();
    if l.x == 0u {
        shared_items = lists[h + LIST_ITEMS];
    }
    let n = workgroupUniformLoad(&shared_items);
    let sums = lists[h + LIST_SUMS];
    let blocks = (n + 255u) / 256u;
    var carry = 0u;
    for (var start = 0u; start < blocks; start += 256u) {
        let i = start + l.x;
        let own = select(0u, lists[sums + min(i, max(blocks, 1u) - 1u)], i < blocks);
        tile[l.x] = own;
        workgroupBarrier();
        scan_tile(l.x);
        if i < blocks {
            lists[sums + i] = tile[l.x] - own + carry;
        }
        carry += tile[255];
        workgroupBarrier();
    }
    if l.x == 0u {
        lists[lists[h + LIST_COUNTS] + n] = carry;
        let kept = min(carry, lists[h + LIST_KEPT]);
        lists[h + LIST_DRAW + 1u] = kept;
        lists[h + LIST_DISPATCH] = (kept + 255u) / 256u;
    }
}

@compute @workgroup_size(256)
fn add_sums(@builtin(global_invocation_id) id: vec3u) {
    let h = header();
    if id.x < lists[h + LIST_ITEMS] {
        let counts = lists[h + LIST_COUNTS];
        lists[counts + id.x] += lists[lists[h + LIST_SUMS] + id.x / 256u];
    }
}

// A mark's segments, numbered by its list: each row counts the segments of its path, then writes
// its row at each of their places, with how far along its path each starts, so a segment's instance
// finds its row, its index in it, and where dashes and comets stand at its start.
@if(!query)
@compute @workgroup_size(256)
fn count_segments(@builtin(global_invocation_id) id: vec3u) {
    if id.x < lists[mark.list + LIST_ITEMS] {
        lists[lists[mark.list + LIST_COUNTS] + id.x] = row_segments(id.x);
    }
}

@if(!query)
@compute @workgroup_size(256)
fn write_segments(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= lists[mark.list + LIST_ITEMS] {
        return;
    }
    let at = list_start(mark.list, id.x);
    let end = list_start(mark.list, id.x + 1u);
    let entries = lists[mark.list + LIST_ENTRIES];
    // An area's triangles have no distance along.
    let measured = mark.primitive != TRIANGLES && PATH != PATH_TRACE;
    var along = 0.0;
    var last = path_point(id.x, 0u);
    for (var k = at; k < end; k++) {
        lists[entries + 2u * k] = id.x;
        lists[entries + 2u * k + 1u] = bitcast<u32>(along);
        if measured {
            let next = path_point(id.x, k - at + 1u);
            along += select(0.0, path_length(last, next), last.shown && next.shown);
            last = next;
        }
    }
}
