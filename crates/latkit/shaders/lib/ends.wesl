// Where each end of an edge or a face row is held: the row of the vertex mark drawing the end's table
// that holds the vertex the row names. A row's ends name places in the order that table draws in,
// which stay put as the camera moves; the vertex mark holds its pages and the rows it keeps where its
// drawing lays them out, which do not. So no channel stores where an end is held: the expression
// machine's end step finds it, for the rows whose ends changed, and for every row once the vertices
// moved, and writes it into the row's kind word of the end's number, which draws, probes, and normals
// read.

import package::lib::types::{NONE, PAGE_BITS, PAGE_MASK, MARK_FACES, END_WORDS, END_STATE, END_SLOTS, END_COLUMN};
import package::lib::bind::{program, mark, pages};
import package::lib::state::record_at;
import package::lib::read::bits_value;

// Where place `place` of the order a table is drawn in is held, by where the program lists its held
// rows at `slots`: how many pages, then each one's slot; then how many rows it keeps whose pages it
// does not hold, then each one's place and held row, ascending by place. NONE where it holds the
// place nowhere; a table drawn whole, with no such list, holds every row as itself.
fn held_of(slots: u32, place: u32) -> u32 {
    if slots == NONE || place == NONE {
        return place;
    }
    let pages = program[slots];
    let page = place >> PAGE_BITS;
    if page < pages {
        let slot = program[slots + 1u + page];
        if slot != NONE {
            return (slot << PAGE_BITS) | (place & PAGE_MASK);
        }
    }
    let kept = slots + 1u + pages;
    let count = program[kept];
    var lo = 0u;
    var hi = count;
    while lo < hi {
        let mid = (lo + hi) / 2u;
        if program[kept + 1u + 2u * mid] < place {
            lo = mid + 1u;
        } else {
            hi = mid;
        }
    }
    if lo < count && program[kept + 1u + 2u * lo] == place {
        return program[kept + 2u + 2u * lo];
    }
    return NONE;
}

// Writes where each end of live row `row` of the current mark is held: an edge's two, a face's three
// corners.
fn resolve(row: u32) {
    let at = record_at(mark.state, mark.stride + mark.extras, row);
    let ends = select(2u, 3u, mark.kind == MARK_FACES);
    for (var k = 0u; k < ends; k++) {
        let e = mark.ends + END_WORDS * k;
        let column = program[e + END_COLUMN];
        // A pole's end is its own row, held where its row is.
        var held = row;
        if column != NONE {
            held = held_of(program[e + END_SLOTS], bits_value(column, row));
        }
        pages[at + k] = select(held, NONE, program[e + END_STATE] == NONE);
    }
}
