// Selection and hover: one word of focus bits per held row, in pages listed by the page table at
// `mark.focus`. Also how much of a row shows during a transition.

import package::lib::types::{SELECTED, HOVERED, FADE_IN, FADE_OUT};
import package::lib::bind::{frame, mark, word};
import package::lib::state::record_at;

// The focus bits of held row `row`. None for a row that left.
fn focus_of(row: u32) -> u32 {
    if row >= mark.held - mark.exits {
        return 0u;
    }
    return word(record_at(mark.focus, 1u, row));
}

fn is_selected(row: u32) -> bool {
    return (focus_of(row) & SELECTED) != 0u;
}

fn is_hovered(row: u32) -> bool {
    return (focus_of(row) & HOVERED) != 0u;
}

// A row's opacity factor during a transition: appearing rows fade in, leaving rows fade out.
fn presence(flags: u32) -> f32 {
    if (flags & FADE_IN) != 0u {
        return mark.motion;
    }
    if (flags & FADE_OUT) != 0u {
        return 1.0 - mark.motion;
    }
    return 1.0;
}

// A row's scale factor during a transition: appearing rows grow from nothing. Draws apply it, so a
// mark whose rows only appear evaluates once.
fn growth(flags: u32) -> f32 {
    return select(1.0, mark.motion, (flags & FADE_IN) != 0u);
}

// A row's opacity: rows outside a non-empty selection dim, and rows easing in or out fade.
fn faded(row: u32, flags: u32) -> f32 {
    let dim = select(1.0, frame.dim, frame.selecting != 0u && !is_selected(row));
    return dim * presence(flags);
}
