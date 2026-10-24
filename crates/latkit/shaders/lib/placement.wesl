// What label placement works in: each labeled row's candidate, in pages the page table at
// `mark.candidates` lists; and the labels buffer, with the texts each mark asks the host to set and
// those its labels show, its run table, the select capping its labels, and the cells of the screen
// labels claim.

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

// Writes word `at` of the pages: a candidate's.
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

// Notes that a label shows the text of `code`, so the atlas keeps it.
fn seen(code: u32) {
    atomicOr(&labels[mark.seen + code / 32u], 1u << (code % 32u));
}
