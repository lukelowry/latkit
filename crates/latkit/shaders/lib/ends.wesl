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
// rows at `slots`: how many pages, then each one's slot; then the table of the rows it keeps whose
// pages it does not hold: how many buckets, then each one's place and held row, NONE where empty, a
// place in the first empty bucket from where its bits hash to, as `view/kept.rs` keeps them. NONE
// where it holds the place nowhere; a table drawn whole, with no such list, holds every row as itself.
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
    let buckets = program[kept];
    if buckets == 0u {
        return NONE;
    }
    var b = home(place, buckets);
    // At most four fifths of the buckets are full, so a probe meets an empty one within the table.
    for (var probe = 0u; probe < buckets; probe++) {
        let at = kept + 1u + 2u * b;
        let held = program[at];
        if held == place {
            return program[at + 1u];
        }
        if held == NONE {
            return NONE;
        }
        b += 1u;
        if b == buckets {
            b = 0u;
        }
    }
    return NONE;
}

// The bucket a probe for place `d` starts at among `buckets`, as `view/kept.rs` finds it: its bits
// hashed.
fn home(d: u32, buckets: u32) -> u32 {
    var h = d ^ (d >> 16u);
    h *= 0x7feb352du;
    h ^= h >> 15u;
    h *= 0x846ca68bu;
    return (h ^ (h >> 16u)) % buckets;
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
