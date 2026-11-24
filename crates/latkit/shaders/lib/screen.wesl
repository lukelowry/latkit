// Network strokes share paint records across drawing and picking. Each record holds four
// texels and follows the source segment even when height sorting changes the draw order.
// Focused rows have separate records. Traces use projected samples when the visible window
// fits the cache. Points project their marker directly.

import package::lib::types::{NONE, STROKE_MARKED, STROKE_BLENDED, ALONG_UNITS, FLOW_UNITS, PATH_TRACE, STATUS};
import package::lib::state::{row_at, edge_at, end_vertex};
import package::lib::bind::{frame, eye, mark};
import package::lib::path::{
    PATH, Style, PathEnds, Segment, OnScreen, stroke_segment, trace_screen, stroke_style, ends_part, path_count, path_length,
    path_total, path_position,
};
import package::lib::points::Point;
import package::lib::project::{to_screen, PI};
import package::lib::lists::{list, list_entry, list_total};
import package::lib::mark::{fringe, px_per_length};
import package::lib::stroke::{rims, comet_reach, COMET_RIM};
import package::lib::drawn::drawn_instance;
import package::lib::daylight::daylight;

import package::lib::atlas::record_word;

// The four texels of a paint record.
struct ScreenRecord {
    t0: vec4u,
    t1: vec4u,
    t2: vec4u,
    t3: vec4u,
}

// A segment as the draws of its mark stroke it. Its ends on screen in CSS pixels (`a`, `b`), the
// depth at each (clip z over w), and the clip w at `b` over that at `a` (`w`): the w of a quad's
// corners matters only relative to each other. Distances along at each end (`along`), how far its
// row's comets have traveled (`travel`), its width and comet flow, as `Stroke` in `lib/stroke.wesl`
// holds them. Whether it is its path's first segment (`first`) or ends a part of it (`last`), and
// for a mark with markers whose list measures its paths, the path's length in CSS pixels (`total`),
// which place its markers (see `lib/along.wesl`). At each end, tan of half the
// turn there (`turn`) and the normal of the line splitting its pixels with the next segment's
// (`split`, see `Joints` in `lib/path.wesl`). Its color at each end of its drawn part, lit by
// daylight (`color_a`, `color_b`). Whether the rows' draw shares each end with the segment beyond
// (`shares`), and whether the comets' draw, which reaches its comets' width across, does
// (`shares_comets`). The held row (`row`).
struct ScreenStroke {
    shown: bool,
    a: vec2f,
    b: vec2f,
    depth: vec2f,
    w: f32,
    along: vec2f,
    travel: f32,
    total: f32,
    width: f32,
    flow: f32,
    turn: vec2f,
    split: vec4f,
    color_a: vec4f,
    color_b: vec4f,
    first: bool,
    last: bool,
    dash: bool,
    rim: bool,
    shares: vec2<bool>,
    shares_comets: vec2<bool>,
    row: u32,
}

// A point as the draws of its mark show it: its center on screen in CSS pixels, the depth its
// marker draws at (clip z over w), its marker's half size, its color lit by daylight, its status,
// its held row, and in the lit draw, its focus bits.
struct ScreenPoint {
    shown: bool,
    center: vec2f,
    depth: f32,
    half: vec2f,
    color: vec4f,
    status: vec4f,
    row: u32,
    focus: u32,
}

// Bits of a stroke record's flags.
const STROKE_SHOWN: u32 = 1u;
const STROKE_LAST: u32 = 2u;
const STROKE_DASH: u32 = 4u;
const STROKE_RIM: u32 = 8u;
const STROKE_SHARES_A: u32 = 16u;
const STROKE_SHARES_B: u32 = 32u;
const STROKE_COMETS_SHARE_A: u32 = 64u;
const STROKE_COMETS_SHARE_B: u32 = 128u;

// The largest magnitude a record keeps in a half float.
const HALF_MOST: f32 = 6e4;

// The steps a record divides a turn into for the angle of a split line: 12 bits.
const ANGLE_STEPS: f32 = 4095.0;

// A path's length as a record keeps it: the steps from a sixteenth of a CSS pixel, `TOTAL_LOW` as
// a power of two, across `TOTAL_OCTAVES` doublings, in 15 bits. Every segment of a path keeps the
// same length, so they agree on where its markers sit, within a twentieth of a percent of it.
const TOTAL_LOW: f32 = -4.0;
const TOTAL_OCTAVES: f32 = 24.0;
const TOTAL_STEPS: f32 = 32766.0;
// The bit beside a record's length that marks its path's first segment.
const TOTAL_FIRST: u32 = 0x8000u;

// Segment `instance` as its mark's draws stroke it, or for the lit draw (`lit`), whose quads widen
// for their glow and which paints comets with its rows. A stroke without dashes or flow measures no
// distances along: in a scene whose dash and flow are constant, its draws are specialized to read
// none (`PAINTED` in `draw/strokes.wesl`), while this reads its row's.
fn trace_stroke(instance: u32, lit: bool) -> ScreenStroke {
    var out: ScreenStroke;
    if !lit & (mark.per_row == NONE) & (instance >= list_total(mark.list)) {
        return out;
    }
    let s = stroke_segment(instance, lit);
    if lit & ((s.item >= mark.rows) | (s.index >= path_count(s.item))) {
        return out;
    }
    return paint_stroke(s, trace_screen(s), stroke_style(s.row), ends_part(s), lit);
}

fn paint_stroke(s: Segment, on: OnScreen, row_style: Style, last: bool, lit: bool) -> ScreenStroke {
    var out: ScreenStroke;
    var style = row_style;
    style.color.a *= s.presence;
    style.width *= s.growth;
    if !style.shown | !on.shown {
        return out;
    }
    let a = on.a;
    let b = on.b;
    let width = style.width;
    let flows = (style.flow != 0.0) & (frame.flow.a > 0.0);
    // A segment's distance along ends where its list says, so it starts its own length before (at 0
    // without a list), and its drawn part covers part of the path's segment it draws or runs
    // beside: in position units, `kept` of its length between its points, else in CSS pixels,
    // `visible` of its `chord` on screen, which is what its list measured. A fan stands for an end
    // of that segment (see `fit_segment`). The list gives a fan no length, so a fan into the first
    // vertex starts at 0, and one into the last, listed after its path, starts a segment back. A
    // mark with markers, or one that says where its colors change, places them by these distances
    // too, and where its list measures its paths, by each one's length.
    var along = vec2f(0.0);
    var total = 0.0;
    let placed = (mark.flags & (STROKE_MARKED | STROKE_BLENDED)) != 0u;
    if style.dash | (style.flow != 0.0) | placed {
        let units = (mark.flags & ALONG_UNITS) != 0u;
        let listed = mark.per_row == NONE;
        let span = select(on.chord, path_length(on.ends.a, on.ends.b), units);
        let start = select(0.0, s.along - select(span, 0.0, on.fan == 1u), listed);
        along = start + span * select(on.visible, on.kept, units);
        if placed & listed {
            total = path_total(s.item) * select(1.0, px_per_length(), units);
        }
    }
    // Where the path runs on through an end, this segment shares that end's pixels with the next
    // (see `Joints`), unless the turn there is too sharp for the two segments' lengths at the width
    // a draw reaches across: the rows' half width, the lit rows' comets and glow too, and the
    // comets' own.
    let comets = 0.5 * max(frame.flow_width, width) + COMET_RIM;
    let rows = select(0.5 * width, max(0.5 * width, select(0.0, comets, flows)) + frame.glow, lit) + fringe();
    let joints = on.joints;
    out.shares = joints.through & (joints.turn * rows <= joints.room);
    out.shares_comets = joints.through & (joints.turn * (comets + fringe()) <= joints.room);
    let first = blended(style, on.ends, on.kept.x);
    out.shown = true;
    out.a = a;
    out.b = b;
    out.depth = vec2f(on.ca.z / on.ca.w, on.cb.z / on.cb.w);
    out.w = on.cb.w / on.ca.w;
    out.along = along;
    out.travel = style.travel;
    out.total = total;
    out.width = width;
    out.flow = style.flow;
    out.turn = joints.turn;
    out.split = joints.split;
    // A row that takes its ends' colors blends them along this segment. On a mark that says where
    // its colors change, each segment keeps both ends' colors whole instead, and its draws blend
    // them where the row says (see `blend_on` in `lib/along.wesl`).
    var color_a = first;
    var color_b = blended(style, on.ends, on.kept.y);
    if style.blends & ((mark.flags & STROKE_BLENDED) != 0u) {
        let e = edge_at(row_at(s.row));
        color_a = style.color * unpack4x8unorm(end_vertex(0u, e.a).color);
        color_b = style.color * unpack4x8unorm(end_vertex(1u, e.b).color);
    }
    out.color_a = daylit(color_a, on.ends, on.kept.x);
    out.color_b = daylit(color_b, on.ends, on.kept.y);
    // The segment on which the stroke leaves its first vertex's marker is its first, and the one on
    // which it reaches its last vertex's marker is its last, wherever in the path they come.
    out.first = (s.index == 0u) | on.stops.x;
    out.last = last | on.stops.y;
    out.dash = style.dash;
    out.rim = flows & rims(first.rgb);
    out.row = s.row;
    return out;
}

// Stroke `style`'s color, straight, `f` of the way along a segment between `ends`, which it blends
// where it takes its ends' colors.
fn blended(style: Style, ends: PathEnds, f: f32) -> vec4f {
    return select(style.color, style.color * mix(ends.a.color, ends.b.color, f), style.blends);
}

// `color`, lit by daylight `f` of the way along a segment between `ends`.
fn daylit(color: vec4f, ends: PathEnds, f: f32) -> vec4f {
    let light = daylight(mix(path_position(ends.a).xy, path_position(ends.b).xy, f));
    return vec4f(color.rgb * light, color.a);
}

// `s` as the texels of its record. Its travel is kept as a fraction of the comet spacing, within
// one, which is all that sets where comets stand. That, its width, turns, and the w at `b` keep to
// half floats, its path's length to 15 bits beside the bit for a first segment, and the angles of
// its split lines to 12 bits, well within a pixel. Colors keep to 8 bits a channel, as rows' colors
// are.
fn stroke_record(s: ScreenStroke) -> ScreenRecord {
    let spacing = max(frame.flow_spacing, 1e-6);
    let flags = select(0u, STROKE_SHOWN, s.shown) | select(0u, STROKE_LAST, s.last) | select(0u, STROKE_DASH, s.dash)
        | select(0u, STROKE_RIM, s.rim) | select(0u, STROKE_SHARES_A, s.shares.x) | select(0u, STROKE_SHARES_B, s.shares.y)
        | select(0u, STROKE_COMETS_SHARE_A, s.shares_comets.x) | select(0u, STROKE_COMETS_SHARE_B, s.shares_comets.y);
    let angles = vec2f(atan2(s.split.y, s.split.x), atan2(s.split.w, s.split.z));
    let turns = vec2u(round(clamp((angles + PI) / (2.0 * PI), vec2f(0.0), vec2f(1.0)) * ANGLE_STEPS));
    return ScreenRecord(
        bitcast<vec4u>(vec4f(s.a, s.b)),
        bitcast<vec4u>(vec4f(s.depth, s.along)),
        vec4u(
            halves(vec2f(clamp(s.w, 1e-4, HALF_MOST), s.width)),
            to_half(fract(s.travel / spacing)) | ((total_code(s.total) | select(0u, TOTAL_FIRST, s.first)) << 16u),
            halves(s.turn),
            bitcast<u32>(s.flow),
        ),
        vec4u(turns.x | (turns.y << 12u) | (flags << 24u), pack4x8unorm(s.color_a), pack4x8unorm(s.color_b), s.row),
    );
}

// Path length `total`, in CSS pixels, as a record keeps it: 0 for none.
fn total_code(total: f32) -> u32 {
    let steps = round((log2(max(total, 1e-12)) - TOTAL_LOW) / TOTAL_OCTAVES * TOTAL_STEPS);
    return select(0u, u32(clamp(steps, 0.0, TOTAL_STEPS)) + 1u, total > 0.0);
}

// The path length a record keeps as `code`.
fn total_of(code: u32) -> f32 {
    let steps = f32(max(code, 1u) - 1u);
    return select(0.0, exp2(steps / TOTAL_STEPS * TOTAL_OCTAVES + TOTAL_LOW), code != 0u);
}

// Two values as half floats, low then high: each rounded to the nearest, within the range a half
// float keeps, and zero below its least normal value.
fn halves(v: vec2f) -> u32 {
    return to_half(v.x) | (to_half(v.y) << 16u);
}

// Half float `x`'s bits.
fn to_half(x: f32) -> u32 {
    let bits = bitcast<u32>(clamp(x, -HALF_MOST, HALF_MOST));
    let magnitude = bits & 0x7fffffffu;
    // Rounds at the 13 bits a half float drops, then moves the exponent's bias from 127 to 15.
    let half = select((magnitude + 0x1000u - 0x38000000u) >> 13u, 0u, magnitude < 0x38800000u);
    return ((bits >> 16u) & 0x8000u) | half;
}

// The value of half float bits `h`, in the low 16 bits.
fn from_half(h: u32) -> f32 {
    let magnitude = h & 0x7fffu;
    let bits = ((h & 0x8000u) << 16u) | select(0u, (magnitude << 13u) + 0x38000000u, magnitude != 0u);
    return bitcast<f32>(bits);
}

// The two half floats of `h`, low then high.
fn from_halves(h: u32) -> vec2f {
    return vec2f(from_half(h), from_half(h >> 16u));
}

// Draw positions follow height order. Query and label addresses stay in source order.
fn draw_record(i: u32, lit: bool) -> u32 {
    if lit || mark.height_order == NONE { return i; }
    return mark.screen_first + drawn_instance(i - mark.screen_first);
}

// Instance `i`'s stroke, from its record.
fn read_stroke(i: u32) -> ScreenStroke {
    let t0 = record_texel(i, 0u);
    let t1 = record_texel(i, 1u);
    let t2 = record_texel(i, 2u);
    let t3 = record_texel(i, 3u);
    let w_width = from_halves(t2.x);
    let angles = vec2f(f32(t3.x & 0xfffu), f32((t3.x >> 12u) & 0xfffu)) / ANGLE_STEPS * (2.0 * PI) - PI;
    let flags = t3.x >> 24u;
    var s: ScreenStroke;
    s.shown = (flags & STROKE_SHOWN) != 0u;
    s.a = bitcast<vec2f>(t0.xy);
    s.b = bitcast<vec2f>(t0.zw);
    s.depth = bitcast<vec2f>(t1.xy);
    s.along = bitcast<vec2f>(t1.zw);
    s.w = w_width.x;
    s.width = w_width.y;
    s.flow = bitcast<f32>(t2.w);
    s.travel = from_half(t2.y) * max(frame.flow_spacing, 1e-6);
    s.total = total_of((t2.y >> 16u) & 0x7fffu);
    s.first = ((t2.y >> 16u) & TOTAL_FIRST) != 0u;
    s.turn = from_halves(t2.z);
    s.split = vec4f(cos(angles.x), sin(angles.x), cos(angles.y), sin(angles.y));
    s.color_a = unpack4x8unorm(t3.y);
    s.color_b = unpack4x8unorm(t3.z);
    s.row = t3.w;
    s.last = (flags & STROKE_LAST) != 0u;
    s.dash = (flags & STROKE_DASH) != 0u;
    s.rim = (flags & STROKE_RIM) != 0u;
    s.shares = vec2<bool>((flags & STROKE_SHARES_A) != 0u, (flags & STROKE_SHARES_B) != 0u);
    s.shares_comets = vec2<bool>((flags & STROKE_COMETS_SHARE_A) != 0u, (flags & STROKE_COMETS_SHARE_B) != 0u);
    return s;
}

// Point `p` as its mark's draws show it.
fn screen_point(p: Point) -> ScreenPoint {
    var out: ScreenPoint;
    out.shown = p.shown;
    out.center = to_screen(p.clip);
    out.depth = p.drawn_z;
    out.half = p.half;
    out.color = vec4f(p.color.rgb * daylight(p.position), p.color.a);
    out.status = p.status;
    out.row = p.row;
    out.focus = p.focus;
    return out;
}

// How far point `p`'s quad reaches from its center, in CSS pixels: its marker, its status ring, one
// target pixel of antialiased edge, and in the lit draw (`lit`), its glow.
fn point_reach(p: ScreenPoint, lit: bool) -> vec2f {
    let ring = select(0.0, 3.0, ((mark.flags & STATUS) != 0u) & (p.status.a > 0.0));
    return p.half + ring + select(0.0, frame.glow, lit) + fringe();
}

// The part of the segment from `a` to `b` on screen, in CSS pixels, that lies on the target, as
// fractions of it from `a`, low then high. Empty (x above y) when none does.
fn on_target(a: vec2f, b: vec2f) -> vec2f {
    let across = clip_axis(vec2f(0.0, 1.0), a.x, b.x - a.x, eye.size.x);
    return clip_axis(across, a.y, b.y - a.y, eye.size.y);
}

// `t`, the fractions of a segment kept so far, within those where `start + d·t` lies from 0 to
// `most`.
fn clip_axis(t: vec2f, start: f32, d: f32, most: f32) -> vec2f {
    if abs(d) < 1e-6 {
        return select(vec2f(1.0, 0.0), t, (start >= 0.0) & (start <= most));
    }
    let ends = vec2f(-start, most - start) / d;
    return vec2f(max(t.x, min(ends.x, ends.y)), min(t.y, max(ends.x, ends.y)));
}

// The comet slots segment `s` takes in its mark's comets draw (see `raster/comets.wesl`): as many as
// comets reach its part on the target at any travel, or none when it carries none. A comet reaches
// the part when its head lies on it, or within its tail behind it or its head's reach ahead, as the
// comets draw measures them, so the slots are one for each comet spacing across that span, and one
// more. The comets draw draws a slot's comet with `comet_on`, from the same part.
fn comet_slots(s: ScreenStroke) -> u32 {
    let on = on_target(s.a, s.b);
    if !s.shown | (s.flow == 0.0) | (on.x > on.y) {
        return 0u;
    }
    let units = frame.flow_unit == FLOW_UNITS;
    let pixels = length(s.b - s.a);
    let along = select(pixels, abs(s.along.y - s.along.x), units);
    let px = select(1.0, pixels / max(along, 1e-12), units);
    let reach = comet_reach(px, s.flow, 0.5 * max(frame.flow_width, s.width) + COMET_RIM + fringe());
    // A thousandth more, for the rounding where the draw measures the part in its own terms.
    let spacings = 1.001 * (along * (on.y - on.x) + reach.x + reach.y) / max(frame.flow_spacing, 1e-6);
    return u32(min(floor(spacings), 65535.0)) + 1u;
}

// The record and the comet that slot `i` of its mark's comets draw draws, from the mark's comet
// slots, which the copy of its uniform for that draw lists as `list`. NONE past the slots they hold.
fn comet_slot(i: u32) -> vec2u {
    if i >= list_total(mark.list) {
        return vec2u(NONE, 0u);
    }
    let at = list_entry(mark.list, 2u * i);
    return vec2u(list(at), list(at + 1u));
}

// Texel `layer` of paint record `i`.
fn record_texel(i: u32, layer: u32) -> vec4u {
    return record_word(i, layer, 4u);
}
