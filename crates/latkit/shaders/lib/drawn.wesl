// Drawn rows: the held row behind each row a mark draws, and its fade while tiles enter and leave.
// A table drawn whole draws held row `i` as drawn row `i`. For a paged table, the program lists the
// runs the mark draws, and `expand_runs` (`compute/lists.wesl`) writes each drawn row's word to the
// lists at `mark.drawn`: its held row, and whether its tile fades in or out.

import package::lib::types::{NONE, DRAWN_ROW, DRAWN_ENTERING, DRAWN_LEAVING};
import package::lib::bind::mark;
import package::lib::lists::lists;

struct DrawnRow {
    row: u32,
    // Opacity and scale factors while its tile fades in or out; 1 otherwise.
    presence: f32,
    growth: f32,
    // Whether its tile is leaving. A leaving row ignores the pointer.
    leaving: bool,
}

// Drawn row `i` of the current mark.
fn drawn_row(i: u32) -> DrawnRow {
    if mark.drawn == NONE {
        return DrawnRow(i, 1.0, 1.0, false);
    }
    let word = lists[mark.drawn + i];
    let entering = (word & DRAWN_ENTERING) != 0u;
    let leaving = (word & DRAWN_LEAVING) != 0u;
    let presence = select(select(1.0, mark.reveal, entering), 1.0 - mark.reveal, leaving);
    return DrawnRow(word & DRAWN_ROW, presence, select(1.0, mark.reveal, entering), leaving);
}

// The held row of the current mark's drawn row `i`.
fn held_row(i: u32) -> u32 {
    if mark.drawn == NONE {
        return i;
    }
    return lists[mark.drawn + i] & DRAWN_ROW;
}
