// The scan of a list. Each block of 256 counts is scanned in its workgroup, which writes the
// block's total. One workgroup then scans the totals, and every count adds its block's offset. The
// counts become each item's first entry, followed by the total, and the header's indirect arguments
// get the number of entries the list keeps. Each count is capped at its share of a u32, so the
// total never wraps. Reduce-then-scan needs no forward-progress guarantee between workgroups, so it
// is safe on every device.

import package::lib::bind::{mark, program};
import package::lib::types::{
    LIST_ITEMS, LIST_COUNTS, LIST_SUMS, LIST_ENTRIES, LIST_DRAW, LIST_DISPATCH, LIST_KEPT, PATH_TRACE, TRIANGLES,
    DISPATCH_ROWS, RUN_WORDS, FADE_IN, FADE_OUT, DRAWN_ENTERING, DRAWN_LEAVING, item,
};
import package::lib::lists::{lists, list_start};
import package::lib::path::{row_segments, path_point, path_length, PATH};
import package::lib::drawn::held_row;

var<workgroup> tile: array<u32, 256>;
var<workgroup> shared_items: u32;

// The list this dispatch scans: the current mark's.
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
    // Beyond one dimension's workgroups, each step along the second covers `DISPATCH_ROWS` items.
    let block = g.y * (DISPATCH_ROWS / 256u) + g.x;
    let i = block * 256u + l.x;
    // Capping each count at its share keeps the starts increasing for any counts, so every item's
    // write loop ends.
    let share = 0xffffffffu / max(n, 1u);
    let own = select(0u, min(lists[counts + min(i, max(n, 1u) - 1u)], share), i < n);
    tile[l.x] = own;
    workgroupBarrier();
    scan_tile(l.x);
    if i < n {
        lists[counts + i] = tile[l.x] - own;
    }
    if l.x == 255u {
        lists[lists[h + LIST_SUMS] + block] = tile[255];
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
    let i = item(id);
    let h = header();
    if i < lists[h + LIST_ITEMS] {
        let counts = lists[h + LIST_COUNTS];
        lists[counts + i] += lists[lists[h + LIST_SUMS] + i / 256u];
    }
}

// Writes each drawn row's word from the program's run list: its held row, found in the last run
// starting at or before it, and whether that run's tile fades in or out. Every pass that draws or
// probes the mark reads this one word. It runs when the runs change.
@compute @workgroup_size(256)
fn expand_runs(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.rows + mark.exits {
        return;
    }
    var lo = 0u;
    var hi = max(program[mark.row_runs], 1u);
    while hi - lo > 1u {
        let mid = (lo + hi) / 2u;
        if program[mark.row_runs + 1u + mid * RUN_WORDS] <= i {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let run = mark.row_runs + 1u + lo * RUN_WORDS;
    let fade = program[run + 2u];
    let entering = select(0u, DRAWN_ENTERING, (fade & FADE_IN) != 0u);
    let leaving = select(0u, DRAWN_LEAVING, (fade & FADE_OUT) != 0u);
    lists[mark.drawn + i] = (program[run + 1u] + (i - program[run])) | entering | leaving;
}

// A mark's segment list. `count_segments` counts each drawn row's segments. After the scan,
// `write_segments` writes each segment's drawn row and its distance along the path, so a segment
// instance finds its row, its index in the row, and where dashes and comets are at its start.
@compute @workgroup_size(256)
fn count_segments(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i < lists[mark.list + LIST_ITEMS] {
        lists[lists[mark.list + LIST_COUNTS] + i] = row_segments(held_row(i));
    }
}

@compute @workgroup_size(256)
fn write_segments(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= lists[mark.list + LIST_ITEMS] {
        return;
    }
    let at = list_start(mark.list, i);
    let end = list_start(mark.list, i + 1u);
    let entries = lists[mark.list + LIST_ENTRIES];
    // An area's triangles and a trace's segments have no distance along.
    let measured = mark.primitive != TRIANGLES && PATH != PATH_TRACE;
    var along = 0.0;
    let row = held_row(i);
    var last = path_point(row, end - at, 0u);
    for (var k = at; k < end; k++) {
        lists[entries + 2u * k] = i;
        lists[entries + 2u * k + 1u] = bitcast<u32>(along);
        if measured {
            let next = path_point(row, end - at, k - at + 1u);
            along += select(0.0, path_length(last, next), last.shown && next.shown);
            last = next;
        }
    }
}
