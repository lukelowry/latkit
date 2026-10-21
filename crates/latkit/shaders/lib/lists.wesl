// Lists: per-item counts, scanned in place to where each item's entries start, then the entries.

import package::lib::types::{LIST_ITEMS, LIST_COUNTS, LIST_ENTRIES, LIST_DRAW, LIST_KEPT};

@if(lists)
@group(2) @binding(9) var<storage, read_write> lists: array<u32>;
@else
@group(2) @binding(9) var<storage, read> lists: array<u32>;

// Where the counts of the list at `header` start.
fn list_counts(header: u32) -> u32 {
    return lists[header + LIST_COUNTS];
}

// Where entry `i` of the list at `header` lies.
fn list_entry(header: u32, i: u32) -> u32 {
    return lists[header + LIST_ENTRIES] + i;
}

// Where item `i`'s entries start among those the list at `header` keeps: where it counted them, or,
// when the items counted more than the list keeps, as far in proportion, so every item keeps a share
// of its entries instead of the last items losing all of theirs.
fn list_start(header: u32, i: u32) -> u32 {
    let counts = lists[header + LIST_COUNTS];
    let total = lists[counts + lists[header + LIST_ITEMS]];
    let kept = lists[header + LIST_KEPT];
    let start = lists[counts + i];
    if total <= kept {
        return start;
    }
    return min(u32(f32(start) * (f32(kept) / f32(total))), kept);
}

// Entries the list at `header` keeps.
fn list_total(header: u32) -> u32 {
    return lists[header + LIST_DRAW + 1u];
}
