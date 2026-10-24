// Freezing: what each row of a mark showed when its transition began, gathered into its frozen words
// at the row's new place. The remap words at `mark.remap` say where the words it showed lie (the page
// table of its words before the change, copied into them), how many rows it showed, and where each new
// row was, NONE for a row that entered, then the rows that left, which fade out past the live ones;
// without that list every row is where it was. They say too, for each kind word naming a vertex, where
// the vertices of the vertex mark it names moved, so the ends of rows easing out follow them.

import package::lib::types::{NONE, ENTERING, PAGE_BITS, PAGE_MASK, item};
import package::lib::bind::{mark, pages};
import package::lib::state::record_at;

@group(2) @binding(12) var<storage, read> remap: array<u32>;

// The remap header's words: where the page table of the words shown starts, how many rows showed,
// where the row each new row was starts (NONE when every row is where it was), and where each kind
// word's vertex moves start (NONE when no vertex moved).
const REMAP_TABLE: u32 = 0u;
const REMAP_SHOWN: u32 = 1u;
const REMAP_SOURCES: u32 = 2u;
const REMAP_ENDS: u32 = 3u;

@compute @workgroup_size(256)
fn gather(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.held {
        return;
    }
    let header = mark.remap;
    let sources = remap[header + REMAP_SOURCES];
    var source = select(NONE, i, i < remap[header + REMAP_SHOWN]);
    if sources != NONE {
        source = remap[sources + i];
    }
    let words = mark.stride + mark.extras;
    let to = record_at(mark.frozen, words, i);
    let flags = mark.stride - 1u;
    if source == NONE {
        for (var w = 0u; w < words; w++) {
            pages[to + w] = select(0u, ENTERING, w == flags);
        }
        return;
    }
    let shown = remap[remap[header + REMAP_TABLE] + (source >> PAGE_BITS)] + (source & PAGE_MASK) * words;
    let ends = remap[header + REMAP_ENDS];
    for (var w = 0u; w < words; w++) {
        var word = pages[shown + w];
        // Each vertex's moves: how many rows it held, then where each went, NONE where it left.
        let moves = select(NONE, remap[ends + min(w, mark.stride - 1u)], ends != NONE && w < mark.stride);
        if moves != NONE && word != NONE {
            word = select(NONE, remap[moves + 1u + word], word < remap[moves]);
        }
        pages[to + w] = word;
    }
}
