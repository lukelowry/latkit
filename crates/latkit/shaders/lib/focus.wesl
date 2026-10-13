// Selection and hover: one word of bits per row; and how present a row is while its mark eases.

import package::lib::types::{SELECTED, HOVERED, FADE_IN, FADE_OUT};
import package::lib::bind::{frame, focus, mark};

fn focus_of(row: u32) -> u32 {
    if row >= mark.rows {
        return 0u;
    }
    return focus[mark.focus + row];
}

fn is_selected(row: u32) -> bool {
    return (focus_of(row) & SELECTED) != 0u;
}

fn is_hovered(row: u32) -> bool {
    return (focus_of(row) & HOVERED) != 0u;
}

// How much of a row shows while its mark eases: rows appearing fade in, rows leaving fade out.
fn presence(flags: u32) -> f32 {
    if (flags & FADE_IN) != 0u {
        return mark.motion;
    }
    if (flags & FADE_OUT) != 0u {
        return 1.0 - mark.motion;
    }
    return 1.0;
}

// A row's opacity: rows outside a non-empty selection dim, and rows easing in or out fade.
fn faded(row: u32, flags: u32) -> f32 {
    let dim = select(1.0, frame.dim, frame.selecting != 0u && !is_selected(row));
    return dim * presence(flags);
}
