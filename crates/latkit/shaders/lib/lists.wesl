// Lists: per-item counts, scanned in place to where each item's entries start, then the entries.

import package::lib::types::{LIST_COUNTS, LIST_ENTRIES, LIST_DRAW};

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

// Entries the list at `header` keeps.
fn list_total(header: u32) -> u32 {
    return lists[header + LIST_DRAW + 1u];
}
