// The first step of label placement. It measures each labeled row's label box at its anchor, from
// its text's size (as set, or as measured until it is set). Each label gets a key: its priority,
// then whether it was placed in the previous frame, then its id. A label that arrives later still
// displaces lower-priority ones, and among equals, labels already shown keep their place.
// `compute/labels.wesl` places them. Each pipeline is made for one primitive and compiles only that
// primitive's anchors. A diagram's labels scale with its sheet and need no placement, so only this
// step runs there, to request the texts of labels in view.

import package::lib::types::{
    VISIBLE, LABEL_CODE, LABEL_PRIORITY, CANDIDATE_BOX, CANDIDATE_KEY, CANDIDATE_STATE, WANTS, PLACED_LABEL,
    STICKY, UNSET, TEXT_UNSET, SPACE_DIAGRAM, item,
};
import package::lib::bind::{frame, eye, mark, word};
import package::lib::state::{row_at, extra_at};
import package::lib::read::missing_bits;
import package::lib::label::{anchor, length_px, legibility, text_at, fits, in_view};
import package::lib::placement::{label_word, put, candidate, want, seen};
import package::lib::drawn::drawn_row;

@compute @workgroup_size(256)
fn candidates(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.rows {
        return;
    }
    let drawn = drawn_row(i);
    let row = drawn.row;
    let at = candidate(row);
    let before = word(at + CANDIDATE_STATE);
    let sticky = (before & PLACED_LABEL) != 0u;
    let code_bits = word(extra_at(row, mark.label + LABEL_CODE));
    var next = select(0u, STICKY, sticky);
    let flags = word(row_at(row) + mark.stride - 1u);
    // A row whose tile is leaving gets no label.
    if missing_bits(code_bits) || (flags & VISIBLE) == 0u || drawn.leaving {
        put(at + CANDIDATE_STATE, next);
        return;
    }
    let code = u32(bitcast<f32>(code_bits));
    let uv0 = label_word(mark.runs + 2u * code);
    let uv1 = label_word(mark.runs + 2u * code + 1u);
    let a = anchor(i);
    let size = length_px(mark.label_size);
    let diagram = frame.space == SPACE_DIAGRAM;
    let unset = (uv0 & TEXT_UNSET) != 0u;
    if (uv0 == 0u && uv1 == 0u) || (unset && diagram) {
        // The atlas lacks this text, and the label cannot wait for placement to request it. Request
        // it now if the label could show: legible and near the view.
        let near = 0.25 * eye.size;
        if a.shown && legibility(size) > 0.0 && in_view(a.at - near, a.at + near) {
            want(code);
        }
        put(at + CANDIDATE_STATE, next);
        return;
    }
    if unset {
        next |= UNSET;
    }
    let t = text_at(uv0 & ~TEXT_UNSET, uv1, size, a.at, a.align);
    if a.shown && in_view(t.lo, t.hi) {
        // A diagram marks every label in view as seen here; elsewhere `ask` marks placed ones.
        if diagram {
            seen(code);
        }
        if fits(t.hi - t.lo, a.room) {
            next |= WANTS;
        }
    }
    put(at + CANDIDATE_BOX, bitcast<u32>(t.lo.x));
    put(at + CANDIDATE_BOX + 1u, bitcast<u32>(t.lo.y));
    put(at + CANDIDATE_BOX + 2u, bitcast<u32>(t.hi.x));
    put(at + CANDIDATE_BOX + 3u, bitcast<u32>(t.hi.y));
    let level = u32(clamp(bitcast<f32>(word(extra_at(row, mark.label + LABEL_PRIORITY))), 0.0, 255.0));
    let id_bits = (mark.label_id + row + 1u) & 0x7fffffu;
    put(at + CANDIDATE_KEY, ((255u - level) << 24u) | select(0x800000u, 0u, sticky) | id_bits);
    put(at + CANDIDATE_STATE, next);
}
