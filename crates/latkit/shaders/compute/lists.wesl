// The scan of a list. Each block of 256 counts is scanned in its workgroup, which writes the
// block's total. One workgroup then scans the totals, and every count adds its block's offset. The
// counts become each item's first entry, followed by the total, and the header's indirect arguments
// get the number of entries the list keeps. Each count is capped at its share of a u32, so the
// total never wraps. Reduce-then-scan needs no forward-progress guarantee between workgroups, so it
// is safe on every device.
//
// A height order sorts a mark's instances by the height each stands at, lowest first, so where
// rows stand at different heights a nearer row blends over the rows behind it. Along any line of
// sight down onto the ground or the globe, a nearer point stands higher. So where two markers
// overlap, from any camera, the nearer one draws last, and a segment sorts by its middle. Rows at
// one height keep their order. `height_keys` keys and numbers the instances. Then each of `DIGITS`
// passes sorts by one digit of the keys, lowest first: `count_digits` counts each block's
// instances per digit, the scan turns the counts into where they go, and `scatter_digits` moves
// them there in order. The passes trade the instances between the order's two sides, ending in the
// first, which the draws read.

import package::lib::bind::{mark, program};
import package::lib::types::{
    NONE, LIST_ITEMS, LIST_COUNTS, LIST_SUMS, LIST_ENTRIES, LIST_DRAW, LIST_DISPATCH, LIST_KEPT, PATH_TRACE, TRIANGLES,
    POINTS, DISPATCH_ROWS, RUN_WORDS, FADE_IN, FADE_OUT, DRAWN_ENTERING, DRAWN_LEAVING, STEP_SEGMENTS, STEP_DIGITS,
    item,
};
import package::lib::lists::{lists, list_start, list_total};
import package::lib::read::last_at_most;
import package::lib::path::{row_segments, path_point, path_length, numbered_segment, segment_ends, PATH};
import package::lib::drawn::held_row;
import package::lib::state::{row_at, vertex_at};
import package::lib::reduce::ordered;

// Which step a dispatch takes: one of the `STEP_SEGMENTS` and `STEP_DIGITS` steps.
@group(2) @binding(17) var<uniform> step: u32;

var<workgroup> tile: array<u32, 256>;
var<workgroup> shared_items: u32;
// The instances of a block with each digit, as their counts, or as a bit per instance in eight
// words per digit.
var<workgroup> digit_counts: array<atomic<u32>, 256>;
var<workgroup> digit_bits: array<atomic<u32>, 2048>;

// The list this dispatch scans: the mark's segment list, or its height order's digit counts.
fn header() -> u32 {
    return select(mark.height_order, mark.list, step == STEP_SEGMENTS);
}

// The block of 256 items workgroup `g` takes. Beyond one dimension's workgroups, each step along
// the second covers `DISPATCH_ROWS` items.
fn block_of(g: vec3u) -> u32 {
    return g.y * (DISPATCH_ROWS / 256u) + g.x;
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
    let block = block_of(g);
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
    let run = last_at_most(mark.row_runs + 1u, max(program[mark.row_runs], 1u), RUN_WORDS, 0u, i);
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

// Instances the mark draws: its rows and exits, or every segment of their paths.
fn drawn_instances() -> u32 {
    if mark.primitive == POINTS {
        return mark.rows + mark.exits;
    }
    if mark.per_row != NONE {
        return (mark.rows + mark.exits) * mark.per_row;
    }
    return list_total(mark.list);
}

// The key that sorts instance `i` into the height order: the height it stands at, a point's
// elevation or the middle of a segment. Exits sort after the drawn rows, and entries past the
// instances after everything, so the instances at each position keep the ranges probes read.
fn instance_key(i: u32) -> u32 {
    if i >= drawn_instances() {
        return NONE;
    }
    if mark.primitive == POINTS {
        return height_key(vertex_at(row_at(held_row(i))).elevation, i >= mark.rows);
    }
    let s = numbered_segment(i);
    let ends = segment_ends(s);
    return height_key(0.5 * (ends[0].z + ends[1].z), s.item >= mark.rows);
}

// The key of an instance at `height` as ordered bits, after every drawn row's when its row `left`.
// Both zeros key alike.
fn height_key(height: f32, left: bool) -> u32 {
    return select(0u, 0x80000000u, left) | (ordered(select(height, 0.0, height == 0.0)) >> 1u);
}

// Where side `side` of the height order at `h` holds its instances (x) and their keys (y). The
// first side holds the order the draws read.
fn order_side(h: u32, side: u32) -> vec2u {
    let n = lists[h + LIST_KEPT];
    let at = lists[h + LIST_ENTRIES] + 2u * n * side;
    return vec2u(at, at + n);
}

// Digit `k` of `key`, from the lowest.
fn digit(key: u32, k: u32) -> u32 {
    return (key >> (8u * k)) & 255u;
}

// Numbers each instance of the mark's height order in its first side, with its key.
@compute @workgroup_size(256)
fn height_keys(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    let h = mark.height_order;
    if i >= lists[h + LIST_KEPT] {
        return;
    }
    let first = order_side(h, 0u);
    lists[first.x + i] = i;
    lists[first.y + i] = instance_key(i);
}

// Counts the instances of each block of the height order by this pass's digit. The counts are laid
// out digit by digit, so their scan gives where each digit's instances of each block go.
@compute @workgroup_size(256)
fn count_digits(@builtin(local_invocation_id) l: vec3u, @builtin(workgroup_id) g: vec3u) {
    let h = mark.height_order;
    let k = step - STEP_DIGITS;
    let block = block_of(g);
    let blocks = lists[h + LIST_ITEMS] / 256u;
    atomicStore(&digit_counts[l.x], 0u);
    workgroupBarrier();
    let i = block * 256u + l.x;
    if i < lists[h + LIST_KEPT] {
        atomicAdd(&digit_counts[digit(lists[order_side(h, k % 2u).y + i], k)], 1u);
    }
    workgroupBarrier();
    if block < blocks {
        lists[lists[h + LIST_COUNTS] + l.x * blocks + block] = atomicLoad(&digit_counts[l.x]);
    }
}

// Moves each instance of the height order, with its key, to the other side: where the scan put its
// digit's instances of its block, after those of its block before it with the same digit. So equal
// digits keep their order in each pass, and equal keys keep theirs through the sort.
@compute @workgroup_size(256)
fn scatter_digits(@builtin(local_invocation_id) l: vec3u, @builtin(workgroup_id) g: vec3u) {
    let h = mark.height_order;
    let k = step - STEP_DIGITS;
    let block = block_of(g);
    for (var w = 0u; w < 8u; w++) {
        atomicStore(&digit_bits[8u * l.x + w], 0u);
    }
    workgroupBarrier();
    let src = order_side(h, k % 2u);
    let i = block * 256u + l.x;
    let inside = i < lists[h + LIST_KEPT];
    var key = 0u;
    if inside {
        key = lists[src.y + i];
        atomicOr(&digit_bits[8u * digit(key, k) + l.x / 32u], 1u << (l.x % 32u));
    }
    workgroupBarrier();
    if !inside {
        return;
    }
    let d = digit(key, k);
    var before = countOneBits(atomicLoad(&digit_bits[8u * d + l.x / 32u]) & ((1u << (l.x % 32u)) - 1u));
    for (var w = 0u; w < l.x / 32u; w++) {
        before += countOneBits(atomicLoad(&digit_bits[8u * d + w]));
    }
    let blocks = lists[h + LIST_ITEMS] / 256u;
    let at = lists[lists[h + LIST_COUNTS] + d * blocks + block] + before;
    let dst = order_side(h, (k + 1u) % 2u);
    lists[dst.x + at] = lists[src.x + i];
    lists[dst.y + at] = key;
}
