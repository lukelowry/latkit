// Glyphs: every labeled row's text, placed from its anchor each frame and shown as placement decided,
// over a halo of the background so it reads over whatever lies under it. The ports variant draws
// each port's label beside it, inside its marker. Text is a distance field: edges stay crisp at any
// size, and the halo is a wider threshold of the same field.

import package::lib::types::{
    CANDIDATE_WORDS, CANDIDATE_ALPHA, LABEL_CODE, LABEL_COLOR, PORT_WORDS, PORT_CODE, PORT_UV, PORT_SIZE, SIDE_LEFT,
    SIDE_RIGHT, SIDE_TOP, TEXT_SPREAD, TEXT_ESTIMATE, SPACE_DIAGRAM, THEME_TEXT,
};
import package::lib::bind::{frame, eye, mark, state, program, ramp};
import package::lib::state::extra_at;
import package::lib::read::missing_bits;
import package::lib::points::{point, port_at, port_inward};
import package::lib::label::{anchor, length_px, legibility, text_at, fits, Text};
import package::lib::project::culled;
import package::lib::color::output;

@group(2) @binding(8) var atlas: texture_2d<f32>;
@group(2) @binding(13) var<storage, read> labels: array<u32>;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) color: vec4f,
    // CSS pixels per atlas texel.
    @location(2) @interpolate(flat) scale: f32,
}

// Corner `corner` of text `t`, drawn in `color`.
fn quad(t: Text, corner: u32, color: vec4f) -> Varyings {
    var out: Varyings;
    let q = vec2f(f32(corner & 1u), f32(corner >> 1u));
    // Snapped to whole target pixels while it is set at its own size, so text stays crisp.
    var p = mix(t.quad_lo, t.quad_hi, q);
    if frame.space != SPACE_DIAGRAM {
        p = round(p * eye.pixel_ratio) / eye.pixel_ratio;
    }
    let ndc = p / eye.size * 2.0 - 1.0;
    out.clip = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.uv = mix(t.uv_lo, t.uv_hi, q);
    out.color = color;
    out.scale = t.scale;
    return out;
}

fn unshown() -> Varyings {
    var out: Varyings;
    out.clip = culled();
    return out;
}

@if(!ports)
@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) row: u32) -> Varyings {
    if row >= mark.rows {
        return unshown();
    }
    let code_bits = state[extra_at(row, mark.label + LABEL_CODE)];
    if missing_bits(code_bits) {
        return unshown();
    }
    let code = u32(bitcast<f32>(code_bits));
    let uv0 = labels[mark.runs + 2u * code];
    let uv1 = labels[mark.runs + 2u * code + 1u];
    // Nothing to draw until the text is set.
    if (uv0 == 0u && uv1 == 0u) || (uv0 & TEXT_ESTIMATE) != 0u {
        return unshown();
    }
    let a = anchor(row);
    let size = length_px(mark.label_size);
    let t = text_at(uv0, uv1, size, a.at, a.align);
    // A diagram's labels show while they fit and read; elsewhere as placement decided.
    var alpha = bitcast<f32>(labels[mark.candidates + row * CANDIDATE_WORDS + CANDIDATE_ALPHA]);
    if frame.space == SPACE_DIAGRAM {
        alpha = f32(a.shown && fits(t.hi - t.lo, a.room)) * legibility(size);
    }
    if !(alpha > 0.0) {
        return unshown();
    }
    let color = unpack4x8unorm(state[extra_at(row, mark.label + LABEL_COLOR)]);
    return quad(t, corner, vec4f(color.rgb, color.a * alpha));
}

// A port's label: beside the port, inside its marker, aligned away from the side it sits on. It
// shows while it reads and keeps clear of the ports across from it.
@if(ports)
@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    let n = max(mark.ports, 1u);
    let row = instance / n;
    let k = instance % n;
    if row >= mark.rows {
        return unshown();
    }
    let info = mark.port_info + k * PORT_WORDS;
    let uv0 = program[info + PORT_UV];
    let uv1 = program[info + PORT_UV + 1u];
    if uv0 == 0u && uv1 == 0u {
        return unshown();
    }
    let p = point(row);
    let port = port_at(p, k);
    let code = program[info + PORT_CODE];
    let inward = port_inward(code);
    let gap = 0.5 * PORT_SIZE * frame.unit;
    let at = port.center + inward * (port.half + gap);
    var align = vec2f(0.5);
    var room = vec2f(2.0 * p.half.x, p.half.y);
    switch code & 3u {
        case SIDE_LEFT: {
            align = vec2f(0.0, 0.5);
            room = vec2f(p.half.x - port.half - gap, 2.0 * p.half.y);
        }
        case SIDE_RIGHT: {
            align = vec2f(1.0, 0.5);
            room = vec2f(p.half.x - port.half - gap, 2.0 * p.half.y);
        }
        case SIDE_TOP: {
            align = vec2f(0.5, 0.0);
            room = vec2f(2.0 * p.half.x / f32(((code >> 10u) & 255u) + 1u), p.half.y);
        }
        default: {
            align = vec2f(0.5, 1.0);
            room = vec2f(2.0 * p.half.x / f32(((code >> 10u) & 255u) + 1u), p.half.y);
        }
    }
    let size = length_px(mark.port_label_size);
    let t = text_at(uv0, uv1, size, at, align);
    let alpha = f32(p.shown && fits(t.hi - t.lo, room)) * legibility(size) * p.color.a;
    if !(alpha > 0.0) {
        return unshown();
    }
    let text = unpack4x8unorm(frame.theme[THEME_TEXT / 4u][THEME_TEXT % 4u]);
    return quad(t, corner, vec4f(text.rgb, text.a * alpha));
}

// The distance field at `uv`: texels past the text's edge, inside positive.
fn inside(uv: vec2f) -> f32 {
    let d = textureSampleLevel(atlas, ramp, uv / vec2f(textureDimensions(atlas)), 0.0).r;
    return (d - 0.5) * 2.0 * TEXT_SPREAD;
}

@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    // Target pixels past the edge.
    let d = inside(v.uv) * v.scale * eye.pixel_ratio;
    let a_text = clamp(0.5 + d, 0.0, 1.0) * v.color.a;
    let back = frame.background;
    let a_halo = clamp(0.5 + d + frame.halo * eye.pixel_ratio, 0.0, 1.0) * v.color.a * back.a * 0.85;
    let a = a_text + a_halo * (1.0 - a_text);
    let rgb = v.color.rgb * a_text + back.rgb * a_halo * (1.0 - a_text);
    return output(vec4f(rgb, a));
}
