// Labels: where a labeled row's text is anchored, its size, the space it claims, and whether it can
// show. Draws place every label from its anchor each frame, so labels track the camera and their
// rows exactly. The label passes measure the same boxes to claim space and find the visible texts.
// Text is a distance field set at `TEXT_BASE` and drawn at any size: in CSS pixels, or in a diagram
// in length units. In a diagram, text scales with the sheet and fades out once too small to read.
// A label is a row of runs: a text label's one text, or the characters a number label writes.

import package::lib::types::{
    NONE, POINTS, MARKER_BLOCK, SIZED, GROUP, PATH_TRACE, TEXT_BASE, TEXT_SPREAD, HEADER_BAND, SPACE_DIAGRAM,
    LABEL_CELL, LABEL_MARGIN, LABEL_GUESS, NUMBER_CHARS, CHAR_POINT, CHAR_MINUS, CHAR_EXPONENT, CHAR_UNIT,
    FORMAT_AUTO, FORMAT_SCIENTIFIC, FORMAT_ENGINEERING, NUMBER_TRIM, NUMBER_UNIT,
};
import package::lib::bind::{frame, eye, mark};
import package::lib::mark::PRIMITIVE;
import package::lib::points::point;
import package::lib::path::PATH;
import package::lib::center::{row_center, point_center};
import package::lib::drawn::held_row;

// A label's anchor point in CSS pixels, its alignment there (0 left or top, 0.5 centered), the room
// it must fit in (no limit when zero), and whether its row shows.
struct Anchor {
    at: vec2f,
    align: vec2f,
    room: vec2f,
    shown: bool,
}

// A size in length units, in CSS pixels at this frame's zoom.
fn length_px(size: f32) -> f32 {
    return size * frame.unit;
}

// The label anchor of drawn row `item`: centered on the row's center, except beside a point's
// marker, inside a block or a sized marker, in a group's header band, and beside a trace's last
// sample.
fn anchor(item: u32) -> Anchor {
    var a = Anchor(vec2f(0.0), vec2f(0.5), vec2f(0.0), false);
    if PRIMITIVE != POINTS {
        let c = row_center(item);
        a.at = c.at;
        a.shown = c.shown;
        if PATH == PATH_TRACE {
            a.at.x += 6.0;
            a.align = vec2f(0.0, 0.5);
        }
        return a;
    }
    let p = point(held_row(item));
    let c = point_center(p);
    a.shown = c.shown;
    let text = length_px(mark.label_size);
    if (mark.flags & GROUP) != 0u {
        // A group's title sits in its header band, inset from the left.
        let header = text * HEADER_BAND;
        a.at = c.at + vec2f(-p.half.x + frame.group_padding, -p.half.y + 0.5 * header);
        a.align = vec2f(0.0, 0.5);
        a.room = vec2f(2.0 * (p.half.x - frame.group_padding), header);
    } else if mark.marker == MARKER_BLOCK || (mark.flags & SIZED) != 0u {
        // A block, or a marker with a width and height, shows its label inside if it fits.
        a.at = c.at;
        a.room = vec2f(2.0 * p.half.x - text, 2.0 * p.half.y);
    } else {
        a.at = c.at + vec2f(p.half.x + 0.4 * text, 0.0);
        a.align = vec2f(0.0, 0.5);
    }
    return a;
}

// Opacity of text `px` CSS pixels tall. In a diagram, text fades out as the view zooms out.
// Elsewhere text has a fixed, readable size, so it always shows.
fn legibility(px: f32) -> f32 {
    if frame.space != SPACE_DIAGRAM {
        return 1.0;
    }
    return smoothstep(3.5, 6.0, px);
}

// A run of text placed on screen: the text's box and its quad, which extends over the distance
// field's spread (both in CSS pixels), its atlas corners in texels, and CSS pixels per texel.
struct Text {
    lo: vec2f,
    hi: vec2f,
    quad_lo: vec2f,
    quad_hi: vec2f,
    uv_lo: vec2f,
    uv_hi: vec2f,
    scale: f32,
}

// An atlas corner packed in one word: x in the low 16 bits, y in the high 16.
fn corner(word: u32) -> vec2f {
    return vec2f(f32(word & 0xffffu), f32(word >> 16u));
}

// The run at atlas corners `uv0` and `uv1`, drawn at size `size` in CSS pixels, aligned by `align`
// at point `at`.
fn text_at(uv0: u32, uv1: u32, size: f32, at: vec2f, align: vec2f) -> Text {
    var t: Text;
    t.uv_lo = corner(uv0);
    t.uv_hi = corner(uv1);
    t.scale = size / TEXT_BASE;
    let pad = TEXT_SPREAD * t.scale;
    let extent = max((t.uv_hi - t.uv_lo) * t.scale - 2.0 * pad, vec2f(0.0));
    t.lo = at - extent * align;
    t.hi = t.lo + extent;
    t.quad_lo = t.lo - pad;
    t.quad_hi = t.hi + pad;
    return t;
}

// The texts a label writes, as run table codes: a text label's `code`, or the characters of a number
// label's number, in order: a minus sign, the whole digits, a point and `places` decimals, an
// exponent, and the unit. `count` says how many, at most `NUMBER_CHARS`. Shaders read the
// characters one at a time with `char_at`, so they keep no array.
struct Chars {
    code: u32,
    count: u32,
    minus: bool,
    whole: u32,
    whole_digits: u32,
    fraction: u32,
    places: u32,
    exponent: bool,
    power: i32,
    power_digits: u32,
    unit: bool,
}

// Ten to the power `n`, at most 9, from its binary digits. Straight-line code keeps the shaders that
// write labels quick to compile.
fn pow10(n: u32) -> u32 {
    let low = select(1u, 10u, (n & 1u) != 0u) * select(1u, 100u, (n & 2u) != 0u);
    return low * select(1u, 10000u, (n & 4u) != 0u) * select(1u, 100000000u, (n & 8u) != 0u);
}

// The number of decimal digits of `n`.
fn digits(n: u32) -> u32 {
    let small = u32(n >= 10u) + u32(n >= 100u) + u32(n >= 1000u) + u32(n >= 10000u);
    let large = u32(n >= 100000u) + u32(n >= 1000000u) + u32(n >= 10000000u) + u32(n >= 100000000u);
    return 1u + small + large + u32(n >= 1000000000u);
}

// Digit `i` from the left of `n` written with `width` digits.
fn digit(n: u32, width: u32, i: u32) -> u32 {
    return (n / pow10(width - 1u - i)) % 10u;
}

// The characters of the label whose code or number is `bits`, which is not missing. A number is
// written as the mark's `number` word says, as an axis writes its ticks. A number that is not finite
// writes nothing.
fn label_chars(bits: u32) -> Chars {
    var c: Chars;
    if mark.number == NONE {
        c.code = u32(bitcast<f32>(bits));
        c.count = 1u;
        return c;
    }
    c.code = NONE;
    if (bits & 0x7f800000u) == 0x7f800000u {
        return c;
    }
    let format = mark.number & 3u;
    let trim = (mark.number & NUMBER_TRIM) != 0u;
    var places = select(min((mark.number >> 2u) & 15u, 7u), 2u, trim);
    let unit = pow10(places);
    var a = abs(bitcast<f32>(bits));
    let exponent = format >= FORMAT_SCIENTIFIC || (format == FORMAT_AUTO && a != 0.0 && (a >= 1e6 || a < 1e-4));
    let step = select(1, 3, format == FORMAT_ENGINEERING);
    let base = select(10.0, 1000.0, format == FORMAT_ENGINEERING);
    var power = 0;
    if exponent && a != 0.0 {
        power = step * i32(floor(floor(log2(a) * 0.30103) / f32(step)));
        a /= pow(10.0, f32(power));
        // Corrects the power where `log2` and `pow` round across one.
        if a >= base {
            a /= base;
            power += step;
        } else if a < 1.0 {
            a *= base;
            power -= step;
        }
    }
    var whole = u32(min(floor(a), 4294967040.0));
    var fraction = u32(round((a - floor(a)) * f32(unit)));
    if fraction >= unit {
        whole += 1u;
        fraction -= unit;
    }
    // Rounding can carry a significand up to the base, such as 9.999 to 10.00.
    if exponent && f32(whole) >= base {
        whole = 1u;
        power += step;
    }
    if trim {
        while places > 0u && fraction % 10u == 0u {
            fraction /= 10u;
            places -= 1u;
        }
    }
    c.minus = bitcast<f32>(bits) < 0.0 && (whole != 0u || fraction != 0u);
    c.whole = whole;
    c.whole_digits = digits(whole);
    c.fraction = fraction;
    c.places = places;
    c.exponent = exponent && (power != 0 || format == FORMAT_SCIENTIFIC);
    c.power = power;
    c.power_digits = digits(u32(abs(power)));
    c.unit = (mark.number & NUMBER_UNIT) != 0u;
    let point = select(0u, 1u + places, places > 0u);
    let written = select(0u, 1u + u32(power < 0) + c.power_digits, c.exponent);
    c.count = min(u32(c.minus) + c.whole_digits + point + written + u32(c.unit), NUMBER_CHARS);
    return c;
}

// The code of character `k` of `c`.
fn char_at(c: Chars, k: u32) -> u32 {
    if c.code != NONE {
        return c.code;
    }
    var i = k;
    if c.minus {
        if i == 0u {
            return CHAR_MINUS;
        }
        i -= 1u;
    }
    if i < c.whole_digits {
        return digit(c.whole, c.whole_digits, i);
    }
    i -= c.whole_digits;
    if c.places > 0u {
        if i == 0u {
            return CHAR_POINT;
        }
        if i <= c.places {
            return digit(c.fraction, c.places, i - 1u);
        }
        i -= 1u + c.places;
    }
    if c.exponent {
        if i == 0u {
            return CHAR_EXPONENT;
        }
        i -= 1u;
        if c.power < 0 {
            if i == 0u {
                return CHAR_MINUS;
            }
            i -= 1u;
        }
        if i < c.power_digits {
            return digit(u32(abs(c.power)), c.power_digits, i);
        }
    }
    return CHAR_UNIT;
}

// The size in CSS pixels of the run at atlas corners `corners`, drawn at size `size`. A run that
// draws nothing has none. A label's runs sit side by side.
fn run_size(corners: vec2u, size: f32) -> vec2f {
    if corners.x == NONE {
        return vec2f(0.0);
    }
    return text_at(corners.x, corners.y, size, vec2f(0.0), vec2f(0.0)).hi;
}

// The box of a label of size `extent` at anchor `a`.
fn label_box(a: Anchor, extent: vec2f) -> Text {
    var t: Text;
    t.lo = a.at - extent * a.align;
    t.hi = t.lo + extent;
    return t;
}

// Whether text of extent `extent` fits `room`. A room of zero width fits any text.
fn fits(extent: vec2f, room: vec2f) -> bool {
    return room.x <= 0.0 || all(extent <= room);
}

// Whether a box overlaps the view.
fn in_view(lo: vec2f, hi: vec2f) -> bool {
    return all(hi > vec2f(0.0)) && all(lo < eye.size);
}

// Labels beside their rows compete for space. Each label writes its claim key into the cells its
// box covers, and each cell keeps the largest key. A label shows only if it keeps every cell it
// covers, so where labels would overlap, the label of the row drawn on top shows. The claims depend
// on this frame alone. A label inside its row (a block's label, or a group's title) or in a diagram
// does not compete.

// Whether the label anchored at `a` competes for space with other labels.
fn claims_room(a: Anchor) -> bool {
    return a.room.x <= 0.0 && frame.space != SPACE_DIAGRAM;
}

// The claim key of drawn row `i`. Later marks, then later rows, draw on top, so their keys are
// larger. Never 0, which marks a cell no label claimed.
fn claim_key(i: u32) -> u32 {
    return (min(mark.index, 255u) << 24u) | min(i + 1u, 0xffffffu);
}

// The box a label claims: its runs' box (of size `extent`) once all are set (`ready`), else space
// for a short text at its anchor.
fn claimed(a: Anchor, ready: bool, extent: vec2f, size: f32) -> Text {
    return label_box(a, select(vec2f(LABEL_GUESS * size, size), extent, ready));
}

// The claim grid's cells a box covers: its first and last column and row (none when it lies off the
// grid), and the grid's width in cells.
struct Cells {
    first: vec2i,
    last: vec2i,
    width: i32,
}

fn cells_of(t: Text) -> Cells {
    let margin = LABEL_MARGIN * eye.size;
    let size = vec2i(ceil((eye.size + 2.0 * margin) / LABEL_CELL));
    let first = max(vec2i(floor((t.lo + margin) / LABEL_CELL)), vec2i(0));
    let last = min(vec2i(floor((t.hi + margin) / LABEL_CELL)), size - 1);
    return Cells(first, last, size.x);
}

// Cell `x`, `y`'s index in the grid of `c`.
fn cell(c: Cells, x: i32, y: i32) -> u32 {
    return u32(y * c.width + x);
}
