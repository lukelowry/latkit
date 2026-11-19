// The still: what a view draws up to a cut in its marks, as the frame that drew it left it. A frame
// that starts from it draws only what follows the cut (see `view/still.rs`).

import package::lib::words::fullscreen;

@group(2) @binding(10) var still: texture_2d<f32>;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    return fullscreen(i);
}

// The still's pixel, as stored: it is the frame's own color, so nothing converts.
@fragment
fn fragment(@builtin(position) at: vec4f) -> @location(0) vec4f {
    return textureLoad(still, vec2i(at.xy), 0);
}
