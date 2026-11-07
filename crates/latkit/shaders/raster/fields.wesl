// Exact, bounded signed-distance transform. Two instanced draws cover just the new glyph
// rectangles: vertical minima into an integer target, then horizontal minima into the atlas.
// Coverage stays packed in words; neither pass needs a float render-target extension.
import package::lib::types::TEXT_SPREAD;
import package::lib::words::{word_read, word_quad};

@group(2) @binding(0) var runs: texture_2d_array<u32>;
@if(!columns)
@group(2) @binding(1) var minima: texture_2d<u32>;

struct Target { size: vec2f, padding: vec2f }
@group(2) @binding(2) var<uniform> viewport: Target;

struct Field {
    @builtin(position) position: vec4f,
    // Coverage offset, width, height, unused.
    @location(0) @interpolate(flat) run: vec4u,
    // Permanent atlas corner, then this batch's compact column-minima corner.
    @location(1) @interpolate(flat) corners: vec4u,
}

@vertex
fn vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Field {
    let run = word_quad(runs, i * 8u);
    let placement = word_quad(runs, i * 8u + 4u);
    @if(columns)
    let corner = placement.zw;
    @if(!columns)
    let corner = placement.xy;
    let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
    let p = vec2f(corner) + corners[v] * (vec2f(run.yz) + vec2f(2.0 * TEXT_SPREAD));
    return Field(vec4f(p / viewport.size * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0, 1), run, placement);
}

const SPREAD: i32 = i32(TEXT_SPREAD);
const FAR: f32 = 1e20;

@if(columns)
fn own(run: vec4u, p: vec2i) -> vec2f {
    let q = p - vec2i(SPREAD);
    if any(q < vec2i(0)) || any(q >= vec2i(run.yz)) { return vec2f(FAR, 0.0); }
    let i = u32(q.y) * run.y + u32(q.x);
    let byte = (word_read(runs, run.x + i / 4u) >> (8u * (i % 4u))) & 255u;
    if byte == 255u { return vec2f(0.0, FAR); }
    if byte == 0u { return vec2f(FAR, 0.0); }
    let d = 0.5 - f32(byte) / 255.0;
    return select(vec2f(0.0, d * d), vec2f(d * d, 0.0), d > 0.0);
}

@if(columns)
@fragment
fn columns(field: Field) -> @location(0) u32 {
    let p = vec2i(field.position.xy) - vec2i(field.corners.zw);
    let size = vec2i(field.run.yz) + vec2i(2 * SPREAD);
    var least = vec2f(FAR);
    for (var dy = -SPREAD; dy <= SPREAD; dy++) {
        let y = p.y + dy;
        if y >= 0 && y < size.y { least = min(least, own(field.run, vec2i(p.x, y)) + f32(dy * dy)); }
    }
    return bitcast<u32>(least.y - least.x);
}

@if(!columns)
@fragment
fn rows(field: Field) -> @location(0) f32 {
    let p = vec2i(field.position.xy) - vec2i(field.corners.xy) + vec2i(field.corners.zw);
    let left = i32(field.corners.z);
    let right = left + i32(field.run.y) + 2 * SPREAD;
    var least = vec2f(FAR);
    for (var dx = -SPREAD; dx <= SPREAD; dx++) {
        let x = p.x + dx;
        if x >= left && x < right {
            let s = bitcast<f32>(textureLoad(minima, vec2i(x, p.y), 0).x);
            least = min(least, vec2f(max(-s, 0.0), max(s, 0.0)) + f32(dx * dx));
        }
    }
    let d = sqrt(least.y) - sqrt(least.x);
    return floor(clamp(0.5 + d / (2.0 * TEXT_SPREAD), 0.0, 1.0) * 255.0 + 0.5) / 255.0;
}
