// Labels: where a labeled row's text is anchored, its size, and whether it can show. Draws place
// every label from its anchor each frame, so labels track the camera and their rows exactly.
// Placement measures the same box only to decide which labels are dropped. Text is a distance field
// set at `TEXT_BASE` and drawn at any size: in CSS pixels, or in a diagram in length units, where
// text scales with the sheet and fades out once too small to read.

import package::lib::types::{
    POINTS, STROKES, MARKER_BLOCK, SIZED, GROUP, PATH_TRACE, PATH_GEOMETRY, TEXT_BASE, TEXT_SPREAD, HEADER_BAND,
    SPACE_DIAGRAM,
};
import package::lib::bind::{frame, eye, mark};
import package::lib::mark::PRIMITIVE;
import package::lib::project::{to_screen, clip_of};
import package::lib::points::point;
import package::lib::path::{PATH, Segment, segment_screen, path_count};
import package::lib::triangles::{triangle_corner, area_anchor};
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

// The label anchor of drawn row `item`.
fn anchor(item: u32) -> Anchor {
    var a: Anchor;
    let row = held_row(item);
    switch PRIMITIVE {
        case POINTS: {
            let p = point(row);
            a.shown = p.shown;
            let center = to_screen(p.clip);
            let text = length_px(mark.label_size);
            if (mark.flags & GROUP) != 0u {
                // A group's title sits in its header band, inset from the left.
                let header = text * HEADER_BAND;
                a.at = center + vec2f(-p.half.x + frame.group_padding, -p.half.y + 0.5 * header);
                a.align = vec2f(0.0, 0.5);
                a.room = vec2f(2.0 * (p.half.x - frame.group_padding), header);
            } else if mark.marker == MARKER_BLOCK || (mark.flags & SIZED) != 0u {
                // A block, or a marker with a width and height, shows its label inside if it fits.
                a.at = center;
                a.align = vec2f(0.5);
                a.room = vec2f(2.0 * p.half.x - text, 2.0 * p.half.y);
            } else {
                a.at = center + vec2f(p.half.x + 0.4 * text, 0.0);
                a.align = vec2f(0.0, 0.5);
            }
        }
        case STROKES: {
            let count = path_count(item);
            // A trace labels its last sample; other paths their middle.
            let last = PATH == PATH_TRACE;
            let index = select(count / 2u, max(count, 1u) - 1u, last);
            let on = segment_screen(Segment(row, item, index, 0.0, 1.0, 1.0, false));
            a.shown = count > 0u && on.shown;
            if last {
                a.at = on.b + vec2f(6.0, 0.0);
                a.align = vec2f(0.0, 0.5);
            } else {
                a.at = 0.5 * (on.a + on.b);
                a.align = vec2f(0.5);
            }
        }
        default: {
            a.align = vec2f(0.5);
            if PATH == PATH_GEOMETRY {
                // An area's label sits inside its largest polygon, farthest from its edges.
                let c = area_anchor(row);
                let clip = clip_of(c.world);
                a.shown = c.shown && c.ahead && clip.w > 0.0;
                a.at = to_screen(clip);
                return a;
            }
            var sum = vec2f(0.0);
            a.shown = true;
            for (var k = 0u; k < 3u; k++) {
                let c = triangle_corner(item, k);
                let clip = clip_of(c.world);
                a.shown = a.shown && c.shown && c.ahead && clip.w > 0.0;
                sum += to_screen(clip);
            }
            a.at = sum / 3.0;
        }
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
// field's spread (both in CSS pixels); its atlas corners in texels; and CSS pixels per texel.
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

// Whether text of extent `extent` fits `room`. A room of zero width fits any text.
fn fits(extent: vec2f, room: vec2f) -> bool {
    return room.x <= 0.0 || all(extent <= room);
}

// Whether a box overlaps the view.
fn in_view(lo: vec2f, hi: vec2f) -> bool {
    return all(hi > vec2f(0.0)) && all(lo < eye.size);
}
