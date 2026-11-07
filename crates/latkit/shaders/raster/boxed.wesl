// Scatter already-tested instance hits into idempotent row flags. No geometry is evaluated here.
import package::lib::types::{WordStep, WORD_WIDTH, WORD_HEIGHT};
import package::lib::words::word_quad;
@group(2) @binding(18) var source: texture_2d_array<u32>;
@group(2) @binding(19) var<uniform> params: WordStep;
@vertex
fn vertex(@builtin(instance_index) i: u32) -> @builtin(position) vec4f {
    let culled = vec4f(2.0, 2.0, 2.0, 1.0);
    if i >= params.count { return culled; }
    let result = word_quad(source, i * 4u);
    let row = result.y;
    if result.x == 0u || row / (WORD_WIDTH * WORD_HEIGHT) != params.layer { return culled; }
    let p = vec2f(f32(row % WORD_WIDTH), f32(row / WORD_WIDTH % WORD_HEIGHT)) + 0.5;
    return vec4f(p / vec2f(params.size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}
@fragment
fn boxed_row() -> @location(0) vec4u { return vec4u(1u, 0u, 0u, 0u); }
