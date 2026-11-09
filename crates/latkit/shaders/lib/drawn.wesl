// Drawn rows: the held row behind each row a mark draws, and its fade while tiles enter and leave.
// A table drawn whole draws held row `i` as drawn row `i`. For a paged table, the program lists the
// runs the mark draws, and `expand_runs` (`raster/lists.wesl`) writes each drawn row's word to the
// lists at `mark.drawn`: its held row, and whether its tile fades in or out.
//
// Where a mark's rows stand at different heights, it draws its instances lowest first, in the
// height order `raster/lists.wesl` sorts at `mark.height_order`. Draws and probes read each
// position's instance through `drawn_instance`.

import package::lib::types::{NONE, DRAWN_ROW, DRAWN_ENTERING, DRAWN_LEAVING, LIST_HEADER};
import package::lib::bind::mark;
import package::lib::lists::list;

// The instance the current mark draws at position `position`. Like column reads, these read the
// list and select, with no branch around the read (see `lib/read.wesl`).
fn drawn_instance(position: u32) -> u32 {
    return select(list(mark.height_order + LIST_HEADER + position), position, mark.height_order == NONE);
}

struct DrawnRow {
    row: u32,
    // Opacity and scale factors while its tile fades in or out. 1 otherwise.
    presence: f32,
    growth: f32,
    // Whether its tile is leaving. A leaving row ignores the pointer.
    leaving: bool,
}

// Drawn row `i` of the current mark.
fn drawn_row(i: u32) -> DrawnRow {
    let whole = mark.drawn == NONE;
    let word = select(list(mark.drawn + i), i & DRAWN_ROW, whole);
    let entering = (word & DRAWN_ENTERING) != 0u;
    let leaving = (word & DRAWN_LEAVING) != 0u;
    let presence = select(select(1.0, mark.reveal, entering), 1.0 - mark.reveal, leaving);
    return DrawnRow(select(word & DRAWN_ROW, i, whole), presence, select(1.0, mark.reveal, entering), leaving);
}

// The held row of the current mark's drawn row `i`.
fn held_row(i: u32) -> u32 {
    return select(list(mark.drawn + i) & DRAWN_ROW, i, mark.drawn == NONE);
}
