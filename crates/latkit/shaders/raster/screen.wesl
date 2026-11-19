// Writes the record of each instance of a mark this frame draws (see `lib/screen.wesl`): a point per
// instance, at its record's texel. Its vertex places the instance, and its fragment writes the
// record's four texels, one into each layer of its group, so the work lies in the vertex and the
// fragment only copies. A strokes variant (`joined`) writes segments, and the other points. A
// focus variant (`focused`) writes the lit draw's instances: the rows the mark's focus lights.
//
// `params.source` is the first instance, `params.destination` the texel of its record within its
// group, and `params.size` the store's width and height.

import package::lib::types::WordStep;
import package::lib::bind::{mark, focused};
import package::lib::screen::{ScreenRecord, screen_stroke, stroke_record, screen_point, point_record};
import package::lib::points::{Point, shown_point};
import package::lib::drawn::drawn_instance;

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

@if(focused)
const LIT_DRAW: bool = true;
@if(!focused)
const LIT_DRAW: bool = false;

@if(joined)
fn record_of(instance: u32) -> ScreenRecord {
    return stroke_record(screen_stroke(instance, LIT_DRAW));
}

@if(!joined)
fn record_of(instance: u32) -> ScreenRecord {
    return point_record(screen_point(drawn_point(instance)));
}

// The point the mark draws at `instance`, or the lit draw does.
@if(!focused)
fn drawn_point(instance: u32) -> Point {
    return shown_point(drawn_instance(instance), false);
}

@if(focused)
fn drawn_point(instance: u32) -> Point {
    return shown_point(focused(mark.focused + instance), true);
}

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> Written {
    let r = record_of(params.source + i);
    let texel = params.destination + i;
    let xy = vec2f(f32(texel % params.size.x), f32(texel / params.size.x)) + 0.5;
    let at = vec4f(xy / vec2f(params.size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
    return Written(at, r.t0, r.t1, r.t2, r.t3);
}

@fragment
fn record(v: Written) -> Texels {
    return Texels(v.t0, v.t1, v.t2, v.t3);
}
