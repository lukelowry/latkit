// The buffer label placement works in: each labeled mark's candidates, the texts it asks the host to
// set and those its labels show, and the cells of the screen labels claim.

import package::lib::types::{CANDIDATE_WORDS, WANTED};
import package::lib::bind::mark;

@group(2) @binding(13) var<storage, read_write> labels: array<atomic<u32>>;

fn word(at: u32) -> u32 {
    return atomicLoad(&labels[at]);
}

fn put(at: u32, value: u32) {
    atomicStore(&labels[at], value);
}

fn candidate(row: u32) -> u32 {
    return mark.candidates + row * CANDIDATE_WORDS;
}

// Asks the host to set the text of `code`.
fn want(code: u32) {
    let asked = atomicAdd(&labels[mark.wanted], 1u);
    if asked < WANTED {
        put(mark.wanted + 1u + asked, code);
    }
}

// Notes that a label shows the text of `code`, so the atlas keeps it.
fn seen(code: u32) {
    atomicOr(&labels[mark.seen + code / 32u], 1u << (code % 32u));
}
