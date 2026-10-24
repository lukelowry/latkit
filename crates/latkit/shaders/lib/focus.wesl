// Selection and hover: one word of bits per held row, in pages the page table at `mark.focus` lists;
// and how present a row is while its mark eases.

import package::lib::types::{SELECTED, HOVERED, FADE_IN, FADE_OUT};
import package::lib::bind::{frame, mark, word};
import package::lib::state::record_at;

// The focus bits of held row `row`; none for a row that left.
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

// How large a row shows while its mark eases: rows appearing grow from nothing. Draws grow them, so
// a mark whose rows only appear evaluates once.
fn growth(flags: u32) -> f32 {
    return select(1.0, mark.motion, (flags & FADE_IN) != 0u);
}

// A row's opacity: rows outside a non-empty selection dim, and rows easing in or out fade.
fn faded(row: u32, flags: u32) -> f32 {
    let dim = select(1.0, frame.dim, frame.selecting != 0u && !is_selected(row));
    return dim * presence(flags);
}
