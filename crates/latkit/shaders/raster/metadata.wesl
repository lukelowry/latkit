// Label geometry is evaluated once per row, before scattering simple quads or text codes.
import package::lib::types::{WordStep, NONE, VISIBLE, LABEL_CODE};
import package::lib::bind::{eye, mark, word};
import package::lib::state::{row_at, extra_at};
import package::lib::read::missing_bits;
import package::lib::drawn::drawn_row;
import package::lib::label::{Anchor, Chars, anchor, label_chars, char_at, run_size, in_view, claims_room, claimed, cells_of, label_box, fits};
import package::lib::labels::run;
import package::lib::words::{word_index, fullscreen};
@group(2) @binding(19) var<uniform> params: WordStep;
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
    if missing_bits(bits) || (flags & VISIBLE) == 0u || !l.a.shown {
        return l;
    }
    l.chars = label_chars(bits);
    l.ready = true;
    let size = mark.label_size;
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


@vertex
fn vertex(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f { return fullscreen(v); }

struct Prepared { @location(0) metadata: vec4u, @location(1) position: vec4u }

@fragment
fn metadata(@builtin(position) p: vec4f) -> Prepared {
    var out: Prepared;
    let row = word_index(p, params.layer) / 4u;
    if row >= mark.rows { return out; }
    let l = labeled(row);
    if !l.shows { return out; }
    let t = claimed(l.a, l.ready, l.extent, mark.label_size);
    let c = cells_of(t);
    let valid = all(c.first <= c.last);
    let near = 0.25 * eye.size;
    let eligible = !drawn_row(row).leaving;
    let claim = claims_room(l.a) && valid && eligible;
    let ask = !l.ready && in_view(l.a.at - near, l.a.at + near) && eligible;
    let seen = l.ready && in_view(t.lo, t.hi) && eligible;
    let drawable = l.ready && fits(l.extent, l.a.room);
    let first = vec2u(max(c.first, vec2i(0)));
    let last = vec2u(max(c.last, vec2i(0)));
    out.metadata = vec4u(first.x | (first.y << 16u), last.x | (last.y << 16u), char_at(l.chars, 0u),
        u32(claim) | (u32(ask) << 1u) | (u32(seen) << 2u) | (u32(drawable) << 3u) | (u32(claims_room(l.a)) << 4u));
    out.position = vec4u(bitcast<vec2u>(label_box(l.a, l.extent).lo), 0u, 0u);
    return out;
}
