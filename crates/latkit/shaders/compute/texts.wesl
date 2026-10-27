// The texts labels need. Each labeled row a mark draws, with a text code, while its row shows and
// its tile is not leaving, asks the host to set its text while the atlas lacks it and its anchor is
// near the view (and, in a diagram, its text is large enough to read), and marks a set text in view
// as seen, so the atlas keeps it. It writes nothing per row: `draw/glyphs.wesl` decides from the
// same anchor whether each label shows. Each pipeline is made for one primitive and compiles only
// that primitive's anchors.

import package::lib::types::{VISIBLE, LABEL_CODE, WANTED, item};
import package::lib::bind::{eye, mark, word};
import package::lib::state::{row_at, extra_at};
import package::lib::read::missing_bits;
import package::lib::label::{anchor, length_px, legibility, text_at, in_view};
import package::lib::drawn::drawn_row;

// Each labeled mark's words: its run table, read here, and the codes it asks for and has seen,
// written atomically by every row.
@group(2) @binding(13) var<storage, read_write> labels: array<atomic<u32>>;

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
fn texts(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.rows {
        return;
    }
    let drawn = drawn_row(i);
    let row = drawn.row;
    let code_bits = word(extra_at(row, mark.label + LABEL_CODE));
    let flags = word(row_at(row) + mark.stride - 1u);
    // A row whose tile is leaving needs no text.
    if missing_bits(code_bits) || (flags & VISIBLE) == 0u || drawn.leaving {
        return;
    }
    let a = anchor(i);
    if !a.shown {
        return;
    }
    let code = u32(bitcast<f32>(code_bits));
    let uv0 = atomicLoad(&labels[mark.runs + 2u * code]);
    let uv1 = atomicLoad(&labels[mark.runs + 2u * code + 1u]);
    let size = length_px(mark.label_size);
    if uv0 == 0u && uv1 == 0u {
        // The atlas lacks this text. Ask for it if the label could show soon: legible and near the
        // view.
        let near = 0.25 * eye.size;
        if legibility(size) > 0.0 && in_view(a.at - near, a.at + near) {
            want(code);
        }
        return;
    }
    let t = text_at(uv0, uv1, size, a.at, a.align);
    if in_view(t.lo, t.hi) {
        seen(code);
    }
}
