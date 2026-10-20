//! Pyramids: a table's rows grouped into tiles by the coarsest level each shows at, worked out in a
//! job. Each level splits the tiles above it four ways, and each tile holds a grid of cells, a row to
//! a cell, so no tile holds more rows than its grid has cells. Rows land by priority: each at the
//! coarsest level where its cell is free, so what matters more shows from farther out, and rows
//! crowding one cell wait for a finer level, where they spread over cells of their own. A row never
//! lands finer than its size allows, so its tile grown by half its own size holds it whole. An edge
//! lands by its own priority, in the cell of its middle, and edges joining the same two vertices land
//! together; what draws an edge draws its ends with it. A table drawn whole by priority is one tile,
//! its rows in priority order.

use std::ops::Range;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::sight::{Domain, Region, Sight, TILE_PX, meets};
use crate::data::{Field, Ids, Op, Patch, Table};
use crate::geo::tiles::TileKey;

/// Cells across a tile's grid, as a shift: a tile holds at most `4^GRID_BITS` rows of its level.
pub(crate) const GRID_BITS: u32 = 7;
/// The finest level.
pub(crate) const MAX_LEVEL: u8 = 24;
/// A level no row has landed at yet.
const NEVER: u8 = u8::MAX;
/// Tiles a camera may ask a pyramid for at most: past it, tiles stop splitting.
const MAX_TILES: usize = 1024;

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

/// The pyramid of each table a job answered for, by its place among the tables asked, with where
/// each row lies across the square and how far it reaches.
pub(crate) fn answer(leveling: &Leveling) -> Patch {
    let wraps = leveling.domain == Domain::Earth;
    let mut anchors: Vec<Vec<[u32; 2]>> = Vec::with_capacity(leveling.tables.len());
    let mut patch = Patch::new();
    for (i, table) in leveling.tables.iter().enumerate() {
        let n = table.rows as usize;
        let (own_anchors, extents, floor, pairs) = if let Some((target, ends)) = &table.ends {
            let Some(at) = anchors.get(*target as usize) else { return Patch::new() };
            let (own, extents) = by_ends(ends, at, wraps, n);
            // A row with an end naming no row draws nothing: it lands only at the finest level.
            let floor = (0..n)
                .map(|r| {
                    let wired = ends.iter().all(|end| end.get(r).is_some_and(|&t| (t as usize) < at.len()));
                    if wired { 0 } else { NEVER }
                })
                .collect();
            let pairs = (ends.len() == 2).then(|| pairs(&ends[0], &ends[1]));
            (own, extents, floor, pairs)
        } else {
            let (own, extents) = anchored(&table.places, &leveling.domain);
            (own, extents, vec![0; n], None)
        };
        let leveled = table.leveled && own_anchors.len() == n;
        let sorted = if leveled { along(&own_anchors) } else { Vec::new() };
        let ranks = ranks(&table.priority, n);
        let level = if leveled { place(&sorted, &extents, &ranks, &floor, pairs.as_deref()) } else { vec![0; n] };
        if table.answered {
            let (order, tiles) = if leveled {
                tiled(&sorted, &own_anchors, &extents, &ranks, &level)
            } else {
                let mut order: Vec<u32> = (0..table.rows).collect();
                order.sort_unstable_by_key(|&r| ranks[r as usize]);
                (order, vec![(pack(TileKey { z: 0, x: 0, y: 0 }), table.rows, u32::MAX)])
            };
            let (keys, (ends, reaches)): (Vec<u64>, (Vec<u32>, Vec<u32>)) =
                tiles.into_iter().map(|(k, e, r)| (k, (e, r))).unzip();
            patch = patch
                .set(
                    Table::new(format!("tiles{i}"), Ids::count(keys.len() as u32))
                        .field("key", keys)
                        .field("end", ends)
                        .field("reach", reaches),
                )
                .set(Table::new(format!("order{i}"), Ids::count(order.len() as u32)).field("row", order));
            if leveled {
                let (u, v): (Vec<u32>, Vec<u32>) = own_anchors.iter().map(|a| (a[0], a[1])).unzip();
                let mut placed = Table::new(format!("anchors{i}"), Ids::count(n as u32)).field("u", u).field("v", v);
                if !extents.is_empty() {
                    placed = placed.field("extent", extents.clone());
                }
                patch = patch.set(placed);
            }
        }
        anchors.push(own_anchors);
    }
    patch
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
            alike.sort_unstable_by_key(|&r| pairs[r as usize]);
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
    sorted.sort_unstable_by_key(|&(m, _)| m);
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

/// `cover` grown to hold tile `key`: a box from the west and the north, fixed point.
fn covering(cover: [u64; 4], key: TileKey) -> [u64; 4] {
    let shift = 32 - u32::from(key.z);
    let (x, y) = (u64::from(key.x) << shift, u64::from(key.y) << shift);
    let size = 1_u64 << shift;
    [cover[0].min(x), cover[1].min(y), cover[2].max(x + size), cover[3].max(y + size)]
}

/// Whether a row anchored at `anchor`, reaching `extent` from it, reaches into `cover`.
pub(crate) fn reaches(cover: &[u64; 4], anchor: [u32; 2], extent: u32) -> bool {
    let (u, v, e) = (u64::from(anchor[0]), u64::from(anchor[1]), u64::from(extent));
    u + e >= cover[0] && u.saturating_sub(e) < cover[2] && v + e >= cover[1] && v.saturating_sub(e) < cover[3]
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
/// `floor`, at the finest its size allows when it has not landed by then.
///
/// Rows along the curve are taken in runs, each the rows left in one cell. While a run stays in one
/// cell level after level, those levels take its highest rows in rank order at once; where it
/// spreads over several cells, each cell's rows go on as a run of their own. So a crowd sharing a
/// cell for many levels costs its size once, not once a level.
fn place(sorted: &[(u64, u32)], extents: &[u32], ranks: &[u64], floor: &[u8], pairs: Option<&[u64]>) -> Vec<u8> {
    let n = sorted.len();
    let fits: Vec<u8> = (0..n).map(|r| extents.get(r).map_or(MAX_LEVEL, |&e| fit(e))).collect();
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
            // Rows no finer level holds land where their size says.
            if !extents.is_empty() {
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

/// Rows by tile, coarsest level first, each tile's rows in priority order, highest last; and each
/// tile packed, where its rows end, and how far they reach past it, fixed point. `sorted` holds the
/// rows along the curve.
fn tiled(
    sorted: &[(u64, u32)],
    anchors: &[[u32; 2]],
    extents: &[u32],
    ranks: &[u64],
    level: &[u8],
) -> (Vec<u32>, Vec<(u64, u32, u32)>) {
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
            order.extend_from_slice(&rows[i..j]);
            // By priority alone: rows alike draw in either order.
            order[start..].sort_unstable_by_key(|&r| (ranks[r as usize] >> 32) as u32);
            tiles.push((pack(key), order.len() as u32, reach));
            i = j;
        }
    }
    (order, tiles)
}

/// One tile of a pyramid: where its rows lie in the pyramid's order, and how far they reach past it,
/// across the square.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Tile {
    pub(crate) key: TileKey,
    pub(crate) rows: Range<u32>,
    pub(crate) reach: f64,
}

/// The tiles the camera asks of a pyramid, each with whether it is one of the finest asked, and the
/// part of the square, from the west and the north, the finest cover: a coarser tile draws only its
/// rows reaching into it.
#[derive(Clone, Debug, Default, PartialEq, Hash)]
pub(crate) struct Wanted {
    pub(crate) tiles: Vec<(u32, bool)>,
    pub(crate) cover: Option<[u64; 4]>,
}

/// A table's rows grouped into tiles: a job's answer, read.
#[derive(Debug, Default)]
pub(crate) struct Pyramid {
    /// Rows by tile, coarsest level first, each tile's rows in priority order, highest last.
    pub(crate) order: Vec<u32>,
    pub(crate) tiles: Vec<Tile>,
    /// Where each row lies across the square, fixed point, and half its size alike: none for a
    /// table in one tile, and no sizes for points.
    pub(crate) anchors: Vec<[u32; 2]>,
    pub(crate) extents: Vec<u32>,
    index: FxHashMap<TileKey, u32>,
    /// Every tile with tiles below it.
    above: FxHashSet<TileKey>,
}

impl Pyramid {
    /// The pyramids a job answered, by the place of the table among those asked.
    pub(crate) fn read(bytes: &[u8]) -> FxHashMap<u32, Pyramid> {
        Patch::from_bytes(bytes).map(Pyramid::answered).unwrap_or_default()
    }

    /// The pyramids `patch` answers, by the place of the table among those asked.
    pub(crate) fn answered(patch: Patch) -> FxHashMap<u32, Pyramid> {
        let mut tiles: FxHashMap<u32, Vec<Tile>> = FxHashMap::default();
        let mut orders: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        let mut placed: FxHashMap<u32, (Vec<[u32; 2]>, Vec<u32>)> = FxHashMap::default();
        for op in patch.ops {
            let Op::Set(table) = op else { continue };
            let number = |prefix: &str| table.name.strip_prefix(prefix).and_then(|i| i.parse::<u32>().ok());
            let column = |name: &str| match table.field_named(name) {
                Some(Field::Values(column, _)) => Some(column.clone()),
                _ => None,
            };
            // Words read as they are stored, page by page.
            let words = |name: &str| -> Vec<u32> {
                column(name).map_or_else(Vec::new, |c| {
                    c.pages().iter().flat_map(|p| p.values.u32s().unwrap_or(&[]).iter().copied()).collect()
                })
            };
            if let Some(i) = number("tiles") {
                let keys: Vec<u64> = column("key").map_or_else(Vec::new, |c| {
                    c.pages().iter().flat_map(|p| p.values.u64s().unwrap_or(&[]).iter().copied()).collect()
                });
                let (ends, reaches) = (words("end"), words("reach"));
                let mut start = 0;
                let read = keys.iter().zip(&ends).zip(&reaches).map(|((&key, &end), &reach)| {
                    let rows = start..end;
                    start = end;
                    Tile { key: unpack(key), rows, reach: f64::from(reach) / 4_294_967_296.0 }
                });
                tiles.insert(i, read.collect());
            } else if let Some(i) = number("order") {
                orders.insert(i, words("row"));
            } else if let Some(i) = number("anchors") {
                let anchors = words("u").into_iter().zip(words("v")).map(|(u, v)| [u, v]).collect();
                placed.insert(i, (anchors, words("extent")));
            }
        }
        tiles
            .into_iter()
            .filter_map(|(i, tiles)| {
                let mut pyramid = Pyramid::new(orders.remove(&i)?, tiles);
                (pyramid.anchors, pyramid.extents) = placed.remove(&i).unwrap_or_default();
                Some((i, pyramid))
            })
            .collect()
    }

    pub(crate) fn new(order: Vec<u32>, tiles: Vec<Tile>) -> Pyramid {
        let index = tiles.iter().enumerate().map(|(i, t)| (t.key, i as u32)).collect();
        let mut above = FxHashSet::default();
        for tile in &tiles {
            for up in 1..=tile.key.z {
                if !above.insert(tile.key.ancestor(up)) {
                    break;
                }
            }
        }
        Pyramid { order, tiles, anchors: Vec::new(), extents: Vec::new(), index, above }
    }

    /// The tiles the camera asks for, coarsest first: at each level, every tile its rows reach into
    /// what the camera shows from, splitting while a tile draws larger than its size. A level whose
    /// rows would pass `rows` goes, coarser ones drawing whole in its place.
    pub(crate) fn wanted(&self, sight: &Sight<'_>, domain: &Domain, rows: u32) -> Wanted {
        if self.tiles.len() == 1 && self.tiles[0].key.z == 0 {
            return Wanted { tiles: vec![(0, true)], cover: None };
        }
        let region: Region = sight.region();
        let focus = sight.focus();
        let limit = TILE_PX * 1.25;
        let mut out: Vec<(u32, bool)> = Vec::new();
        let mut cover = [u64::MAX, u64::MAX, 0, 0];
        let mut total = 0_u32;
        let mut level = vec![TileKey { z: 0, x: 0, y: 0 }];
        // The tiles of the level above that split, and where among those found each is.
        let mut split: Vec<(TileKey, Option<usize>)> = Vec::new();
        while !level.is_empty() {
            let mut found = Vec::new();
            let mut leaves = Vec::new();
            let mut splitting = Vec::new();
            let mut added = 0_u32;
            let mut next = Vec::new();
            for key in level {
                let grow = 0.5 / f64::from(1_u32 << key.z);
                if !meets(&region, domain.bounds(key, grow)) {
                    continue;
                }
                let splits = self.above.contains(&key)
                    && next.len() < MAX_TILES
                    && sight.measure(&focus, domain.bounds(key, 0.0)).0 > limit;
                let mut at = None;
                if let Some(&t) = self.index.get(&key) {
                    let tile = &self.tiles[t as usize];
                    if meets(&region, domain.bounds(key, tile.reach)) {
                        at = Some(out.len() + found.len());
                        found.push((t, !splits));
                        added = added.saturating_add(tile.rows.len() as u32);
                    }
                }
                if splits {
                    next.extend(key.children());
                    splitting.push((key, at));
                } else {
                    leaves.push(key);
                }
            }
            if total.saturating_add(added) > rows && !out.is_empty() {
                // The tiles that split draw whole instead.
                for (key, at) in split {
                    cover = covering(cover, key);
                    if let Some(at) = at {
                        out[at].1 = true;
                    }
                }
                break;
            }
            total = total.saturating_add(added);
            out.extend(found);
            for key in leaves {
                cover = covering(cover, key);
            }
            split = splitting;
            level = next;
        }
        Wanted { tiles: out, cover: (cover[0] <= cover[2]).then_some(cover) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::UNWIRED;

    /// Fixed point across the square.
    fn at(u: f64, v: f64) -> [u32; 2] {
        [(u * 4_294_967_296.0) as u32, (v * 4_294_967_296.0) as u32]
    }

    /// A unit square of a plane, its rows placed `u` from the west and `v` from the north.
    fn square(points: &[[f64; 2]]) -> (Domain, Places) {
        let domain = Domain::Plane { min: [0.0, 0.0], size: 1.0 };
        (domain, Places::Points(points.iter().map(|&[u, v]| [u as f32, (1.0 - v) as f32]).collect()))
    }

    #[test]
    fn crowded_rows_wait_for_finer_levels_by_priority() {
        // Two rows in one cell: the higher lands at the root, the lower a level finer.
        let anchors = [at(0.3, 0.3), at(0.3, 0.3), at(0.8, 0.8)];
        let level = place(&along(&anchors), &[], &ranks(&[1.0, 2.0, 0.0], 3), &[0, 0, 0], None);
        assert_eq!(level[1], 0, "the higher priority lands at the root");
        assert_eq!(level[2], 0, "a row alone in its cell lands at the root");
        assert_eq!(level[0], 1, "the lower lands once the higher has left its cell");
        let alike = [at(0.3, 0.3); 4];
        let level = place(&along(&alike), &[], &ranks(&[], 4), &[0; 4], None);
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
        let level = place(&sorted, &[], &ranks, &vec![0; n as usize], None);
        let (order, tiles) = tiled(&sorted, &anchors, &[], &ranks, &level);
        assert_eq!(order.len(), n as usize);
        let mut start = 0;
        for &(_, end, _) in &tiles {
            assert!(end - start <= 1 << (2 * GRID_BITS), "a tile holds at most its grid's cells");
            start = end;
        }
        assert!(tiles.len() > 1);
    }

    #[test]
    fn large_rows_stay_coarse_and_edges_land_by_their_own_priority() {
        let anchors = [at(0.1, 0.1), at(0.9, 0.9)];
        let extents = [1 << 30, 0];
        let level = place(&along(&anchors), &extents, &ranks(&[0.0, 0.0], 2), &[0, 0], None);
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
        let pyramids = Pyramid::read(&answer(&leveling).to_bytes());
        let edges = &pyramids[&1];
        let level_of = |p: &Pyramid, row: u32| {
            let at = p.order.iter().position(|&r| r == row).unwrap() as u32;
            p.tiles.iter().find(|t| t.rows.contains(&at)).unwrap().key.z
        };
        assert_eq!(level_of(edges, 0), 0, "an edge alone in its cell shows from the root, its ends carried");
        assert_eq!(level_of(edges, 1), 0, "with the edge joining the same vertices");
        assert_eq!(level_of(edges, 2), MAX_LEVEL, "an edge naming no row waits for the finest level");
    }

    #[test]
    fn tiles_number_exactly() {
        let key = TileKey { z: MAX_LEVEL, x: (1 << 24) - 1, y: 12_345 };
        assert_eq!(unpack(pack(key)), key);
        assert_eq!(unpack(pack(key) as f64 as u64), key, "a number holds it exactly");
    }

    #[test]
    #[ignore = "a timing, run by hand in release"]
    fn time_two_million() {
        // Two million vertices in a thousand clusters, and an edge from each to the next.
        let n = 2_000_000_u32;
        let places: Arc<[[f32; 2]]> = (0..n)
            .map(|i| {
                let city = tie(i % 1000);
                let spread = tie(i) >> 20;
                let u = f64::from(city.wrapping_add(spread)) / 4_294_967_296.0;
                let v = f64::from(tie(city).wrapping_add(tie(spread))) / 4_294_967_296.0;
                [(u * 360.0 - 180.0) as f32, ((v - 0.5) * 120.0) as f32]
            })
            .collect();
        let priority: Arc<[f32]> = (0..n).map(|i| (tie(i) % 6) as f32).collect();
        let to: Arc<[u32]> = (0..n).map(|i| (i + 1) % n).collect();
        let leveling = Leveling {
            domain: Domain::Earth,
            tables: vec![
                Placing {
                    rows: n,
                    leveled: true,
                    answered: true,
                    places: Places::Points(places),
                    priority: priority.clone(),
                    ..Placing::default()
                },
                Placing {
                    rows: n,
                    leveled: true,
                    answered: true,
                    priority,
                    ends: Some((0, vec![(0..n).collect(), to])),
                    ..Placing::default()
                },
            ],
        };
        let started = std::time::Instant::now();
        let patch = answer(&leveling);
        eprintln!("answer {:?}", started.elapsed());
        let started = std::time::Instant::now();
        let bytes = patch.to_bytes();
        eprintln!("encode {:?} {} MB", started.elapsed(), bytes.len() >> 20);
        let started = std::time::Instant::now();
        let read = Pyramid::read(&bytes);
        eprintln!("read {:?} {} tiles", started.elapsed(), read[&0].tiles.len() + read[&1].tiles.len());
    }

    #[test]
    fn whole_tables_order_rows_by_priority() {
        let leveling = Leveling {
            domain: Domain::Earth,
            tables: vec![Placing { rows: 3, answered: true, priority: [5.0, 1.0, 3.0].into(), ..Placing::default() }],
        };
        let pyramids = Pyramid::read(&answer(&leveling).to_bytes());
        assert_eq!(pyramids[&0].order, vec![1, 2, 0], "highest last, drawn on top");
        assert_eq!(pyramids[&0].tiles.len(), 1);
    }
}
