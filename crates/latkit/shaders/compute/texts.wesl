// The labels that show, and the texts they need. `claim` writes each labeled row's key into the
// grid cells its label covers. Each cell keeps the largest key. `texts` then asks the host to set
// the text of each label that is not crowded out, when the atlas lacks the text and the label's
// anchor is near the view (and, in a diagram, its text is large enough to read). It also marks a
// set text in view as seen, so the atlas keeps it. Rows whose tile is leaving claim nothing.
// `draw/glyphs.wesl` decides from the same claims whether each label shows. Each pipeline is made
// for one primitive and compiles only that primitive's anchors.

import package::lib::types::{NONE, VISIBLE, LABEL_CODE, WANTED, item};
import package::lib::bind::{eye, mark, word};
import package::lib::state::{row_at, extra_at};
import package::lib::read::missing_bits;
import package::lib::label::{
    Anchor, Chars, anchor, label_chars, char_at, run_size, length_px, legibility, in_view, claims_room, claim_key,
    claimed, cells_of, cell, Cells,
};
import package::lib::drawn::drawn_row;

// Each labeled mark's words: its run table, read here, and the codes it asks for and has seen,
// written atomically by every row.
@group(2) @binding(13) var<storage, read_write> labels: array<atomic<u32>>;
// The claim grid, cleared before `claim` runs.
@group(2) @binding(14) var<storage, read_write> cells: array<atomic<u32>>;

// The run table entry of `code`: its atlas corners, both 0 until its text is set, and NONE when it
// draws nothing.
fn run(code: u32) -> vec2u {
    let at = mark.runs + 2u * code;
    return vec2u(atomicLoad(&labels[at]), atomicLoad(&labels[at + 1u]));
}

// A labeled row as the texts passes see it: whether it has a label to show, its anchor, its texts,
// whether all are set, and the size of those that are.
struct Labeled {
    shows: bool,
    a: Anchor,
    chars: Chars,
    ready: bool,
    extent: vec2f,
}

fn labeled(i: u32) -> Labeled {
    var l: Labeled;
    l.a = anchor(i);
    let drawn = drawn_row(i);
    let bits = word(extra_at(drawn.row, mark.label + LABEL_CODE));
    let flags = word(row_at(drawn.row) + mark.stride - 1u);
    if missing_bits(bits) || (flags & VISIBLE) == 0u || drawn.leaving || !l.a.shown {
        return l;
    }
    l.chars = label_chars(bits);
    l.ready = true;
    let size = length_px(mark.label_size);
    for (var k = 0u; k < l.chars.count; k++) {
        let corners = run(char_at(l.chars, k));
        l.ready = l.ready && any(corners != vec2u(0u));
        // A text that draws nothing, such as an empty one, gives no label.
        l.shows = l.shows || corners.x != NONE;
        let s = run_size(corners, size);
        l.extent = vec2f(l.extent.x + s.x, max(l.extent.y, s.y));
    }
    return l;
}

// Whether claim `key` kept every cell of `c`.
fn keeps(c: Cells, key: u32) -> bool {
    for (var y = c.first.y; y <= c.last.y; y++) {
        for (var x = c.first.x; x <= c.last.x; x++) {
            if atomicLoad(&cells[cell(c, x, y)]) != key {
                return false;
            }
        }
    }
    return true;
}

// Asks the host to set the text of `code`, once however many rows show it. A text is either set or
// not for the whole pass, so the seen bit of a text not set marks it asked for.
fn want(code: u32) {
    let bit = 1u << (code % 32u);
    if (atomicOr(&labels[mark.seen + code / 32u], bit) & bit) != 0u {
        return;
    }
    let asked = atomicAdd(&labels[mark.wanted], 1u);
    if asked < WANTED {
        atomicStore(&labels[mark.wanted + 1u + asked], code);
    }
}

// Marks the text of `code` as shown, so the atlas keeps it.
fn seen(code: u32) {
    atomicOr(&labels[mark.seen + code / 32u], 1u << (code % 32u));
}

@compute @workgroup_size(256)
fn claim(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.rows {
        return;
    }
    let l = labeled(i);
    if !l.shows || !claims_room(l.a) {
        return;
    }
    let c = cells_of(claimed(l.a, l.ready, l.extent, length_px(mark.label_size)));
    let key = claim_key(i);
    for (var y = c.first.y; y <= c.last.y; y++) {
        for (var x = c.first.x; x <= c.last.x; x++) {
            atomicMax(&cells[cell(c, x, y)], key);
        }
    }
}

@compute @workgroup_size(256)
fn texts(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.rows {
        return;
    }
    let l = labeled(i);
    if !l.shows {
        return;
    }
    let size = length_px(mark.label_size);
    let t = claimed(l.a, l.ready, l.extent, size);
    let kept = !claims_room(l.a) || keeps(cells_of(t), claim_key(i));
    if !l.ready {
        // The atlas lacks some of its texts. Ask for them if the label could show soon: legible and
        // near the view, and keeping its room unless its texts are a number's characters, which
        // every row shares.
        let near = 0.25 * eye.size;
        if (kept || mark.number != NONE) && legibility(size) > 0.0 && in_view(l.a.at - near, l.a.at + near) {
            for (var k = 0u; k < l.chars.count; k++) {
                let code = char_at(l.chars, k);
                if all(run(code) == vec2u(0u)) {
                    want(code);
                }
            }
        }
        return;
    }
    if kept && in_view(t.lo, t.hi) {
        for (var k = 0u; k < l.chars.count; k++) {
            seen(char_at(l.chars, k));
        }
    }
}
