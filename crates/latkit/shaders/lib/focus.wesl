// Selection and hover: one word of bits per row.

import package::lib::types::{SELECTED, HOVERED};
import package::lib::bind::{frame, focus, mark};

fn focus_of(row: u32) -> u32 {
    return focus[mark.focus + row];
}

fn is_selected(row: u32) -> bool {
    return (focus_of(row) & SELECTED) != 0u;
}

fn is_hovered(row: u32) -> bool {
    return (focus_of(row) & HOVERED) != 0u;
}

// Rows outside a non-empty selection dim.
fn faded(row: u32) -> f32 {
    return select(1.0, frame.dim, frame.selecting != 0u && !is_selected(row));
}
