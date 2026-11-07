// Ascending instance and mark order writes the same winner as a maximum claim key.
import package::lib::types::WordStep;
import package::lib::bind::mark;
import package::lib::words::word_quad;

@group(2) @binding(18) var metadata: texture_2d_array<u32>;
@group(2) @binding(19) var<uniform> params: WordStep;

struct Claim {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) key: vec2u,
}

@vertex
fn vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) row: u32) -> Claim {
    let m = word_quad(metadata, mark.label_metadata + row * 4u);
    var out: Claim;
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    if (m.w & 1u) == 0u { return out; }
    let first = vec2u(m.x & 65535u, m.x >> 16u);
    let last = vec2u(m.y & 65535u, m.y >> 16u);
    let corners = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(0,1), vec2f(1,0), vec2f(1,1));
    let p = mix(vec2f(first), vec2f(last + 1u), corners[v]);
    out.position = vec4f(p / vec2f(params.size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
    out.key = vec2u(mark.index + 1u, row + 1u);
    return out;
}

@fragment
fn claim(v: Claim) -> @location(0) vec4u { return vec4u(v.key, 0u, 0u); }
