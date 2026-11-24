// Places along strokes. Each of a stroke mark's markers sits at a place along each row's path,
// turned to run along it, and the stroke stops at its box and goes on after it. A row's color goes
// from its first to its second where its mark's `blend` says (`blend_on`).
//
// A marker's place comes from its segment's record (`lib/screen.wesl`), which says whether the
// segment is its path's first or last and how long the path is. The rows' draw, which parts the
// stroke under each marker, and each marker's own draw, which places it, both call `along`, so
// they agree.
//
// The mark's uniform describes its markers, in two texels each (`mark.markers`, see the `ALONG_`
// words in `lib/types.wesl`), so a marker whose options are the same for every row reads nothing
// but its segment's record. A marker's draw binds a copy of the uniform that describes it first.

import package::lib::types::{
    VISIBLE, ALONG_UNITS, ALONG_PRESENT, ALONG_START, ALONG_END, ALONG_AT_ROW, ALONG_SIZE_ROW, ALONG_VISIBLE_ROW,
    ALONG_SIZE_UNITS, ALONG_OFFSET_UNITS, ALONG_OFFSET_ROW, ALONG_VISIBLE_SHIFT, STROKE_BLENDED, BLEND_FROM_ROW,
    BLEND_TO_ROW,
};
import package::lib::bind::{mark, word};
import package::lib::state::row_at;
import package::lib::mark::px_per_length;
import package::lib::screen::ScreenStroke;

// Where a marker sits on a segment: how far along the segment its center lies and half its length,
// both as fractions of the segment from `a` to `b`, its size in CSS pixels, and whether it sits on
// this segment at all.
struct Along {
    shown: bool,
    at: f32,
    half: f32,
    size: f32,
}

// `stored`, or where `from_row` says, the word of row `row` that it names.
fn along_word(stored: u32, row: u32, from_row: bool) -> u32 {
    if from_row {
        return word(row_at(row) + stored);
    }
    return stored;
}

// The distances along that a fraction of segment `s`'s path runs between, in the unit its distances
// along are in: on a path of one segment, those of its drawn part, and on a longer one, 0 and the
// path's length, which its record keeps in CSS pixels.
fn along_range(s: ScreenStroke) -> vec2f {
    let total = s.total / select(1.0, px_per_length(), (mark.flags & ALONG_UNITS) != 0u);
    return select(vec2f(0.0, total), s.along, vec2<bool>(s.first & s.last));
}

// Where the color of segment `s`'s row goes from its first to its second, on this segment: the
// middle of the change as a fraction of the segment, and one over how much of the segment it takes,
// at least a pixel of it, so a change at one place is a sharp edge. The mark's `blend` gives where
// the change starts and ends, as fractions of the path, as a marker's place is. Without one, the
// segment's colors are those at its two ends, and blend from one to the other.
fn blend_on(s: ScreenStroke) -> vec2f {
    if (mark.flags & STROKE_BLENDED) == 0u {
        return vec2f(0.5, 1.0);
    }
    let starts = bitcast<f32>(along_word(mark.blend_from, s.row, (mark.flags & BLEND_FROM_ROW) != 0u));
    let ends = bitcast<f32>(along_word(mark.blend_to, s.row, (mark.flags & BLEND_TO_ROW) != 0u));
    let range = along_range(s);
    let span = max(s.along.y - s.along.x, 1e-12);
    let change = (range.x + clamp(vec2f(starts, ends), vec2f(0.0), vec2f(1.0)) * (range.y - range.x) - s.along.x) / span;
    let pixel = 1.0 / max(length(s.b - s.a), 1e-6);
    return vec2f(0.5 * (change.x + change.y), 1.0 / max(change.y - change.x, pixel));
}

// How much of a row's second color shows `t` of the way along a segment whose change is `blend`.
fn blend_weight(blend: vec2f, t: f32) -> f32 {
    return saturate((t - blend.x) * blend.y + 0.5);
}

// Where marker `k` of the mark's sits on segment `s`.
//
// A marker sits a fraction of the way along the path: on a path of one segment, of its drawn part,
// and on a longer one, of its length between its first and last points. It then moves by its
// offset. The segment that place falls on carries the marker, wholly: it slides along the segment
// to fit, so no bend lies under it, and on a segment shorter than itself it sits at the middle. At
// the start its near edge sits on the start, and at the end its far edge on the end. So one at the
// start or the end of every row reads only its own segment, the path's first or last, and its mark
// measures no path. A segment too short to point anywhere carries none.
fn along(k: u32, s: ScreenStroke) -> Along {
    var out: Along;
    let placed = mark.markers[2u * k];
    let flags = placed.x;
    // The segment's length in the unit distances along are in, and in CSS pixels.
    let span = s.along.y - s.along.x;
    let pixels = length(s.b - s.a);
    if ((flags & ALONG_PRESENT) == 0u) | !s.shown | !(span > 0.0) | (pixels < 0.5) {
        return out;
    }
    if (flags & ALONG_VISIBLE_ROW) != 0u {
        if (word(row_at(s.row) + (flags >> ALONG_VISIBLE_SHIFT)) & VISIBLE) == 0u {
            return out;
        }
    }
    let scale = pixels / span;
    let units = px_per_length();
    let given = bitcast<f32>(along_word(placed.w, s.row, (flags & ALONG_SIZE_ROW) != 0u));
    let bounds = bitcast<vec2f>(mark.markers[2u * k + 1u].yz);
    let size = clamp(select(given, given * units, (flags & ALONG_SIZE_UNITS) != 0u), bounds.x, bounds.y);
    let moved = bitcast<f32>(along_word(placed.z, s.row, (flags & ALONG_OFFSET_ROW) != 0u));
    let offset = moved * select(1.0, units, (flags & ALONG_OFFSET_UNITS) != 0u) / scale;
    let half = 0.5 * size / scale;
    let fraction = bitcast<f32>(along_word(placed.y, s.row, (flags & ALONG_AT_ROW) != 0u));
    let starts = (flags & ALONG_START) != 0u;
    let ends = (flags & ALONG_END) != 0u;
    let single = s.first & s.last;
    let range = along_range(s);
    var center = range.x + clamp(fraction, 0.0, 1.0) * (range.y - range.x);
    center = select(center, s.along.x + half, starts);
    center = select(center, s.along.y - half, ends) + offset;
    // The segment a place past the path's end falls on: the last of the path, or for a marker at
    // the end, of each of its parts. A record keeps a path's length within a tenth of a percent.
    let closes = s.last & (single | ends | (s.along.y >= 0.999 * range.y));
    let on = (s.first | (center >= s.along.x)) & (closes | (center < s.along.y));
    // Wholly on this segment, and on a segment shorter than it, at the segment's middle.
    let fits = min(half, 0.5 * span);
    center = clamp(center, s.along.x + fits, s.along.y - fits);
    out.shown = on & (!starts | s.first) & (!ends | s.last) & (size > 0.0);
    out.at = (center - s.along.x) / span;
    out.half = half / span;
    out.size = size;
    return out;
}
