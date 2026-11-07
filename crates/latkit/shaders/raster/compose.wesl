// Composition writes four byte channels into RGBA8 targets, including packed NV12 planes. Each panel
// draws its rectangle in order. No blending, storage writes, or CPU pixel conversion is needed.
import package::lib::types::Compose;
import package::lib::words::fullscreen;
@group(2) @binding(0) var panel: texture_2d<f32>;
@group(2) @binding(2) var<uniform> compose: Compose;

const LUMA: vec3f = vec3f(0.2126, 0.7152, 0.0722);
const BLUE: f32 = 1.8556;
const RED: f32 = 1.5748;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) @interpolate(flat) plane: u32,
}

@vertex
fn vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) plane: u32) -> Varyings {
    return Varyings(fullscreen(v), plane);
}

fn kept(c: vec4f) -> vec4f {
    if compose.alpha == 0u { return vec4f(c.rgb, 1.0); }
    if c.a <= 0.0 { return vec4f(0.0); }
    return vec4f(c.rgb / c.a, c.a);
}

@fragment
fn rgba(@builtin(position) p: vec4f) -> @location(0) vec4f {
    return kept(textureLoad(panel, vec2i(p.xy) - vec2i(compose.origin), 0));
}

@fragment
fn fill_rgba() -> @location(0) vec4f { return compose.background; }

fn luma(p: vec4f) -> vec4f {
    let at = vec2u(p.xy) * vec2u(4u, 1u) - compose.origin;
    var y = vec4f(0.0);
    for (var k = 0u; k < 4u; k++) { y[k] = dot(textureLoad(panel, at + vec2u(k, 0u), 0).rgb, LUMA); }
    return (16.0 + 219.0 * y) / 255.0;
}

fn chroma(p: vec4f) -> vec4f {
    let at = vec2u(p.xy) * vec2u(4u, 2u) - compose.origin;
    var uv = vec4f(0.0);
    for (var y = 0u; y < 2u; y++) {
        for (var x = 0u; x < 4u; x++) {
            let c = textureLoad(panel, at + vec2u(x, y), 0).rgb;
            let l = dot(c, LUMA);
            uv[x / 2u * 2u] += (c.b - l) / BLUE * 0.25;
            uv[x / 2u * 2u + 1u] += (c.r - l) / RED * 0.25;
        }
    }
    return (128.0 + 224.0 * uv) / 255.0;
}

fn fill_luma() -> vec4f {
    let c = compose.background.rgb * compose.background.a;
    return vec4f((16.0 + 219.0 * dot(c, LUMA)) / 255.0);
}

fn fill_chroma() -> vec4f {
    let c = compose.background.rgb * compose.background.a;
    let y = dot(c, LUMA);
    return (128.0 + 224.0 * vec4f((c.b - y) / BLUE, (c.r - y) / RED, (c.b - y) / BLUE, (c.r - y) / RED)) / 255.0;
}

// Both planes use one program and the same panel bindings. The instance selects a plane
// for the entire fullscreen triangle, so no pixels diverge within a draw.
@fragment
fn yuv(v: Varyings) -> @location(0) vec4f {
    if v.plane == 0u { return luma(v.clip); }
    return chroma(v.clip);
}

@fragment
fn fill_yuv(v: Varyings) -> @location(0) vec4f {
    if v.plane == 0u { return fill_luma(); }
    return fill_chroma();
}
