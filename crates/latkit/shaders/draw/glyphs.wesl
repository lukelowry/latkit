// Glyphs: every labeled row's text, placed from its prepared screen position. A label shows when its
// text is set and its row shows. It fades with its row's tile. A label beside its row also shows
// only if it kept its claim on every cell it covers this frame (`raster/claims.wesl`), so labels
// never overlap. Nothing depends on an earlier frame. A halo of the background color keeps text
// readable over anything below it. Text inside a shape or block reads on its fill instead: it keeps
// `TEXT_CONTRAST` with the fill, and its halo is the fill. Text is a distance field, so
// edges stay crisp at any size, and the halo is a wider threshold of the same field.

import package::lib::types::{
    NONE, LABEL_CODE, LABEL_COLOR, TEXT_SPREAD, NUMBER_CHARS, POINTS, SIZED, MARKER_SHAPE, MARKER_BLOCK,
    VERTEX_COLOR,
};
import package::lib::bind::{frame, eye, mark, word, ramp};
import package::lib::state::{extra_at, row_at};
import package::lib::read::missing_bits;
import package::lib::label::{
    text_at, Text, label_chars, char_at, run_size,
    Cells, grid_size,
};
import package::lib::project::{culled, to_clip};
import package::lib::color::{output, legible};
import package::lib::drawn::drawn_row;
import package::lib::labels::{labels, cells, run, keeps, claim_key};
import package::lib::words::word_quad;

// The least contrast ratio text inside a marker keeps with its fill: WCAG's minimum for text.
const TEXT_CONTRAST: f32 = 4.5;

@group(2) @binding(8) var atlas: texture_2d<f32>;
struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) color: vec4f,
    // CSS pixels per atlas texel.
    @location(2) @interpolate(flat) scale: f32,
    // The halo's color: the background, or the fill of the marker the text lies inside.
    @location(3) @interpolate(flat) halo: vec4f,
}

// Corner `corner` of text `t`, drawn in `color` with a halo of `halo`. Text has a fixed size, so
// snapping to whole target pixels keeps it crisp.
fn quad(t: Text, corner: u32, color: vec4f, halo: vec4f) -> Varyings {
    var out: Varyings;
    let q = vec2f(f32(corner & 1u), f32(corner >> 1u));
    let p = round(mix(t.quad_lo, t.quad_hi, q) * eye.pixel_ratio) / eye.pixel_ratio;
    out.clip = to_clip(p, vec4f(0.0, 0.0, 0.0, 1.0));
    out.uv = mix(t.uv_lo, t.uv_hi, q);
    out.color = color;
    out.scale = t.scale;
    out.halo = halo;
    return out;
}

fn unshown() -> Varyings {
    var out: Varyings;
    out.clip = culled();
    return out;
}

// Each instance draws one run of a row's label: the row's text, or one character of its number.
@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    let per = select(NUMBER_CHARS, 1u, mark.number == NONE);
    var item = instance / per;
    let k = instance % per;
    // A label that claims cells must own its first cell. Enumerating those cells bounds dense
    // draws by the viewport while preserving each winner exactly once. Labels inside sized
    // markers do not all claim space, so they continue to enumerate rows.
    let grid = vec2u(grid_size());
    let outside = mark.primitive != POINTS || ((mark.flags & SIZED) == 0u && mark.marker != MARKER_BLOCK);
    let by_cell = outside && grid.x * grid.y < mark.rows;
    var cell = vec2u(0u);
    if by_cell {
        cell = vec2u(item % grid.x, item / grid.x);
        let owner = textureLoad(cells, vec2i(cell), 0).xy;
        if owner.x != mark.index + 1u || owner.y == 0u { return unshown(); }
        item = owner.y - 1u;
    }
    if item >= mark.rows {
        return unshown();
    }
    let prepared = word_quad(labels, mark.label_metadata + item * 4u);
    if (prepared.w & 8u) == 0u { return unshown(); }
    if by_cell && prepared.x != (cell.x | (cell.y << 16u)) { return unshown(); }
    if (prepared.w & 16u) != 0u {
        let cells = Cells(vec2i(i32(prepared.x & 65535u), i32(prepared.x >> 16u)),
            vec2i(i32(prepared.y & 65535u), i32(prepared.y >> 16u)), 0);
        if !keeps(cells, claim_key(item)) { return unshown(); }
    }
    let drawn = drawn_row(item);
    let row = drawn.row;
    let bits = word(extra_at(row, mark.label + LABEL_CODE));
    if missing_bits(bits) {
        return unshown();
    }
    let chars = label_chars(bits);
    if k >= chars.count {
        return unshown();
    }
    let own = run(char_at(chars, k));
    if own.x == NONE {
        return unshown();
    }
    // The label's size, and where this run starts in it.
    let size = mark.label_size;
    var before = 0.0;
    for (var j = 0u; j < k; j++) {
        let corners = run(char_at(chars, j));
        let s = run_size(corners, size);
        before += s.x;
    }
    let lo = bitcast<vec2f>(word_quad(labels, mark.label_positions + item * 4u).xy);
    let alpha = drawn.presence;
    if !(alpha > 0.0) {
        return unshown();
    }
    let color = unpack4x8unorm(word(extra_at(row, mark.label + LABEL_COLOR)));
    // Text inside a shape or block reads on the row's color there, over the background where that
    // color is translucent, and its halo is that color. Other markers draw something else there.
    var rgb = color.rgb;
    var halo = frame.background;
    if ((prepared.w & 32u) != 0u) & ((mark.marker == MARKER_SHAPE) | (mark.marker == MARKER_BLOCK)) {
        let fill = unpack4x8unorm(word(row_at(row) + VERTEX_COLOR));
        let ground = mix(frame.background.rgb, fill.rgb, fill.a);
        rgb = legible(rgb, ground, TEXT_CONTRAST);
        halo = vec4f(ground, max(fill.a, frame.background.a));
    }
    let t = text_at(own.x, own.y, size, lo + vec2f(before, 0.0), vec2f(0.0));
    return quad(t, corner, vec4f(rgb, color.a * alpha), halo);
}

// The distance field at `uv`, in texels from the text's edge, positive inside.
fn inside(uv: vec2f) -> f32 {
    let d = textureSampleLevel(atlas, ramp, uv / vec2f(textureDimensions(atlas)), 0.0).r;
    return (d - 0.5) * 2.0 * TEXT_SPREAD;
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    // Distance from the edge in target pixels.
    let d = inside(v.uv) * v.scale * eye.pixel_ratio;
    let a_text = clamp(0.5 + d, 0.0, 1.0) * v.color.a;
    let back = v.halo;
    let a_halo = clamp(0.5 + d + frame.halo * eye.pixel_ratio, 0.0, 1.0) * v.color.a * back.a * 0.85;
    let a = a_text + a_halo * (1.0 - a_text);
    let rgb = v.color.rgb * a_text + back.rgb * a_halo * (1.0 - a_text);
    return output(vec4f(rgb, a));
}
