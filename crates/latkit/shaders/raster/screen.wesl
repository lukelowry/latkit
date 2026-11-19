// Writes the record of each segment of a stroke mark this frame draws (see `lib/screen.wesl`): a
// point per segment, at its record's texel. Its vertex places the segment, and its fragment writes
// the record's four texels, one into each layer of its group, so the work lies in the vertex and the
// fragment only copies. Records the lit draw draws, the segments of the rows the mark's focus
// lights, are written by the same program when `params.value` is 1.
//
// `params.source` is the first segment, `params.destination` the texel of its record within its
// group, and `params.size` the store's width and height.

import package::lib::types::WordStep;
import package::lib::screen::{screen_stroke, stroke_record};

@group(2) @binding(19) var<uniform> params: WordStep;

struct Written {
    @builtin(position) at: vec4f,
    @location(0) @interpolate(flat) t0: vec4u,
    @location(1) @interpolate(flat) t1: vec4u,
    @location(2) @interpolate(flat) t2: vec4u,
    @location(3) @interpolate(flat) t3: vec4u,
}

struct Texels {
    @location(0) t0: vec4u,
    @location(1) t1: vec4u,
    @location(2) t2: vec4u,
    @location(3) t3: vec4u,
}

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> Written {
    let r = stroke_record(screen_stroke(params.source + i, params.value != 0u));
    let texel = params.destination + i;
    let xy = vec2f(f32(texel % params.size.x), f32(texel / params.size.x)) + 0.5;
    let at = vec4f(xy / vec2f(params.size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
    return Written(at, r.t0, r.t1, r.t2, r.t3);
}

@fragment
fn record(v: Written) -> Texels {
    return Texels(v.t0, v.t1, v.t2, v.t3);
}
