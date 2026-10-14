// Covering: where a mark crowds many small instances into one cell of the screen, as a dense graph
// does from far out, only the last of them drawn in each crowded cell rasterizes. It covers the
// others, which would only cost the rasterizer, many times over, what nobody sees; a cell a few cross,
// as a line does, keeps them all. The cover pass claims each cell for its last small instance once a
// frame, counting its claims; draws leave out the small instances it covers.

import package::lib::types::{NONE, COVER_CELL, COVER_REACH, COVER_CROWD};
import package::lib::bind::{frame, eye, mark};

// Each covered mark's count of claims made in cells already crowded and of cells made crowded; then
// the last small instance in each of its cells, plus one, 0 for none; then how many claimed each, up
// to a crowd. The mark's `cover` is where its cells start.
@if(covering)
@group(2) @binding(16) var<storage, read_write> cover: array<atomic<u32>>;
@else
@group(2) @binding(16) var<storage, read> cover: array<u32>;

// The cell under screen point `p`, in CSS pixels; NONE off the screen.
fn cover_cell(p: vec2f) -> u32 {
    let c = floor(p * eye.pixel_ratio / COVER_CELL);
    if any(c < vec2f(0.0)) || c.x >= f32(frame.cover_columns) || c.y >= f32(frame.cover_rows) {
        return NONE;
    }
    return u32(c.y) * frame.cover_columns + u32(c.x);
}

// Cells covering the target.
fn cells() -> u32 {
    return frame.cover_columns * frame.cover_rows;
}

// Whether an instance reaching `reach` CSS pixels from its middle is small enough for a later one in
// its cell to cover.
fn small(reach: f32) -> bool {
    return mark.cover != NONE && reach * eye.pixel_ratio <= COVER_REACH;
}

// What a claim did: nothing, as the instance was not small or not on screen; claimed a cell not
// yet crowded; made its cell crowded; or claimed a cell already crowded. Every claim in a crowded
// cell but its last is covered.
const UNCLAIMED: u32 = 0u;
const CLAIMED: u32 = 1u;
const CROWDING: u32 = 2u;
const LATE: u32 = 3u;

// Claims the cell under `middle` for `instance`, when it is small: the last one claiming it keeps it,
// and claims count up to a crowd. Instances claim last first, so most find their cell kept by a later
// one and only read it.
@if(covering)
fn claim(instance: u32, middle: vec2f, reach: f32) -> u32 {
    let cell = cover_cell(middle);
    if !small(reach) || cell == NONE {
        return UNCLAIMED;
    }
    let crowd = mark.cover + cells() + cell;
    var claimed = LATE;
    if atomicLoad(&cover[crowd]) < COVER_CROWD {
        let before = atomicAdd(&cover[crowd], 1u);
        claimed = select(select(LATE, CROWDING, before == COVER_CROWD - 1u), CLAIMED, before + 1u < COVER_CROWD);
    }
    let at = mark.cover + cell;
    if atomicLoad(&cover[at]) < instance + 1u {
        atomicMax(&cover[at], instance + 1u);
    }
    return claimed;
}

// Whether a later small instance of the mark covers `instance`, small, in the crowded cell under
// `middle`.
@if(!covering)
fn covered(instance: u32, middle: vec2f, reach: f32) -> bool {
    let cell = cover_cell(middle);
    return small(reach) && cell != NONE && cover[mark.cover + cells() + cell] >= COVER_CROWD
        && cover[mark.cover + cell] > instance + 1u;
}
