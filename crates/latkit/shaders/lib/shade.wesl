// A mark's shade: `fn shade(f: ShadeFragment) -> vec4f`, which an application defines (see
// `lib/hooks.wesl`), given each pixel of the mark before it blends. The shaded variants of the draw
// shaders call it.

import package::lib::hooks::ShadeFragment;
import package::lib::bind::{frame, eye, mark};
import package::lib::state::row_inputs;

// The pixel at target position `position` of held row `row` of the current mark, colored `color`
// (straight), at `local` within its row's shape, as its shade sees it.
fn shade_fragment(color: vec4f, position: vec2f, local: vec2f, row: u32) -> ShadeFragment {
    // The pointer sits far off the view while it is elsewhere.
    let over = select(0.0, 1.0, frame.pointer.x > -1e8);
    return ShadeFragment(
        color,
        position / eye.pixel_ratio,
        local,
        vec3f(frame.pointer, over),
        frame.elapsed,
        row_inputs(row, mark.shade_input, mark.shade_inputs),
    );
}
