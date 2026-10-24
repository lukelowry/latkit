//! Pyramids: a table's rows grouped into tiles by the coarsest level each shows at, worked out in a
//! job, a dataset's tables in one. Each level splits the tiles above it four ways, and each tile
//! holds a grid of cells, a row to a cell. Rows land by priority: each at the coarsest level where its
//! cell is free, so what matters more shows from farther out, and rows crowding one cell wait for a
//! finer level, where they spread over cells of their own. A row never lands finer than its size
//! allows, so its tile grown by half its own size holds it whole. An edge lands by its own priority,
//! in the cell of its middle, and edges joining the same two vertices land together; a vertex lands
//! no finer than the coarsest edge ending at it, so the ends of every edge drawn show from as far out
//! as it does. A table drawn whole by priority is one tile, its rows in priority order.
//!
//! A pyramid is an order: rows by tile, coarsest level first, each tile's rows together, and the
//! place of each row in it. The camera chooses tiles, each a range of the order.

use std::ops::Range;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::sight::{Domain, Region, Sight, TILE_PX, meets};
use crate::data::{UNWIRED, Version};
use crate::gpu::shaders::PAGE_ROWS;
use crate::tiles::TileKey;

/// Cells across a tile's grid, as a shift: a tile holds at most `4^GRID_BITS` rows of its level, but
/// for the ends of edges, which land with them.
pub(crate) const GRID_BITS: u32 = 7;
/// The finest level.
pub(crate) const MAX_LEVEL: u8 = 24;
/// A level no row has landed at yet.
const NEVER: u8 = u8::MAX;
/// Tiles a camera may ask a pyramid for at most: past it, tiles stop splitting.
const MAX_TILES: usize = 1024;
/// Cells across a tile's grid of sub-cells, as a shift: the parts of a tile the camera may ask for
/// alone, each a range of the order, so what draws of a large tile is what the camera sees of it.
const SUB_BITS: u32 = 3;
/// Rows past which a tile is asked for a sub-cell at a time.
const SUB_ROWS: usize = 256;

/// What a pyramid job places: tables of rows in a square of their space.
#[derive(Clone, Debug)]
pub(crate) struct Leveling {
    pub(crate) domain: Domain,
    /// The tables, every table an edge table's ends name before it.
    pub(crate) tables: Vec<Placing>,
}

/// Where a table's rows lie, in position units: none where nothing places them, a point each, or the
/// box a geometry spans (west, south, east, north). NaN places nothing. Single precision places a
/// row within a centimeter on the earth, finer than any tile's cell.
#[derive(Clone, Debug, Default)]
pub(crate) enum Places {
    #[default]
    None,
    Points(Arc<[[f32; 2]]>),
    Boxes(Arc<[[f32; 4]]>),
}

/// One table a pyramid job places.
#[derive(Clone, Debug, Default)]
pub(crate) struct Placing {
    pub(crate) rows: u32,
    /// Whether its rows land in tiles by level; else every row is one tile, in priority order.
    pub(crate) leveled: bool,
    /// Whether the answer holds its pyramid: a table placed only for the edges ending at it is not.
    pub(crate) answered: bool,
    pub(crate) places: Places,
    /// Each row's priority, higher first; none where rows are alike.
    pub(crate) priority: Arc<[f32]>,
    /// For a table placed by its ends, the table they name and each end's rows there.
    pub(crate) ends: Option<(u32, Vec<Arc<[u32]>>)>,
}

/// Where each row of `places` lies across `domain`'s square, fixed point (a turn of `u32` spans it,
/// from the west and from the north), and half its size alike; nothing where it lies nowhere.
fn anchored(places: &Places, domain: &Domain) -> (Vec<[u32; 2]>, Vec<u32>) {
    let fixed = |u: f64| (u.clamp(0.0, 1.0) * 4_294_967_295.0) as u32;
    match places {
        Places::None => (Vec::new(), Vec::new()),
        Places::Points(points) => {
            let anchors = points
                .iter()
                .map(|p| p.map(f64::from))
                .map(|p| if p.iter().all(|v| v.is_finite()) { domain.unit(p).map(fixed) } else { [0, 0] })
                .collect();
            (anchors, Vec::new())
        }
        Places::Boxes(boxes) => boxes
            .iter()
            .map(|b| {
                let b = b.map(f64::from);
                if b.iter().any(|v| !v.is_finite()) || b[0] > b[2] {
                    return ([0, 0], 0);
                }
                let (lo, hi) = (domain.unit([b[0], b[1]]), domain.unit([b[2], b[3]]));
                let center = [lo[0].midpoint(hi[0]), lo[1].midpoint(hi[1])];
                (center.map(fixed), fixed((hi[0] - lo[0]).abs().max((hi[1] - lo[1]).abs()) / 2.0))
            })
            .unzip(),
    }
}

/// Where one table's rows lie across the square, how far each reaches, the coarsest level each may
/// land at, and for an edge table each row's pair of ends.
struct Anchored {
    anchors: Vec<[u32; 2]>,
    extents: Vec<u32>,
    floor: Vec<u8>,
    pairs: Option<Vec<u64>>,
}

/// The pyramid of each table a job answered for, by its place among the tables asked.
pub(crate) fn answer(leveling: &Leveling) -> Vec<(u32, Pyramid)> {
    let wraps = leveling.domain == Domain::Earth;
    let tables = &leveling.tables;
    let mut placed: Vec<Anchored> = Vec::with_capacity(tables.len());
    for table in tables {
        let n = table.rows as usize;
        let anchoring = if let Some((target, ends)) = &table.ends {
            let Some(at) = placed.get(*target as usize).map(|a| &a.anchors) else { return Vec::new() };
            let (anchors, extents) = by_ends(ends, at, wraps, n);
            // A row with an end naming no row draws nothing: it lands only at the finest level.
            let floor = (0..n)
                .map(|r| {
                    let wired = ends.iter().all(|end| end.get(r).is_some_and(|&t| (t as usize) < at.len()));
                    if wired { 0 } else { NEVER }
                })
                .collect();
            let pairs = (ends.len() == 2).then(|| pairs(&ends[0], &ends[1]));
            Anchored { anchors, extents, floor, pairs }
        } else {
            let (anchors, extents) = anchored(&table.places, &leveling.domain);
            Anchored { anchors, extents, floor: vec![0; n], pairs: None }
        };
        placed.push(anchoring);
    }
    let leveled = |i: usize| tables[i].leveled && placed[i].anchors.len() == tables[i].rows as usize;
    let mut sorted: Vec<Vec<(u64, u32)>> = Vec::with_capacity(tables.len());
    let mut ranked: Vec<Vec<u64>> = Vec::with_capacity(tables.len());
    for (i, table) in tables.iter().enumerate() {
        sorted.push(if leveled(i) { along(&placed[i].anchors) } else { Vec::new() });
        ranked.push(ranks(&table.priority, table.rows as usize));
    }
    let level_of = |i: usize, ceiling: &[u8]| -> Vec<u8> {
        if !leveled(i) {
            return vec![0; tables[i].rows as usize];
        }
        let a = &placed[i];
        place(&sorted[i], &a.extents, &ranked[i], &a.floor, a.pairs.as_deref(), ceiling)
    };
    // Edges land first: a vertex lands no finer than the coarsest edge ending at it.
    let mut levels: Vec<Option<Vec<u8>>> = vec![None; tables.len()];
    let mut ceilings: Vec<Vec<u8>> = vec![Vec::new(); tables.len()];
    for (i, table) in tables.iter().enumerate() {
        let Some((target, ends)) = &table.ends else { continue };
        let level = level_of(i, &[]);
        let target = *target as usize;
        if leveled(i) && leveled(target) {
            let ceiling = &mut ceilings[target];
            ceiling.resize(tables[target].rows as usize, MAX_LEVEL);
            for end in ends {
                for (r, &t) in end.iter().enumerate() {
                    if let Some(c) = ceiling.get_mut(t as usize).filter(|_| t != UNWIRED) {
                        *c = (*c).min(level[r]);
                    }
                }
            }
        }
        levels[i] = Some(level);
    }
    let mut out = Vec::new();
    for (i, table) in tables.iter().enumerate() {
        let level = levels[i].take().unwrap_or_else(|| level_of(i, &ceilings[i]));
        if !table.answered {
            continue;
        }
        let (order, tiles) = if leveled(i) {
            tiled(&sorted[i], &placed[i].anchors, &placed[i].extents, &ranked[i], &level)
        } else {
            let mut order: Vec<u32> = (0..table.rows).collect();
            crate::order::by_key(&mut order, |&r| ranked[i][r as usize]);
            let whole = Tile { key: TileKey { z: 0, x: 0, y: 0 }, rows: 0..table.rows, reach: 1.0, cells: Vec::new() };
            (order, vec![whole])
        };
        out.push((i as u32, Pyramid::new(order, tiles)));
    }
    out
}

/// Where each of `n` rows placed by `ends` lies, among rows anchored at `at`: the middle of the box
/// its ends span, and half that box's size. An end naming no row anchors nothing.
fn by_ends(ends: &[Arc<[u32]>], at: &[[u32; 2]], wraps: bool, n: usize) -> (Vec<[u32; 2]>, Vec<u32>) {
    let mut anchors = Vec::with_capacity(n);
    let mut extents = Vec::with_capacity(n);
    for r in 0..n {
        let wired = !ends.is_empty() && ends.iter().all(|end| end.get(r).is_some_and(|&t| (t as usize) < at.len()));
        if !wired {
            anchors.push([0, 0]);
            extents.push(0);
            continue;
        }
        // The box of offsets from the end of the lowest row, the short way round where the square
        // wraps: the same whichever way the row joins its ends.
        let first = at[ends.iter().map(|end| end[r]).min().unwrap_or(0) as usize];
        let (mut lo, mut hi) = ([0_i64; 2], [0_i64; 2]);
        for end in ends {
            let t = at[end[r] as usize];
            let du = if wraps {
                i64::from(t[0].wrapping_sub(first[0]) as i32)
            } else {
                i64::from(t[0]) - i64::from(first[0])
            };
            let dv = i64::from(t[1]) - i64::from(first[1]);
            lo = [lo[0].min(du), lo[1].min(dv)];
            hi = [hi[0].max(du), hi[1].max(dv)];
        }
        let mid = [lo[0].midpoint(hi[0]), lo[1].midpoint(hi[1])];
        let u = if wraps {
            first[0].wrapping_add(mid[0] as i32 as u32)
        } else {
            (i64::from(first[0]) + mid[0]).clamp(0, i64::from(u32::MAX)) as u32
        };
        let v = (i64::from(first[1]) + mid[1]).clamp(0, i64::from(u32::MAX)) as u32;
        anchors.push([u, v]);
        extents.push(((hi[0] - lo[0]).max(hi[1] - lo[1]) / 2).min(i64::from(u32::MAX)) as u32);
    }
    (anchors, extents)
}

/// For each row, the next row joining the same two vertices, round to itself: a cycle per pair. Such
/// rows share their anchor, so they lie side by side along the curve.
fn mates(sorted: &[(u64, u32)], pairs: &[u64]) -> Vec<u32> {
    let mut mates: Vec<u32> = (0..sorted.len() as u32).collect();
    let mut i = 0;
    while i < sorted.len() {
        let mut j = i + 1;
        while j < sorted.len() && sorted[j].0 == sorted[i].0 {
            j += 1;
        }
        if j - i > 1 {
            let mut alike: Vec<u32> = sorted[i..j].iter().map(|&(_, r)| r).collect();
            crate::order::by_key(&mut alike, |&r| pairs[r as usize]);
            let mut k = 0;
            while k < alike.len() {
                let pair = pairs[alike[k] as usize];
                let end = k + alike[k..].partition_point(|&r| pairs[r as usize] == pair);
                for g in k..end {
                    mates[alike[g] as usize] = alike[if g + 1 < end { g + 1 } else { k }];
                }
                k = end;
            }
        }
        i = j;
    }
    mates
}

/// Each row's pair of ends, the same whichever way it joins them.
fn pairs(from: &[u32], to: &[u32]) -> Vec<u64> {
    from.iter().zip(to).map(|(&a, &b)| u64::from(a.min(b)) << 32 | u64::from(a.max(b))).collect()
}

/// A hash of `row`, for breaking ties evenly.
fn tie(row: u32) -> u32 {
    (u64::from(row).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32) as u32
}

/// Each of `n` rows' rank, higher first: its priority, missing lowest, then the hash of its place,
/// so equals spread evenly.
fn ranks(priority: &[f32], n: usize) -> Vec<u64> {
    (0..n)
        .map(|r| {
            let p = priority.get(r).copied().filter(|p| !p.is_nan()).map_or(0, |p| {
                let bits = p.to_bits();
                if bits >> 31 == 1 { !bits } else { bits | 0x8000_0000 }
            });
            u64::from(p) << 32 | u64::from(tie(r as u32))
        })
        .collect()
}

/// Rows along the curve, by their place on it.
fn along(anchors: &[[u32; 2]]) -> Vec<(u64, u32)> {
    let mut sorted: Vec<(u64, u32)> = anchors.iter().enumerate().map(|(r, &a)| (morton(a), r as u32)).collect();
    sorted.sort_unstable();
    sorted
}

/// The finest level whose tile, grown by half its size, holds a row reaching `extent` from its
/// anchor.
fn fit(extent: u32) -> u8 {
    (0..=MAX_LEVEL).rev().find(|&z| u64::from(extent) <= 1_u64 << (31 - u32::from(z))).unwrap_or(0)
}

/// `x`'s bits spread to every other bit.
fn spread_bits(x: u32) -> u64 {
    let mut x = u64::from(x);
    x = (x | (x << 16)) & 0x0000_FFFF_0000_FFFF;
    x = (x | (x << 8)) & 0x00FF_00FF_00FF_00FF;
    x = (x | (x << 4)) & 0x0F0F_0F0F_0F0F_0F0F;
    x = (x | (x << 2)) & 0x3333_3333_3333_3333;
    (x | (x << 1)) & 0x5555_5555_5555_5555
}

/// The point's place along the curve that visits every cell of a level before the next cell of the
/// level above: cells at every level are runs of it.
fn morton([u, v]: [u32; 2]) -> u64 {
    spread_bits(u) | spread_bits(v) << 1
}

/// The tile at level `z` holding a point anchored at `anchor`.
fn tile_of(anchor: [u32; 2], z: u8) -> TileKey {
    let shift = 32 - u32::from(z);
    let at = |c: u32| if shift >= 32 { 0 } else { c >> shift };
    TileKey { z, x: at(anchor[0]), y: at(anchor[1]) }
}

/// A tile as a job's answer numbers it: in 53 bits, so a number holds it exactly.
pub(crate) fn pack(key: TileKey) -> u64 {
    u64::from(key.z) << 48 | u64::from(key.x) << 24 | u64::from(key.y)
}

fn unpack(key: u64) -> TileKey {
    TileKey { z: (key >> 48) as u8, x: ((key >> 24) & 0xFF_FFFF) as u32, y: (key & 0xFF_FFFF) as u32 }
}

/// The level each row lands at: rows in each cell of each level, coarsest first, give way by rank; a
/// row lands at the first level where it outranks every row left in its cell, no coarser than
/// `floor`, and no finer than its size allows or `ceiling` says, where it lands when it has not by
/// then.
///
/// Rows along the curve are taken in runs, each the rows left in one cell. While a run stays in one
/// cell level after level, those levels take its highest rows in rank order at once; where it
/// spreads over several cells, each cell's rows go on as a run of their own. So a crowd sharing a
/// cell for many levels costs its size once, not once a level.
fn place(
    sorted: &[(u64, u32)],
    extents: &[u32],
    ranks: &[u64],
    floor: &[u8],
    pairs: Option<&[u64]>,
    ceiling: &[u8],
) -> Vec<u8> {
    let n = sorted.len();
    let fits: Vec<u8> = (0..n)
        .map(|r| {
            let own = extents.get(r).map_or(MAX_LEVEL, |&e| fit(e));
            own.min(ceiling.get(r).copied().unwrap_or(MAX_LEVEL))
        })
        .collect();
    let forcing = !extents.is_empty() || !ceiling.is_empty();
    let mates = pairs.map(|pairs| mates(sorted, pairs)).unwrap_or_default();
    let mut level = vec![NEVER; n];
    let mut work: Vec<(u64, u32)> = sorted.to_vec();
    let mut runs: Vec<(usize, usize, u8)> = vec![(0, n, 0)];
    let mut scratch: Vec<(u64, u32)> = Vec::new();
    let mut forced: Vec<u32> = Vec::new();
    // Lands row `r` at level `l`, with the rows joining the same two vertices.
    let land = |r: u32, l: u8, level: &mut [u8]| {
        level[r as usize] = l;
        let mut m = mates.get(r as usize).copied().unwrap_or(r);
        while m != r {
            if level[m as usize] == NEVER {
                level[m as usize] = l;
            }
            m = mates[m as usize];
        }
    };
    while let Some((a, mut b, mut z)) = runs.pop() {
        while a < b && z <= MAX_LEVEL {
            let (first, last) = (work[a].0, work[b - 1].0);
            let common = if first == last { 64 } else { (first ^ last).leading_zeros() };
            // The finest level whose cells hold the whole run.
            let single = i64::from(common / 2) - i64::from(GRID_BITS);
            if single < i64::from(z) {
                // The run spreads over several cells of this level: each goes on alone.
                let shift = 2 * (32 - u32::from(z) - GRID_BITS);
                let mut i = a;
                while i < b {
                    let cell = work[i].0 >> shift;
                    let j = i + work[i..b].partition_point(|&(m, _)| m >> shift <= cell);
                    runs.push((i, j, z));
                    i = j;
                }
                b = a;
                break;
            }
            let deepest = single.min(i64::from(MAX_LEVEL)) as u8;
            // One row a level, in rank order: for one level the highest, for more a heap of them.
            if deepest == z {
                let best = work[a..b]
                    .iter()
                    .filter(|&&(_, r)| floor[r as usize] == 0)
                    .max_by_key(|&&(_, r)| ranks[r as usize])
                    .map(|&(_, r)| r);
                if let Some(r) = best {
                    land(r, z, &mut level);
                }
            } else {
                scratch.clear();
                scratch.extend(
                    work[a..b].iter().map(|&(_, r)| (ranks[r as usize], r)).filter(|&(_, r)| floor[r as usize] == 0),
                );
                let mut heap = std::collections::BinaryHeap::from(std::mem::take(&mut scratch));
                for l in z..=deepest {
                    // A row too large for this level lands where its size says, below.
                    while let Some((_, r)) = heap.pop() {
                        if level[r as usize] == NEVER && fits[r as usize] >= l {
                            land(r, l, &mut level);
                            break;
                        }
                    }
                }
                scratch = heap.into_vec();
            }
            // Rows no finer level may hold land where their size or their edges say.
            if forcing {
                forced.clear();
                forced.extend(work[a..b].iter().map(|&(_, r)| r).filter(|&r| fits[r as usize] <= deepest));
                for &r in &forced {
                    if level[r as usize] == NEVER {
                        level[r as usize] = fits[r as usize].max(z);
                    }
                }
            }
            // What is left goes on, along the curve, a level finer.
            let mut kept = a;
            for i in a..b {
                if level[work[i].1 as usize] == NEVER {
                    work[kept] = work[i];
                    kept += 1;
                }
            }
            b = kept;
            z = deepest + 1;
        }
        // Rows no level held, as rows naming no vertex, land at the finest.
        for &(_, r) in &work[a..b] {
            if level[r as usize] == NEVER {
                level[r as usize] = MAX_LEVEL;
            }
        }
    }
    level
}

/// Rows by tile, coarsest level first, each tile's rows in priority order, highest last, and a large
/// tile's a sub-cell at a time, each in priority order; and the tiles. `sorted` holds the rows along
/// the curve.
fn tiled(
    sorted: &[(u64, u32)],
    anchors: &[[u32; 2]],
    extents: &[u32],
    ranks: &[u64],
    level: &[u8],
) -> (Vec<u32>, Vec<Tile>) {
    let n = anchors.len();
    // Rows by level, along the curve within each, so each tile's rows are a run.
    let mut starts = vec![0_usize; usize::from(MAX_LEVEL) + 2];
    for &l in level {
        starts[usize::from(l) + 1] += 1;
    }
    for z in 0..=usize::from(MAX_LEVEL) {
        starts[z + 1] += starts[z];
    }
    let mut by_level = vec![0_u32; n];
    let mut next = starts.clone();
    for &(_, r) in sorted {
        let z = usize::from(level[r as usize]);
        by_level[next[z]] = r;
        next[z] += 1;
    }
    let mut order = Vec::with_capacity(n);
    let mut tiles = Vec::new();
    for z in 0..=MAX_LEVEL {
        let rows = &by_level[starts[usize::from(z)]..starts[usize::from(z) + 1]];
        let mut i = 0;
        while i < rows.len() {
            let key = tile_of(anchors[rows[i] as usize], z);
            let mut j = i;
            let mut reach = 0;
            while j < rows.len() && tile_of(anchors[rows[j] as usize], z) == key {
                reach = reach.max(extents.get(rows[j] as usize).copied().unwrap_or(0));
                j += 1;
            }
            let start = order.len();
            let members = &rows[i..j];
            // By priority alone: rows alike draw in either order.
            let by_priority = |order: &mut Vec<u32>, from: usize| {
                crate::order::by_key(&mut order[from..], |&r| ranks[r as usize] >> 32);
            };
            let mut cells = Vec::new();
            if members.len() > SUB_ROWS {
                // Along the curve, each sub-cell's rows are a run.
                let shift = 2 * (32 - u32::from(z) - SUB_BITS);
                let mask = (1_u64 << (2 * SUB_BITS)) - 1;
                let mut k = 0;
                for cell in 0..=mask {
                    let from = order.len();
                    while k < members.len() && (morton(anchors[members[k] as usize]) >> shift) & mask == cell {
                        order.push(members[k]);
                        k += 1;
                    }
                    by_priority(&mut order, from);
                    cells.push(order.len() as u32);
                }
            } else {
                order.extend_from_slice(members);
                by_priority(&mut order, start);
            }
            let reach = f64::from(reach) / 4_294_967_296.0;
            tiles.push(Tile { key, rows: start as u32..order.len() as u32, reach, cells });
            i = j;
        }
    }
    (order, tiles)
}

/// One tile of a pyramid: where its rows lie in the pyramid's order, how far they reach past it
/// across the square, and for a large tile where each sub-cell's rows end, in the curve's order of
/// the sub-cells.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Tile {
    pub(crate) key: TileKey,
    pub(crate) rows: Range<u32>,
    pub(crate) reach: f64,
    pub(crate) cells: Vec<u32>,
}

/// The pages of the order `ranges` hold past page `last`, and the last page they reach. The order lays
/// its levels out coarsest first, so a level's pages lie past those of the levels above it, but for
/// one they may share.
fn pages_past(ranges: &[(u8, Range<u32>)], last: Option<u32>) -> (u32, Option<u32>) {
    let mut spans: Vec<(u32, u32)> = ranges
        .iter()
        .filter(|(_, r)| r.start < r.end)
        .map(|(_, r)| (r.start / PAGE_ROWS, (r.end - 1) / PAGE_ROWS))
        .collect();
    spans.sort_unstable();
    let (mut pages, mut reached) = (0, last);
    for (first, end) in spans {
        let from = reached.map_or(first, |l| first.max(l + 1));
        pages += (end + 1).saturating_sub(from);
        reached = Some(reached.map_or(end, |l| l.max(end)));
    }
    (pages, reached)
}

/// Sub-cell `cell` of tile `key`, numbered along the curve.
fn sub_key(key: TileKey, cell: usize) -> TileKey {
    let (mut x, mut y) = (0, 0);
    for b in 0..SUB_BITS {
        x |= ((cell >> (2 * b)) as u32 & 1) << b;
        y |= ((cell >> (2 * b + 1)) as u32 & 1) << b;
    }
    TileKey { z: key.z + SUB_BITS as u8, x: key.x << SUB_BITS | x, y: key.y << SUB_BITS | y }
}

/// A table's rows grouped into tiles: its order, rows by tile, coarsest level first, each tile's rows
/// in priority order, highest last; each row's place in it; and its tiles.
#[derive(Debug)]
pub(crate) struct Pyramid {
    pub(crate) order: Vec<u32>,
    pub(crate) rank: Vec<u32>,
    pub(crate) tiles: Vec<Tile>,
    /// What tells it from every other pyramid: what pages packed in its order are kept by.
    pub(crate) made: Version,
    index: FxHashMap<TileKey, u32>,
    /// Every tile with tiles below it.
    above: FxHashSet<TileKey>,
}

impl Pyramid {
    /// The pyramid of `order` and `tiles`: each row's place in the order worked out from it.
    pub(crate) fn new(order: Vec<u32>, tiles: Vec<Tile>) -> Pyramid {
        let mut rank = vec![UNWIRED; order.len()];
        for (d, &r) in order.iter().enumerate() {
            if let Some(slot) = rank.get_mut(r as usize) {
                *slot = d as u32;
            }
        }
        let index = tiles.iter().enumerate().map(|(i, t)| (t.key, i as u32)).collect();
        let mut above = FxHashSet::default();
        for tile in &tiles {
            for up in 1..=tile.key.z {
                if !above.insert(tile.key.ancestor(up)) {
                    break;
                }
            }
        }
        Pyramid { order, rank, tiles, made: Version::next(), index, above }
    }

    /// Rows it orders.
    pub(crate) fn rows(&self) -> u32 {
        self.order.len() as u32
    }

    /// The ranges of the order the camera asks for, coarsest first, each with its level: at each
    /// level, every tile its rows reach into what the camera shows from, a large one only where its
    /// sub-cells do, splitting while a tile draws larger than its size. A drawing holds whole pages of
    /// the order, so a level whose pages would hold more than `rows` rows goes, coarser ones drawing
    /// whole in its place.
    pub(crate) fn wanted(&self, sight: &Sight<'_>, domain: &Domain, rows: u32) -> Vec<(u8, Range<u32>)> {
        if self.tiles.len() == 1 && self.tiles[0].key.z == 0 {
            return vec![(0, self.tiles[0].rows.clone())];
        }
        let region: Region = sight.region();
        let focus = sight.focus();
        let limit = TILE_PX * 1.25;
        let mut out: Vec<(u8, Range<u32>)> = Vec::new();
        let (fit, mut held, mut last) = (rows.div_ceil(PAGE_ROWS), 0_u32, None);
        let mut level = vec![TileKey { z: 0, x: 0, y: 0 }];
        while !level.is_empty() {
            let mut found = Vec::new();
            let mut next = Vec::new();
            for key in level {
                let grow = 0.5 / f64::from(1_u32 << key.z);
                if !meets(&region, domain.bounds(key, grow)) {
                    continue;
                }
                if let Some(&t) = self.index.get(&key) {
                    let tile = &self.tiles[t as usize];
                    if meets(&region, domain.bounds(key, tile.reach)) {
                        let first = found.len();
                        if tile.cells.is_empty() {
                            found.push((key.z, tile.rows.clone()));
                        }
                        // A sub-cell's rows lie within it, each reaching no farther than the tile's.
                        let grow = tile.reach + 0.5 / f64::from(1_u32 << (u32::from(key.z) + SUB_BITS));
                        let mut start = tile.rows.start;
                        for (cell, &end) in tile.cells.iter().enumerate() {
                            if end > start && meets(&region, domain.bounds(sub_key(key, cell), grow)) {
                                let ours = found.len() > first;
                                match found.last_mut() {
                                    Some((_, range)) if ours && range.end == start => range.end = end,
                                    _ => found.push((key.z, start..end)),
                                }
                            }
                            start = end;
                        }
                    }
                }
                let splits =
                    self.above.contains(&key) && next.len() < MAX_TILES && sight.measure(&focus, domain, key).0 > limit;
                if splits {
                    next.extend(key.children());
                }
            }
            // A level whose pages would pass what fits goes: the coarser ones draw in its place.
            let (pages, reached) = pages_past(&found, last);
            if held + pages > fit && !out.is_empty() {
                break;
            }
            (held, last) = (held + pages, reached);
            out.extend(found);
            level = next;
        }
        out
    }

    /// The pyramids a job answered, by the place of the table among those asked, as
    /// [`encode`] wrote them.
    pub(crate) fn read(bytes: &[u8]) -> Vec<(u32, Pyramid)> {
        let words: Vec<u32> = bytes.as_chunks::<4>().0.iter().map(|&w| u32::from_le_bytes(w)).collect();
        let mut words = words.as_slice();
        let mut take = |n: usize| -> Option<&[u32]> {
            let (head, rest) = words.split_at_checked(n)?;
            words = rest;
            Some(head)
        };
        let mut out = Vec::new();
        'tables: while let Some(&[table, n]) = take(2) {
            let n = n as usize;
            let (Some(order), Some(&[count])) = (take(n).map(<[u32]>::to_vec), take(1)) else { break };
            let mut tiles = Vec::with_capacity(count as usize);
            let mut start = 0;
            for _ in 0..count {
                let Some(&[lo, hi, end, reach, cells]) = take(5) else { break 'tables };
                let Some(cells) = take(cells as usize) else { break 'tables };
                let key = unpack(u64::from(lo) | u64::from(hi) << 32);
                let reach = f64::from(reach) / 4_294_967_296.0;
                tiles.push(Tile { key, rows: start..end, reach, cells: cells.to_vec() });
                start = end;
            }
            out.push((table, Pyramid::new(order, tiles)));
        }
        out
    }
}

/// `pyramids` as a job answers them: for each, the place of its table among those asked, how many
/// rows it orders, its order, how many tiles, and each tile's key, where its rows end, how far they
/// reach, and how many sub-cells it has and where each one's rows end, little-endian words.
pub(crate) fn encode(pyramids: &[(u32, Pyramid)]) -> Vec<u8> {
    let mut words: Vec<u32> = Vec::new();
    for (table, pyramid) in pyramids {
        words.extend([*table, pyramid.rows()]);
        words.extend_from_slice(&pyramid.order);
        words.push(pyramid.tiles.len() as u32);
        for tile in &pyramid.tiles {
            let key = pack(tile.key);
            let reach = (tile.reach * 4_294_967_296.0).min(f64::from(u32::MAX)) as u32;
            words.extend([key as u32, (key >> 32) as u32, tile.rows.end, reach, tile.cells.len() as u32]);
            words.extend_from_slice(&tile.cells);
        }
    }
    words.iter().flat_map(|w| w.to_le_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed point across the square.
    fn at(u: f64, v: f64) -> [u32; 2] {
        [(u * 4_294_967_296.0) as u32, (v * 4_294_967_296.0) as u32]
    }

    /// A unit square of a plane, its rows placed `u` from the west and `v` from the north.
    fn square(points: &[[f64; 2]]) -> (Domain, Places) {
        let domain = Domain::Plane { min: [0.0, 0.0], size: 1.0 };
        (domain, Places::Points(points.iter().map(|&[u, v]| [u as f32, (1.0 - v) as f32]).collect()))
    }

    /// The level row `row` of `pyramid` lands at.
    fn level_of(pyramid: &Pyramid, row: u32) -> u8 {
        let at = pyramid.rank[row as usize];
        pyramid.tiles.iter().find(|t| t.rows.contains(&at)).expect("a tile").key.z
    }

    #[test]
    fn crowded_rows_wait_for_finer_levels_by_priority() {
        // Two rows in one cell: the higher lands at the root, the lower a level finer.
        let anchors = [at(0.3, 0.3), at(0.3, 0.3), at(0.8, 0.8)];
        let level = place(&along(&anchors), &[], &ranks(&[1.0, 2.0, 0.0], 3), &[0, 0, 0], None, &[]);
        assert_eq!(level[1], 0, "the higher priority lands at the root");
        assert_eq!(level[2], 0, "a row alone in its cell lands at the root");
        assert_eq!(level[0], 1, "the lower lands once the higher has left its cell");
        let alike = [at(0.3, 0.3); 4];
        let level = place(&along(&alike), &[], &ranks(&[], 4), &[0; 4], None, &[]);
        let mut sorted = level.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, vec![0, 1, 2, 3], "a row a level, equals in an order of their own");
    }

    #[test]
    fn no_tile_holds_more_rows_than_cells() {
        let n = 50_000_u32;
        let anchors: Vec<[u32; 2]> =
            (0..n).map(|i| at(f64::from(i % 250) / 250.0, f64::from(i / 250) / 200.0)).collect();
        let sorted = along(&anchors);
        let ranks = ranks(&[], n as usize);
        let level = place(&sorted, &[], &ranks, &vec![0; n as usize], None, &[]);
        let (order, tiles) = tiled(&sorted, &anchors, &[], &ranks, &level);
        assert_eq!(order.len(), n as usize);
        for tile in &tiles {
            assert!(tile.rows.len() <= 1 << (2 * GRID_BITS), "a tile holds at most its grid's cells");
        }
        assert!(tiles.len() > 1);
        // A large tile's rows lie a sub-cell at a time, each sub-cell's within it.
        let large = tiles.iter().find(|t| !t.cells.is_empty()).expect("a large tile");
        let mut start = large.rows.start;
        for (cell, &end) in large.cells.iter().enumerate() {
            let sub = sub_key(large.key, cell);
            for &r in &order[start as usize..end as usize] {
                assert_eq!(tile_of(anchors[r as usize], sub.z), sub, "row {r} lies in sub-cell {cell}");
            }
            start = end;
        }
        assert_eq!(start, large.rows.end);
    }

    #[test]
    fn large_rows_stay_coarse_and_edges_land_by_their_own_priority() {
        let anchors = [at(0.1, 0.1), at(0.9, 0.9)];
        let extents = [1 << 30, 0];
        let level = place(&along(&anchors), &extents, &ranks(&[0.0, 0.0], 2), &[0, 0], None, &[]);
        assert!(level[0] <= 1, "a row reaching a quarter of the square stays coarse");
        // Two vertices crowd one cell; the edges between them land by their own priority, parallel
        // ones together, and one naming no row only at the finest level.
        let (domain, places) = square(&[[0.3, 0.3], [0.3, 0.3], [0.31, 0.3]]);
        let leveling = Leveling {
            domain,
            tables: vec![
                Placing {
                    rows: 3,
                    leveled: true,
                    answered: true,
                    places,
                    priority: [2.0, 1.0, 0.0].into(),
                    ..Placing::default()
                },
                Placing {
                    rows: 3,
                    leveled: true,
                    answered: true,
                    ends: Some((0, vec![[1, 2, UNWIRED].into(), [2, 1, 0].into()])),
                    ..Placing::default()
                },
            ],
        };
        let pyramids: FxHashMap<u32, Pyramid> = answer(&leveling).into_iter().collect();
        let edges = &pyramids[&1];
        assert_eq!(level_of(edges, 0), 0, "an edge alone in its cell shows from the root");
        assert_eq!(level_of(edges, 1), 0, "with the edge joining the same vertices");
        assert_eq!(level_of(edges, 2), MAX_LEVEL, "an edge naming no row waits for the finest level");
        // Its ends show with it: vertices 1 and 2 land at the root though they share a cell.
        let vertices = &pyramids[&0];
        assert_eq!((level_of(vertices, 1), level_of(vertices, 2)), (0, 0), "ends land with their edges");
    }

    #[test]
    fn answers_read_back_as_written() {
        let (domain, places) = square(&[[0.1, 0.1], [0.9, 0.9], [0.5, 0.5]]);
        let leveling = Leveling {
            domain,
            tables: vec![Placing { rows: 3, leveled: true, answered: true, places, ..Placing::default() }],
        };
        let answered = answer(&leveling);
        let read = Pyramid::read(&encode(&answered));
        assert_eq!(read.len(), 1);
        let (table, pyramid) = &read[0];
        assert_eq!(*table, 0);
        assert_eq!(pyramid.order, answered[0].1.order);
        assert_eq!(pyramid.tiles, answered[0].1.tiles);
        for (d, &r) in pyramid.order.iter().enumerate() {
            assert_eq!(pyramid.rank[r as usize], d as u32, "each row's place in the order");
        }
    }

    #[test]
    fn levels_count_the_pages_they_hold() {
        // Two sub-cells in one page, one in the next, and a level below reaching the page where the
        // one above ended.
        let above = [(0, 10..20), (0, 50..60), (0, PAGE_ROWS + 3..PAGE_ROWS + 9)];
        let (pages, last) = pages_past(&above, None);
        assert_eq!((pages, last), (2, Some(1)));
        let below = [(1, PAGE_ROWS + 20..3 * PAGE_ROWS + 1)];
        assert_eq!(pages_past(&below, last), (2, Some(3)), "pages 2 and 3; page 1 is held already");
    }

    #[test]
    fn tiles_number_exactly() {
        let key = TileKey { z: MAX_LEVEL, x: (1 << 24) - 1, y: 12_345 };
        assert_eq!(unpack(pack(key)), key);
        assert_eq!(unpack(pack(key) as f64 as u64), key, "a number holds it exactly");
    }

    #[test]
    fn whole_tables_order_rows_by_priority() {
        let leveling = Leveling {
            domain: Domain::Earth,
            tables: vec![Placing { rows: 3, answered: true, priority: [5.0, 1.0, 3.0].into(), ..Placing::default() }],
        };
        let pyramids = answer(&leveling);
        assert_eq!(pyramids[0].1.order, vec![1, 2, 0], "highest last, drawn on top");
        assert_eq!(pyramids[0].1.tiles.len(), 1);
    }
}
