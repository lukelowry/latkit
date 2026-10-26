// Areas: one instanced triangle per area triangle, numbered by the mark's list, flat on the ground
// in its row's color and lit by the earth's daylight. Areas lie under anything drawn after them:
// they test depth but do not write it. The focus variant redraws the lit rows' triangles over
// everything, tinted toward the theme's focus colors.

import package::lib::types::{SELECTED, HOVERED};
import package::lib::bind::frame;
import package::lib::project::culled;
import package::lib::triangles::{triangle_corner, triangle_shown, corner_clip};
import package::lib::focus::focus_of;
import package::lib::daylight::daylight;
import package::lib::color::output;

struct Varyings {
    @builtin(position) clip: vec4f,
    @location(0) color: vec4f,
    @location(1) @interpolate(flat) row: u32,
    // The row's focus bits, which choose the focus draw's tint.
    @location(2) @interpolate(flat) focus: u32,
}

@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
    var out: Varyings;
    let c = triangle_corner(instance, corner);
    out.row = c.row;
    if !triangle_shown(instance) {
        out.clip = culled();
        return out;
    }
    out.clip = corner_clip(c);
    out.color = vec4f(c.color.rgb * daylight(c.position.xy), c.color.a);
    out.focus = focus_of(c.row);
    return out;
}

@if(!focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    return output(vec4f(v.color.rgb * v.color.a, v.color.a));
}

@if(focused)
@fragment
fn fragment(v: Varyings) -> @location(0) vec4f {
    var rgb = v.color.rgb;
    let focus = v.focus;
    if (focus & SELECTED) != 0u {
        // A selected color with a negative red means each row's own color, brightened.
        let tint = select(frame.selected.rgb, min(rgb * 1.6 + 0.08, vec3f(1.0)), frame.selected.r < 0.0);
        rgb = mix(rgb, tint, 0.5);
    } else if (focus & HOVERED) != 0u {
        rgb = mix(rgb, frame.hover.rgb, 0.6 * frame.hover.a);
    }
    return output(vec4f(rgb * v.color.a, v.color.a));
}
