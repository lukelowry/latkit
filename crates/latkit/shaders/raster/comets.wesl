// Comet slots: a flowing mark's comets draw draws a quad for each comet its segments' parts on the
// target can carry, so comets cost the pixels they cover, and a segment off the target costs nothing.
// The frame counts each segment's slots from its record (`comet_slots`), a scan turns the counts into
// where each segment's slots start, and each slot is written with its segment's record and which of
// its comets it draws. The draw then reads a slot an instance (`comet_slot`). The slots follow the
// records, so they are counted again only when what the records hold may have changed, never as
// comets only travel. These passes bind the copy of the mark's uniform for its comets draw, whose
// `list` is the slots'.
import package::lib::bind::mark;
import package::lib::types::{WordStep, NONE, LIST_ITEMS};
import package::lib::words::{word_index, fullscreen};
import package::lib::lists::{list, list_start, list_total};
import package::lib::screen::{draw_record, read_stroke, comet_slots};

@group(2) @binding(19) var<uniform> params: WordStep;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    return fullscreen(i);
}

fn index(position: vec4f) -> u32 {
    return word_index(position, params.layer) - params.destination;
}

// The slots of the mark's segment `i`, whose record follows its first, `params.source`.
fn count(i: u32) -> u32 {
    if i >= params.count {
        return 0u;
    }
    return comet_slots(read_stroke(draw_record(params.source + i, false)));
}

// Four segments' slot counts a texel.
@fragment
fn count_slots(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position);
    return vec4u(count(i), count(i + 1u), count(i + 2u), count(i + 3u));
}

// The segment owning slot `i`: the last whose slots start at or before it.
fn owner(i: u32) -> u32 {
    var lo = 0u;
    var hi = list(mark.list + LIST_ITEMS);
    while hi - lo > 1u {
        let mid = (lo + hi) / 2u;
        if list_start(mark.list, mid) <= i { lo = mid; } else { hi = mid; }
    }
    return lo;
}

// Slot `i`: its segment's record, and which of the segment's comets it draws.
fn slot(i: u32) -> vec2u {
    if i >= list_total(mark.list) {
        return vec2u(NONE, 0u);
    }
    let segment = owner(i);
    return vec2u(params.source + segment, i - list_start(mark.list, segment));
}

// Two slots a texel.
@fragment
fn slots(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let i = index(position) / 2u;
    return vec4u(slot(i), slot(i + 1u));
}
