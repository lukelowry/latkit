// Resolves each end of an edge row to a held row of the vertex mark that draws the end's
// table. A row's ends name places in that table's order, and places stay fixed as the camera moves.
// Their held rows change as the camera moves, because the vertex mark makes other pages and kept
// rows resident in its slots. So no channel stores an end's held row. The expression machine's
// end step resolves it for the rows whose ends changed, and for every row once the vertices moved.
// It writes end `k` into the row's kind word `k`, which draws and probes read.

import package::lib::types::{NONE, PAGE_BITS, PAGE_MASK, END_WORDS, END_STATE, END_SLOTS, END_COLUMN};
import package::lib::bind::{program, mark, pages};
import package::lib::state::record_at;
import package::lib::read::bits_value;

// The held row of place `place`, from the end table at `slots`. The end table holds the page
// count, then each page's slot (NONE when not resident), then the kept-row hash table: the bucket
// count, then each bucket's place and held row (NONE where empty). A place sits in the first empty
// bucket at or after its hash, as `view/kept.rs` lays them out. Returns NONE when the place is not
// resident. Without an end table (a table drawn whole), each place is its own held row.
fn held_of(slots: u32, place: u32) -> u32 {
    if slots == NONE || place == NONE {
        return place;
    }
    let pages = program(slots);
    let page = place >> PAGE_BITS;
    if page < pages {
        let slot = program(slots + 1u + page);
        if slot != NONE {
            return (slot << PAGE_BITS) | (place & PAGE_MASK);
        }
    }
    let kept = slots + 1u + pages;
    let buckets = program(kept);
    if buckets == 0u {
        return NONE;
    }
    var b = home(place, buckets);
    // At most four fifths of the buckets are full, so a probe always reaches an empty bucket.
    for (var probe = 0u; probe < buckets; probe++) {
        let at = kept + 1u + 2u * b;
        let held = program(at);
        if held == place {
            return program(at + 1u);
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

// The bucket where a probe for place `d` starts: a hash of `d`, matching `view/kept.rs`.
fn home(d: u32, buckets: u32) -> u32 {
    var h = d ^ (d >> 16u);
    h *= 0x7feb352du;
    h ^= h >> 15u;
    h *= 0x846ca68bu;
    return (h ^ (h >> 16u)) % buckets;
}

