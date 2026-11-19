// Where each instance of a stroke or point mark lies on screen this frame, as every draw of the mark
// places it: a segment, with its joints, distances along, comets, colors, and arrowhead, or a
// point's marker. Placing a segment reads its path's points, projects them, and joins it to its
// neighbors, work each corner of each draw would otherwise repeat: four corners in each of a mark's
// opaque, rows, and comets draws. So a frame writes each instance's record once
// (`raster/screen.wesl`) before it draws the mark, and every corner reads it. The lit draw's
// instances, the rows the mark's focus lights, have records of their own.
//
// A record is one texel in each layer of a group of four in the screen store, at the same place, so
// one point's fragment writes it whole. Record `i` lies at texel `i` of its group, in rows of the
// store's width. A draw numbers its instances from its mark's first record, so an instance's index
// is its record's.

import package::lib::types::{NONE, ARROWS, ALONG_UNITS, PATH_TRACE, STATUS};
import package::lib::bind::{frame, mark};
import package::lib::path::{
    PATH, Style, PathEnds, segment, segment_points, on_screen, stroke_style, ends_part, path_count, path_length,
    path_total, path_position, marker_reach,
};
import package::lib::points::Point;
import package::lib::project::{to_screen, PI};
import package::lib::lists::list_total;
import package::lib::mark::fringe;
import package::lib::stroke::{rims, COMET_RIM};
import package::lib::daylight::daylight;

@group(2) @binding(11) var screen: texture_2d_array<u32>;

// The four texels of a record, one for each layer of its group.
struct ScreenRecord {
    t0: vec4u,
    t1: vec4u,
    t2: vec4u,
    t3: vec4u,
}

// A segment as the draws of its mark stroke it. Its ends on screen in CSS pixels (`a`, `b`), the
// depth at each (clip z over w), and the clip w at `b` over that at `a` (`w`): the w of a quad's
// corners matters only relative to each other. Distances along at each end (`along`), how far its
// row's comets have traveled (`travel`), how far past `b` its arrowhead's tip lies (`tip`), its
// width and comet flow, as `Stroke` in `lib/stroke.wesl` holds them. At each end, tan of half the
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
    tip: f32,
    width: f32,
    flow: f32,
    turn: vec2f,
    split: vec4f,
    color_a: vec4f,
    color_b: vec4f,
    arrow: bool,
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
const STROKE_ARROW: u32 = 2u;
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

// Segment `instance` as its mark's draws stroke it, or for the lit draw (`lit`), whose quads widen
// for their glow and which paints comets with its rows. A stroke without dashes or flow measures no
// distances along: in a scene whose dash and flow are constant, its draws are specialized to read
// none (`PAINTED` in `draw/strokes.wesl`), while this reads its row's.
fn screen_stroke(instance: u32, lit: bool) -> ScreenStroke {
    var out: ScreenStroke;
    if !lit & (mark.per_row == NONE) & (instance >= list_total(mark.list)) {
        return out;
    }
    let s = segment(instance);
    if lit & ((s.item >= mark.rows) | (s.index >= path_count(s.item))) {
        return out;
    }
    // A stroke fades and scales with its row's tile.
    var style = stroke_style(s.row);
    style.color.a *= s.presence;
    style.width *= s.growth;
    let points = segment_points(s);
    let on = on_screen(points);
    if !style.shown | !on.shown {
        return out;
    }
    let a = on.a;
    let b = on.b;
    let width = style.width;
    let pixels = length(b - a);
    // A segment shorter than half a pixel on screen, such as one between vertices at one place,
    // points nowhere, so it has no head.
    let arrow = (PATH != PATH_TRACE) & ((mark.flags & ARROWS) != 0u) & ends_part(s) & (pixels >= 0.5);
    let flows = (style.flow != 0.0) & (frame.flow.a > 0.0);
    // A segment's distance along ends where its list says, so it starts its own length before (at 0
    // without a list), and its drawn part covers part of the path's segment it draws or runs
    // beside: in position units, `kept` of its length between its points, else in CSS pixels,
    // `visible` of its `chord` on screen, which is what its list measured. A fan stands for an end
    // of that segment (see `on_screen`). The list gives a fan no length, so a fan into the first
    // vertex starts at 0, and one into the last, listed after its path, starts a segment back. Where
    // comets flow toward an arrowhead, `tip` is how far past `b` the head's tip lies: 0 on its own
    // segment, and before it, the rest of the path less the farthest its marker reaches.
    var along = vec2f(0.0);
    var tip = select(-1.0, 0.0, arrow);
    if style.dash | (style.flow != 0.0) {
        let units = (mark.flags & ALONG_UNITS) != 0u;
        let listed = mark.per_row == NONE;
        let span = select(on.chord, path_length(on.ends.a, on.ends.b), units);
        let start = select(0.0, s.along - select(span, 0.0, on.fan == 1u), listed);
        along = start + span * select(on.visible, on.kept, units);
        if flows & listed & !arrow & ((mark.flags & ARROWS) != 0u) {
            let px = select(1.0, pixels / max(abs(along.y - along.x), 1e-12), units);
            tip = max((path_total(s.item) - along.y) * px - marker_reach(points.vertex_b), 0.0);
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
    out.tip = tip;
    out.width = width;
    out.flow = style.flow;
    out.turn = joints.turn;
    out.split = joints.split;
    out.color_a = daylit(first, on.ends, on.kept.x);
    out.color_b = daylit(blended(style, on.ends, on.kept.y), on.ends, on.kept.y);
    out.arrow = arrow;
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
// one, which is all that sets where comets stand. That, its width, turns, the w at `b`, and how far
// its arrowhead lies keep to half floats, and the angles of its split lines to 12 bits, well within
// a pixel. Colors keep to 8 bits a channel, as rows' colors are.
fn stroke_record(s: ScreenStroke) -> ScreenRecord {
    let spacing = max(frame.flow_spacing, 1e-6);
    let flags = select(0u, STROKE_SHOWN, s.shown) | select(0u, STROKE_ARROW, s.arrow) | select(0u, STROKE_DASH, s.dash)
        | select(0u, STROKE_RIM, s.rim) | select(0u, STROKE_SHARES_A, s.shares.x) | select(0u, STROKE_SHARES_B, s.shares.y)
        | select(0u, STROKE_COMETS_SHARE_A, s.shares_comets.x) | select(0u, STROKE_COMETS_SHARE_B, s.shares_comets.y);
    let angles = vec2f(atan2(s.split.y, s.split.x), atan2(s.split.w, s.split.z));
    let turns = vec2u(round(clamp((angles + PI) / (2.0 * PI), vec2f(0.0), vec2f(1.0)) * ANGLE_STEPS));
    return ScreenRecord(
        bitcast<vec4u>(vec4f(s.a, s.b)),
        bitcast<vec4u>(vec4f(s.depth, s.along)),
        vec4u(
            halves(vec2f(clamp(s.w, 1e-4, HALF_MOST), s.width)),
            halves(vec2f(fract(s.travel / spacing), s.tip)),
            halves(s.turn),
            bitcast<u32>(s.flow),
        ),
        vec4u(turns.x | (turns.y << 12u) | (flags << 24u), pack4x8unorm(s.color_a), pack4x8unorm(s.color_b), s.row),
    );
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

// Instance `i`'s stroke, from its record.
fn read_stroke(i: u32) -> ScreenStroke {
    let t0 = record_texel(i, 0u);
    let t1 = record_texel(i, 1u);
    let t2 = record_texel(i, 2u);
    let t3 = record_texel(i, 3u);
    let w_width = from_halves(t2.x);
    let travel_tip = from_halves(t2.y);
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
    s.travel = travel_tip.x * max(frame.flow_spacing, 1e-6);
    s.tip = travel_tip.y;
    s.turn = from_halves(t2.z);
    s.split = vec4f(cos(angles.x), sin(angles.x), cos(angles.y), sin(angles.y));
    s.color_a = unpack4x8unorm(t3.y);
    s.color_b = unpack4x8unorm(t3.z);
    s.row = t3.w;
    s.arrow = (flags & STROKE_ARROW) != 0u;
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

// `p` as the texels of its record. A hidden point's half size is negative. Colors keep to 8 bits
// a channel, as rows' colors are.
fn point_record(p: ScreenPoint) -> ScreenRecord {
    let half = select(vec2f(-1.0), p.half, p.shown);
    return ScreenRecord(
        vec4u(bitcast<vec3u>(vec3f(p.center, p.depth)), p.row),
        vec4u(bitcast<vec2u>(half), pack4x8unorm(p.color), pack4x8unorm(p.status)),
        vec4u(p.focus, 0u, 0u, 0u),
        vec4u(0u),
    );
}

// Instance `i`'s point, from its record.
fn read_point(i: u32) -> ScreenPoint {
    let t0 = record_texel(i, 0u);
    let t1 = record_texel(i, 1u);
    let t2 = record_texel(i, 2u);
    var p: ScreenPoint;
    p.focus = t2.x;
    p.half = bitcast<vec2f>(t1.xy);
    p.shown = p.half.x >= 0.0;
    p.center = bitcast<vec2f>(t0.xy);
    p.depth = bitcast<f32>(t0.z);
    p.row = t0.w;
    p.color = unpack4x8unorm(t1.z);
    p.status = unpack4x8unorm(t1.w);
    return p;
}

// How far point `p`'s quad reaches from its center, in CSS pixels: its marker, its status ring, one
// target pixel of antialiased edge, and in the lit draw (`lit`), its glow.
fn point_reach(p: ScreenPoint, lit: bool) -> vec2f {
    let ring = select(0.0, 3.0, ((mark.flags & STATUS) != 0u) & (p.status.a > 0.0));
    return p.half + ring + select(0.0, frame.glow, lit) + fringe();
}

// Layer `layer` of record `i`.
fn record_texel(i: u32, layer: u32) -> vec4u {
    let size = textureDimensions(screen);
    let per = size.x * size.y;
    let at = i % per;
    return textureLoad(screen, vec2i(i32(at % size.x), i32(at / size.x)), i32(4u * (i / per) + layer), 0);
}
