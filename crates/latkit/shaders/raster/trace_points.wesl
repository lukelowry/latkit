// Each visible point occupies one texel in the same atlas as network strokes.
import package::lib::bind::mark;
import package::lib::types::WordStep;
import package::lib::drawn::drawn_row;
import package::lib::trace::{trace_sample, projected_sample};

@group(2) @binding(19) var<uniform> params: WordStep;

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) i: u32) -> @builtin(position) vec4f {
    let texel = params.destination + i;
    let pixel = vec2u(texel % params.size.x, texel / params.size.x)
        + vec2u(select(0u, 2u, corner == 1u), u32(corner == 2u));
    return vec4f(vec2f(pixel) / vec2f(params.size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}

@fragment
fn point(@builtin(position) pos: vec4f) -> @location(0) vec4u {
    let i = params.source + u32(pos.y) * params.size.x + u32(pos.x) - params.destination;
    let row = drawn_row(i / mark.trace_points).row;
    return projected_sample(trace_sample(row, i % mark.trace_points));
}
