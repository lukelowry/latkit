// Label placement storage. Each labeled row's candidate lives in pages listed by the page table at
// `mark.candidates`. The labels buffer holds each mark's requested and shown text codes, run table,
// and the select that caps its labels, plus the grid of screen cells that labels claim.

import package::lib::types::{CANDIDATE_WORDS, WANTED};
import package::lib::bind::{mark, pages};
import package::lib::state::record_at;

@group(2) @binding(13) var<storage, read_write> labels: array<atomic<u32>>;

fn label_word(at: u32) -> u32 {
    return atomicLoad(&labels[at]);
}

fn put_label(at: u32, value: u32) {
    atomicStore(&labels[at], value);
}

// Where held row `row`'s candidate starts among the pages.
fn candidate(row: u32) -> u32 {
    return record_at(mark.candidates, CANDIDATE_WORDS, row);
}

// Writes word `at` of the pages, such as a candidate word.
fn put(at: u32, value: u32) {
    pages[at] = value;
}

// Asks the host to set the text of `code`.
fn want(code: u32) {
    let asked = atomicAdd(&labels[mark.wanted], 1u);
    if asked < WANTED {
        put_label(mark.wanted + 1u + asked, code);
    }
}

// Marks the text of `code` as shown, so the atlas keeps it.
fn seen(code: u32) {
    atomicOr(&labels[mark.seen + code / 32u], 1u << (code % 32u));
}
