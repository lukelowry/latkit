// The first step of label placement: each labeled row's label measured where its anchor puts it, by
// the size of its text, or an estimate of it while the text is not set, and keyed by its priority,
// then whether it showed before, then its id: a label that arrives later still displaces lesser
// ones, and among equals those shown keep their place. `compute/labels.wesl` places them. Made for
// one primitive, it holds only that one's anchors. A diagram's labels scale with its sheet, so they
// need no placement: only this step runs there, to ask for the texts of labels in view.

import package::lib::types::{
    VISIBLE, LABEL_CODE, LABEL_PRIORITY, CANDIDATE_BOX, CANDIDATE_KEY, CANDIDATE_STATE, WANTS, PLACED_LABEL,
    STICKY, ESTIMATED, TEXT_ESTIMATE, SPACE_DIAGRAM, item,
};
import package::lib::bind::{frame, eye, mark, state};
import package::lib::state::extra_at;
import package::lib::read::missing_bits;
import package::lib::label::{anchor, length_px, legibility, text_at, fits, in_view};
import package::lib::placement::{word, put, candidate, want, seen};

@compute @workgroup_size(256)
fn candidates(@builtin(global_invocation_id) id: vec3u) {
    let row = item(id);
    if row >= mark.rows {
        return;
    }
    let at = candidate(row);
    let before = word(at + CANDIDATE_STATE);
    let sticky = (before & PLACED_LABEL) != 0u;
    let code_bits = state[extra_at(row, mark.label + LABEL_CODE)];
    var next = select(0u, STICKY, sticky);
    if missing_bits(code_bits) || (state[mark.state + row * mark.stride + mark.stride - 1u] & VISIBLE) == 0u {
        put(at + CANDIDATE_STATE, next);
        return;
    }
    let code = u32(bitcast<f32>(code_bits));
    let uv0 = word(mark.runs + 2u * code);
    let uv1 = word(mark.runs + 2u * code + 1u);
    let a = anchor(row);
    let size = length_px(mark.label_size);
    let diagram = frame.space == SPACE_DIAGRAM;
    let estimated = (uv0 & TEXT_ESTIMATE) != 0u;
    if (uv0 == 0u && uv1 == 0u) || (estimated && diagram) {
        // The atlas lacks this text, and the label cannot wait for placement to ask for it: ask now,
        // if it could show, legible and near the view.
        let near = 0.25 * eye.size;
        if a.shown && legibility(size) > 0.0 && in_view(a.at - near, a.at + near) {
            want(code);
        }
        put(at + CANDIDATE_STATE, next);
        return;
    }
    if estimated {
        next |= ESTIMATED;
    }
    let t = text_at(uv0 & ~TEXT_ESTIMATE, uv1, size, a.at, a.align);
    if a.shown && in_view(t.lo, t.hi) {
        // A diagram shows every label in view that fits; elsewhere `ask` notes those placed.
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
    let level = u32(clamp(bitcast<f32>(state[extra_at(row, mark.label + LABEL_PRIORITY)]), 0.0, 255.0));
    let id_bits = (mark.label_id + row + 1u) & 0x7fffffu;
    put(at + CANDIDATE_KEY, ((255u - level) << 24u) | select(0x800000u, 0u, sticky) | id_bits);
    put(at + CANDIDATE_STATE, next);
}
