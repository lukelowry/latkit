// One level of the shadow map from the level below: coverage averaged, so it softens; the lowest
// caster kept, and the highest.

@group(2) @binding(11) var below: texture_2d<f32>;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let size = vec2i(textureDimensions(below)) - 1;
    let at = vec2i(p.xy) * 2;
    let a = textureLoad(below, min(at, size), 0);
    let b = textureLoad(below, min(at + vec2i(1, 0), size), 0);
    let c = textureLoad(below, min(at + vec2i(0, 1), size), 0);
    let d = textureLoad(below, min(at + vec2i(1, 1), size), 0);
    return vec4f((a.r + b.r + c.r + d.r) * 0.25, min(min(a.g, b.g), min(c.g, d.g)), min(min(a.b, b.b), min(c.b, d.b)), 0.0);
}
