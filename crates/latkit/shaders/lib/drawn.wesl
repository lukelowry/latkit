// Drawn rows: which held row each row a mark draws is, and how present it is while tiles come and go.
// A table drawn whole draws each of its rows as the held row of its number. For one drawn in part,
// the program lists the runs it draws, and an expansion of them (`compute/lists.wesl`) leaves each
// drawn row's word in the lists at `mark.drawn`: its held row, and whether its tile fades in or out.

import package::lib::types::{NONE, DRAWN_ROW, DRAWN_ENTERING, DRAWN_LEAVING};
import package::lib::bind::mark;
import package::lib::lists::lists;

struct DrawnRow {
    row: u32,
    // How much of it shows, and how large it grows, as its tile fades in or out; 1 when steady.
    presence: f32,
    growth: f32,
    // Whether its tile is leaving: it no longer answers the pointer.
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

// The held row drawn row `i` of the current mark is.
fn held_row(i: u32) -> u32 {
    if mark.drawn == NONE {
        return i;
    }
    return lists[mark.drawn + i] & DRAWN_ROW;
}
