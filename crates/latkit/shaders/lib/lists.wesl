// Lists: per-item counts, then entries. A scan turns the counts in place into each item's first
// entry.

import package::lib::types::{LIST_ITEMS, LIST_COUNTS, LIST_ENTRIES, LIST_KEPT};
import package::lib::words::{word_read, word_quad};

@group(2) @binding(9) var list_words: texture_2d_array<u32>;
fn list(at: u32) -> u32 { return word_read(list_words, at); }

// Where the counts of the list at `header` start.
fn list_counts(header: u32) -> u32 {
    return list(header + LIST_COUNTS);
}

// Where entry `i` of the list at `header` lies.
fn list_entry(header: u32, i: u32) -> u32 {
    return list(header + LIST_ENTRIES) + i;
}

// Where item `i`'s entries start among those the list at `header` keeps. When the items counted
// more entries than the list keeps, the starts scale down in proportion, so every item keeps a
// share of its entries instead of the last items losing all of theirs.
fn list_start(header: u32, i: u32) -> u32 {
    let h = word_quad(list_words, header);
    let counts = h[LIST_COUNTS];
    let total = list(counts + h[LIST_ITEMS]);
    let kept = h[LIST_KEPT];
    let start = list(counts + i);
    if total <= kept {
        return start;
    }
    return min(u32(f32(start) * (f32(kept) / f32(total))), kept);
}

// Entries the list at `header` keeps.
fn list_total(header: u32) -> u32 {
    let h = word_quad(list_words, header);
    return min(list(h[LIST_COUNTS] + h[LIST_ITEMS]), h[LIST_KEPT]);
}
