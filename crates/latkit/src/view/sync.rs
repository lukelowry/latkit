//! A mark's columns on the GPU. Each column the program reads gets a descriptor and a page table of
//! arena offsets. A sampled column instead gets a cursor per page of rows at the shown coordinate.
//!
//! An unpaged table's rows are paged as its data is, and its columns read the data's pages. A paged
//! table's rows are paged by slot, one page of its order per slot. Its columns read pages packed in
//! that order, cached on the GPU by what they were packed from. A reference column to a paged table
//! holds the referenced rows' places in that table's order.
//!
//! A column a line traces holds only what is in view: runs of entries, as raw frames while there
//! are at most two per pixel column, otherwise as each pixel column's least and greatest value,
//! read from entries of the level of detail that fits in a column. Where the samples lack those,
//! coarser buckets are shown as placeholders, or else the finer ones available. Each visible point
//! holds its coordinate and a direct value cursor per page of rows.
//!
//! Only columns whose inputs changed are rebuilt, once each. Moving the shown coordinate rebuilds
//! only sampled columns' cursors, and a paged table rebuilds only where its marks' resident pages
//! changed. Rebuilt tables are staged together with those of every other mark of the dataset. The
//! dataset reserves every page they read all at once, or none and waits for space. Once every page
//! has arrived, the view swaps them all in, so a data version, and what a camera move draws, appear
//! complete. Staged tables are rebuilt while they wait only if their inputs change again. A rebuilt
//! column that lists pages reports which pages of rows read changed pages, so only those rows
//! evaluate again. While a mark eases, its geometry column keeps the table it had when the
//! transition began, packed after the rest, so paths morph from it.
//!
//! A page of an unpaged table that was written over the page a column reads now is not uploaded
//! again. When the dataset swaps in, the page takes the block of the page it was written over, and
//! only the rows written upload (see [`Rewrite`]). Its offset stays, so the column's page table
//! does not change. A page the swap replaces otherwise is freed, since no table reads that version
//! again.

use std::ops::Range;
use std::sync::{Arc, OnceLock};

use rustc_hash::{FxHashMap, FxHashSet};

use super::drawing::{Drawing, Holds};
use crate::data::{
    Column, Field, Inverse, Page, PageId, Reference, Run, Runs, Samples, Values, Version, bucket_frames, detail, sides,
};
use crate::derive::order::Order;
use crate::derive::shapes::PagedShapes;
use crate::derive::stamp_of;
use crate::derive::{Beside, Derivations};
use crate::expr::compile::{ColumnUse, Program, Reads, Words};
use crate::gpu::Inner;
use crate::gpu::arena::{Ask, Content, PageKey, PathPage, path_pieces};
use crate::gpu::packed::{self, Packing};
use crate::gpu::shaders as wgsl;
use crate::gpu::work::{Count, Queue};
use crate::scene::mark::Style;
use crate::{Name, Snapshot, Table};

const WORDS: usize = wgsl::COLUMN_WORDS as usize;

/// The inputs one column's table was built from. When they change, the table is rebuilt.
#[derive(Clone, PartialEq, Debug)]
enum Stamp {
    Missing,
    /// A field's version, and the id of the order it depends on: the order of a reference's target
    /// table, or the order paged shapes were made in. Otherwise 0.
    Field(Version, u64),
    Sampled(Version, Option<u64>, u32),
    Trace(Version, Plan),
    Join(Version, Version),
}

/// What a trace shows: the axis window, the pixel columns it spans, the most entries it may hold,
/// and how a line steps between frames (`STEP_BEFORE`, `STEP_AFTER`, or 0).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Window {
    pub(crate) across: Option<[f64; 2]>,
    pub(crate) columns: u32,
    pub(crate) most: u64,
    pub(crate) steps: u32,
}

/// What a traced column draws: runs of entries left to right, and the total point count.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Plan {
    runs: Vec<Drawn>,
    pub(crate) points: u32,
    steps: u32,
}

/// One run of a plan: its entries, its first point, and how the entries become points.
#[derive(Clone, PartialEq, Eq, Debug)]
struct Drawn {
    run: Run,
    first: u32,
    shape: Shape,
}

/// How a run's entries become points.
#[derive(Clone, PartialEq, Eq, Debug)]
enum Shape {
    /// A line through each side. Frames have one side, with a corner between frames when the mark
    /// steps. Buckets draw their least values left to right, a break, then their greatest, so
    /// buckets wider than a pixel column read as a band and never as steps. A lone bucket joins
    /// its least to its greatest.
    Lines,
    /// Each pixel column's least and greatest, one above the other, for entries narrower than a
    /// column. Lists each column's first entry in the run, with the bits of the coordinate at the
    /// column's middle.
    Columns(Vec<(u32, u64)>),
}

/// Where a point draws on the axis: at an entry (a frame's coordinate or a bucket's middle), or at
/// a coordinate, given as its bits.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum At {
    Entry(u64),
    Coordinate(u64),
}

/// A point of a plan: its run, where it draws, the entries whose values it reads, and whether it
/// draws their least (0) or their greatest (1).
#[derive(Clone, PartialEq, Eq, Debug)]
struct Point {
    run: usize,
    at: At,
    entries: Range<u64>,
    side: usize,
}

impl Drawn {
    /// The number of points it takes when frames step as `steps`.
    fn points(&self, steps: u32) -> u32 {
        let n = self.run.len() as u32;
        match &self.shape {
            Shape::Columns(columns) => 2 * columns.len() as u32,
            Shape::Lines if self.run.level > 0 && n > 1 => 2 * n + 1,
            Shape::Lines if self.run.level > 0 => 2 * n,
            Shape::Lines if steps == 0 => n,
            Shape::Lines => (2 * n).saturating_sub(1),
        }
    }
}

impl Plan {
    /// A point's stable identity across overlapping windows. Run indices themselves change
    /// when an earlier run leaves, so identify its level and absolute entries instead.
    fn key(&self, point: u32) -> Option<(u32, At, u64, usize)> {
        let p = self.point(point)?;
        Some((self.runs[p.run].run.level, p.at, p.entries.start, p.side))
    }

    /// What point `point` draws: the level it reads, the entries of that level, and whether it
    /// draws their least (0) or their greatest (1). `None` for a point that breaks the line.
    pub(crate) fn entries(&self, point: u32) -> Option<(u32, Range<u64>, usize)> {
        let p = self.point(point)?;
        Some((self.runs[p.run].run.level, p.entries, p.side))
    }

    /// Point `point`, or `None` where it breaks the line. Queries and the GPU address plan share
    /// this mapping. Stepped corners draw at one frame with another's value.
    fn point(&self, point: u32) -> Option<Point> {
        let i = self.runs.partition_point(|drawn| drawn.first <= point).checked_sub(1)?;
        let Drawn { run, first, shape } = &self.runs[i];
        let (k, n) = (point - first, run.len() as u32);
        if k >= self.runs[i].points(self.steps) {
            return None;
        }
        let entry = |offset: u32| run.entries.start + u64::from(offset);
        let one = |at: u32, value: u32, side: usize| (At::Entry(entry(at)), entry(value)..entry(value) + 1, side);
        let (at, entries, side) = match shape {
            Shape::Columns(columns) => {
                let column = (k / 2) as usize;
                let (start, x) = columns[column];
                let end = columns.get(column + 1).map_or(n, |&(next, _)| next);
                (At::Coordinate(x), entry(start)..entry(end), (k % 2) as usize)
            }
            Shape::Lines if run.level > 0 && n == 1 => one(0, 0, k as usize),
            // The least values, a break, then the greatest.
            Shape::Lines if run.level > 0 && k == n => return None,
            Shape::Lines if run.level > 0 && k > n => one(k - n - 1, k - n - 1, 1),
            Shape::Lines if run.level > 0 => one(k, k, 0),
            Shape::Lines => match self.steps {
                wgsl::STEP_AFTER => one(k.div_ceil(2), k / 2, 0),
                wgsl::STEP_BEFORE => one(k / 2, k.div_ceil(2), 0),
                _ => one(k, k, 0),
            },
        };
        Some(Point { run: i, at, entries, side })
    }
}

/// How a mark's columns of its own table page its rows: by the data's pages, or by its drawing's
/// slots, one page of the order per slot.
#[derive(Clone, Copy)]
pub(crate) enum Rows<'a> {
    Own,
    Held(&'a Drawing),
}

impl Rows<'_> {
    /// A stamp of how it pages rows: 0 for the data's own pages.
    fn stamp(self) -> u64 {
        match self {
            Rows::Own => 0,
            Rows::Held(drawing) => drawing.layout(),
        }
    }

    /// The row block holding table row `row`: its page of the data, or the slot a drawing holds it
    /// in. `None` for a row the drawing does not hold.
    fn block(self, row: u32) -> Option<u32> {
        match self {
            Rows::Own => Some(row >> wgsl::PAGE_BITS),
            Rows::Held(drawing) => drawing.held_row(row).map(|held| held >> wgsl::PAGE_BITS),
        }
    }
}

/// A page written over the page a column reads now, which the GPU holds. When the column's dataset
/// swaps in, the page takes that page's block and uploads only the rows written, so it needs no
/// block of its own and the word naming it never changes. Until then the table it replaces keeps
/// drawing the block as it was. If a table outside the swap pins the block by then, `ask` reserves
/// the page whole instead.
struct Rewrite {
    /// The word of the table that holds the block's offset.
    at: usize,
    /// The page written over.
    from: PageKey,
    /// The rows written since `from`, as ascending runs of offsets into the page.
    rows: Vec<Range<u32>>,
    /// The page, with its whole content.
    ask: Ask,
}

/// One column on the GPU: its descriptor (whose table offsets are relative to `words`), its page
/// table or cursors in `words`, and the pages it reads. Until its dataset reserves them, `asks`
/// lists the pages it needs, each with the word that receives its offset. After that, `pins` lists
/// its pinned pages, and `missing` the words still waiting for an offset. `rewrites` lists the
/// pages that take over a block when the table swaps in. They wait for nothing.
struct ColumnTable {
    stamp: Stamp,
    /// Publication that last replaced this column, independent of changes to other columns.
    generation: u64,
    /// How it pages its rows: 0 for the data's pages, otherwise the stamp of its drawing's slots.
    held: u64,
    descriptor: [u32; WORDS],
    words: Vec<u32>,
    /// Direct cursors patched when packing: destination word, page-offset word, offset in page.
    cursors: Vec<(usize, usize, u32)>,
    asks: Vec<(usize, Ask)>,
    rewrites: Vec<Rewrite>,
    pins: Vec<PageKey>,
    /// Words waiting for a page's offset: the word, the page, and the words the page must hold.
    missing: Vec<(usize, PageKey, u32)>,
    /// What a traced column draws.
    plan: Option<Plan>,
    /// The most points a geometry column's paths take.
    points: u32,
    /// For a column whose rows each read their own page, the page each page of rows reads. `None`
    /// where any change affects every row (cursors, traces, joins).
    pages: Option<Vec<Option<PageId>>>,
    /// For a field of another table, the column it pages, which tells the rows written between
    /// this table and the one it replaces.
    read: Option<Column>,
    /// Whether any row it reads holds a value. False only for a derived field that holds none, such
    /// as places before a layout lands: its rows draw nothing, so the table that replaces it gives
    /// them their first values, with nothing to ease from.
    valued: bool,
}

impl ColumnTable {
    /// Whether the pages it lists are the ones it pins, one per page of its table's rows: a column
    /// of an unpaged table's values, or of references to one. A page written over one of them can
    /// take over its block. A drawing's slots hold other rows, and references into a paged table
    /// pin pages of ranks.
    fn rewritable(&self) -> bool {
        self.held == 0 && matches!(self.stamp, Stamp::Field(_, 0))
    }

    /// Moves each page it rewrites into the block of the page that page was written over, as the
    /// table swaps in. The block's pin passes to this table.
    fn rewrite(&mut self, gpu: &mut Inner, queue: &Queue) {
        let rewrites = std::mem::take(&mut self.rewrites);
        gpu.arena.rewrite(queue, rewrites.iter().map(|rewrite| (rewrite.from, &rewrite.rows[..], &rewrite.ask)));
        self.pins.extend(rewrites.iter().map(|rewrite| rewrite.ask.key));
    }

    /// Releases the pins of this table, which `next` replaced. A page of rows that `next` reads
    /// another version of is freed, since nothing reads this version again, and so are a join's
    /// rows. Any other page stays cached. A page rewritten in place is no longer in the pool under
    /// its old key, so releasing it does nothing.
    fn retire(&self, next: &ColumnTable, gpu: &mut Inner) {
        let superseded: FxHashSet<PageId> = match (&self.pages, &next.pages) {
            (Some(pages), Some(now)) if self.rewritable() && next.rewritable() => pages
                .iter()
                .enumerate()
                .filter_map(|(p, page)| page.filter(|page| now.get(p) != Some(&Some(*page))))
                .collect(),
            _ => FxHashSet::default(),
        };
        // A join's rows are pages of its own, made when its tables' rows last changed.
        let join = self.held == 0 && matches!(self.stamp, Stamp::Join(..));
        for &key in &self.pins {
            if join || superseded.contains(&key.page) { gpu.arena.discard(key) } else { gpu.arena.unpin(key) }
        }
    }

    /// Keep overlapping trace records at their previous physical positions. The logical
    /// window moves through a power-of-two ring; unused records are unreachable and pin no
    /// pages. Packing can then upload only changed texels instead of shifting the window.
    fn retain_trace(&mut self, before: &Self) {
        let (Some(plan), Some(old)) = (&self.plan, &before.plan) else { return };
        let (points, rows, capacity) = (self.words[0], self.words[1], self.words[2]);
        let kept = capacity.max(before.words[2]);
        let mask = kept - 1;
        let head = if kept == before.words[2] {
            let first = plan.key(0).and_then(|key| (0..old.points).find(|&p| old.key(p) == Some(key)).map(|p| (0, p)));
            let anchor = first
                .or_else(|| old.key(0).and_then(|key| (0..points).find(|&p| plan.key(p) == Some(key)).map(|p| (p, 0))));
            anchor.map_or(before.words[3], |(new, old)| before.words[3].wrapping_add(old).wrapping_sub(new) & mask)
        } else {
            0
        };
        let end = 4 + 4 * (rows * kept) as usize;
        let source = 4 + 4 * (rows * capacity) as usize;
        let shift = end - source;
        let mut words = vec![wgsl::NONE; end];
        if kept == before.words[2] {
            let common = 4 + 4 * (rows.min(before.words[1]) * kept) as usize;
            words[4..common].copy_from_slice(&before.words[4..common]);
            // Inactive slots retain the exact bytes last packed, including resolved cursors.
            // They need no live page reservation because the visible range cannot read them.
            for &(destination, source, offset) in &before.cursors {
                if destination < common {
                    let page = before.words[source];
                    words[destination] = if page == wgsl::NONE { wgsl::NONE } else { page + offset };
                }
            }
        }
        words[..4].copy_from_slice(&[points, rows, kept, head]);
        let physical = |at: usize| {
            let record = (at - 4) / 4;
            let (row, point) = (record / capacity as usize, record % capacity as usize);
            4 + 4 * (row * kept as usize + ((head as usize + point) & mask as usize)) + (at - 4) % 4
        };
        for row in 0..rows as usize {
            for point in 0..points as usize {
                let from = 4 + 4 * (row * capacity as usize + point);
                let to = physical(from);
                words[to..to + 4].copy_from_slice(&self.words[from..from + 4]);
            }
        }
        words.extend_from_slice(&self.words[source..]);
        for (destination, source, _) in &mut self.cursors {
            *destination = physical(*destination);
            *source += shift;
        }
        for (at, _) in &mut self.asks {
            *at += shift;
        }
        self.words = words;
    }

    /// Fills in the offsets of waiting pages that have arrived. Returns whether none is still
    /// waiting.
    fn resolve(&mut self, gpu: &Inner) -> bool {
        let words = &mut self.words;
        self.missing.retain(|&(at, key, need)| match gpu.arena.offset(key, need) {
            Some(offset) => {
                words[at] = offset;
                false
            }
            None => true,
        });
        self.missing.is_empty()
    }
}

/// Rows of the mark's table joined by id to rows of another table.
struct Join {
    from: (Name, Name),
    structure: (Version, Version),
    /// Each row's row of the other table. `None` when the tables list the same ids in the same
    /// order, so every row reads its own. Such a join needs no table on the GPU: its fields read
    /// like the mark's own.
    rows: Option<JoinRows>,
}

/// A join whose rows read other rows than their own.
#[derive(Default)]
struct JoinRows {
    /// The other table's row for each row, in pages of rows. `NONE` where no row has the id.
    pages: Vec<(PageId, Arc<[u32]>)>,
    /// The rows reading each row of the other table, listed when a write there first asks.
    naming: OnceLock<Inverse>,
}

impl JoinRows {
    fn naming(&self) -> &Inverse {
        self.naming.get_or_init(|| {
            let rows: Vec<u32> = self.pages.iter().flat_map(|(_, rows)| rows.iter().copied()).collect();
            Inverse::new(&rows)
        })
    }
}

impl Join {
    /// The join of `table`'s rows to the rows of `other` with the same ids. Without `other`, no
    /// row reads any.
    fn of(from: &(Name, Name), table: &Table, other: Option<&Table>) -> Join {
        let Some(other) = other else {
            let structure = (table.structure, table.structure);
            return Join { from: from.clone(), structure, rows: Some(JoinRows::default()) };
        };
        let structure = (table.structure, other.structure);
        let rows: Vec<u32> = (0..table.len())
            .map(|r| table.ids.key(r).and_then(|key| other.row(key)).map_or(wgsl::NONE, |row| row as u32))
            .collect();
        if other.len() == rows.len() && rows.iter().enumerate().all(|(r, &o)| o == r as u32) {
            return Join { from: from.clone(), structure, rows: None };
        }
        let pages = rows.chunks(wgsl::PAGE_ROWS as usize).map(|chunk| (PageId::next(), Arc::from(chunk))).collect();
        Join { from: from.clone(), structure, rows: Some(JoinRows { pages, naming: OnceLock::new() }) }
    }
}

/// A mark's rebuilt tables, by index into its current ones, and whether every table was rebuilt,
/// which replaces them all.
pub(crate) struct Rebuilt {
    tables: Vec<(usize, ColumnTable)>,
    reshape: bool,
}

impl Rebuilt {
    /// Unpins its tables' pages.
    fn release(self, gpu: &mut Inner) {
        for (_, table) in self.tables {
            unpin(&table.pins, gpu);
        }
    }

    /// Whether every page each table reads is resident, filling in the offsets of those that
    /// arrived.
    fn ready(&mut self, gpu: &Inner) -> bool {
        let mut ready = true;
        for (_, table) in &mut self.tables {
            ready &= table.asks.is_empty() && table.resolve(gpu);
        }
        ready
    }
}

/// The tables rebuilt for a dataset's marks since the dataset last published, by mark. They replace
/// the current tables once every page they read has arrived.
#[derive(Default)]
pub(crate) struct Staged {
    marks: Vec<(usize, Rebuilt)>,
}

impl Staged {
    /// Mark `mark`'s staged tables, if any.
    pub(crate) fn of(&self, mark: usize) -> Option<&Rebuilt> {
        self.marks.iter().find(|(m, _)| *m == mark).map(|(_, r)| r)
    }

    /// Stages mark `mark`'s `rebuilt` tables. A table rebuilt again replaces its staged version,
    /// which is unpinned. A full rebuild replaces all of the mark's staged tables.
    pub(crate) fn put(&mut self, mark: usize, rebuilt: Rebuilt, gpu: &mut Inner) {
        let Some(at) = self.marks.iter().position(|(m, _)| *m == mark) else {
            self.marks.push((mark, rebuilt));
            return;
        };
        if rebuilt.reshape {
            let (_, old) = std::mem::replace(&mut self.marks[at], (mark, rebuilt));
            old.release(gpu);
            return;
        }
        let staged = &mut self.marks[at].1;
        for (i, table) in rebuilt.tables {
            match staged.tables.iter().position(|(j, _)| *j == i) {
                Some(k) => {
                    let (_, old) = std::mem::replace(&mut staged.tables[k], (i, table));
                    unpin(&old.pins, gpu);
                }
                None => staged.tables.push((i, table)),
            }
        }
    }

    /// Reserves every page the staged tables need, all or none. Returns `false` when the arena has
    /// no space for them now. A table that needs a page the arena has since dropped, and has no
    /// content to upload for it, is discarded and rebuilt later. A page rewritten in place needs
    /// nothing reserved while only the tables it replaces pin the block it takes (see
    /// [`settle`](Staged::settle)).
    pub(crate) fn reserve(&mut self, gpu: &mut Inner, device: &wgpu::Device, queue: &Queue) -> bool {
        let gone = |table: &ColumnTable| {
            table.asks.iter().any(|(_, a)| a.content.is_none() && !gpu.arena.holds(a.key, a.need))
        };
        for (_, rebuilt) in &mut self.marks {
            rebuilt.tables.retain(|(_, table)| !gone(table));
        }
        self.settle(gpu);
        let mut asks: Vec<Ask> = Vec::new();
        let mut owners: Vec<(usize, usize, usize)> = Vec::new();
        for (m, (_, rebuilt)) in self.marks.iter_mut().enumerate() {
            for (t, (_, table)) in rebuilt.tables.iter_mut().enumerate() {
                for (at, ask) in table.asks.drain(..) {
                    owners.push((m, t, at));
                    asks.push(ask);
                }
            }
        }
        if asks.is_empty() {
            return true;
        }
        let reserved = gpu.arena.reserve(device, queue, &mut asks);
        for ((m, t, at), ask) in owners.into_iter().zip(asks) {
            let table = &mut self.marks[m].1.tables[t].1;
            if reserved {
                table.pins.push(ask.key);
                table.missing.push((at, ask.key, ask.need));
            } else {
                table.asks.push((at, ask));
            }
        }
        reserved
    }

    /// Keeps each rewrite only while the swap would replace every table that pins the page it
    /// writes over, and nothing has made the new page resident or asks for it whole. Marks that
    /// read one field pin its pages together and rewrite them together, so the pins on a page then
    /// equal the staged rewrites naming it. Any other rewrite becomes a page to reserve whole:
    /// another view, or a view drawing a snapshot of the version before, still reads the block.
    /// Returns whether any rewrite became a page to reserve.
    fn settle(&mut self, gpu: &Inner) -> bool {
        let tables = || self.marks.iter().flat_map(|(_, rebuilt)| &rebuilt.tables).map(|(_, table)| table);
        if tables().all(|table| table.rewrites.is_empty()) {
            return false;
        }
        let mut naming: FxHashMap<PageKey, u32> = FxHashMap::default();
        for rewrite in tables().flat_map(|table| &table.rewrites) {
            *naming.entry(rewrite.from).or_default() += 1;
        }
        let asked: FxHashSet<PageKey> = tables().flat_map(|table| &table.asks).map(|(_, ask)| ask.key).collect();
        let sole = |rewrite: &Rewrite| {
            let block = gpu.arena.block_of(rewrite.from, rewrite.ask.need);
            !asked.contains(&rewrite.ask.key)
                && !gpu.arena.holds(rewrite.ask.key, 0)
                && block.is_some_and(|(_, pins)| pins == naming[&rewrite.from])
        };
        let mut asks = false;
        for (_, rebuilt) in &mut self.marks {
            for (_, table) in &mut rebuilt.tables {
                for rewrite in table.rewrites.extract_if(.., |rewrite| !sole(rewrite)) {
                    table.words[rewrite.at] = wgsl::NONE;
                    table.asks.push((rewrite.at, rewrite.ask));
                    asks = true;
                }
            }
        }
        asks
    }

    /// Whether the staged tables can swap in now: every page each one reads is resident, and each
    /// page rewritten in place still has its block to itself. Fills in the offsets of the pages
    /// that arrived. Other datasets reserve pages after this one does, so the rewrites are checked
    /// again here, right before the swap. One that lost its block reserves its page whole, and the
    /// tables wait for it unless it is resident already.
    pub(crate) fn ready(&mut self, gpu: &mut Inner, device: &wgpu::Device, queue: &Queue) -> bool {
        if self.settle(gpu) && !self.reserve(gpu, device, queue) {
            return false;
        }
        self.marks.iter_mut().fold(true, |ready, (_, rebuilt)| rebuilt.ready(gpu) && ready)
    }

    /// Whether a staged table still has pages to reserve, for lack of space.
    pub(crate) fn unreserved(&self) -> bool {
        self.marks.iter().flat_map(|(_, rebuilt)| &rebuilt.tables).any(|(_, table)| !table.asks.is_empty())
    }

    /// Removes and returns mark `mark`'s staged tables, to publish them.
    pub(crate) fn take(&mut self, mark: usize) -> Option<Rebuilt> {
        let at = self.marks.iter().position(|(m, _)| *m == mark)?;
        Some(self.marks.swap_remove(at).1)
    }

    /// Drops mark `mark`'s staged tables, after it recompiled or was removed.
    pub(crate) fn forget(&mut self, mark: usize, gpu: &mut Inner) {
        if let Some(rebuilt) = self.take(mark) {
            rebuilt.release(gpu);
        }
    }

    /// Unpins every staged table.
    pub(crate) fn release(self, gpu: &mut Inner) {
        for (_, rebuilt) in self.marks {
            rebuilt.release(gpu);
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.marks.is_empty()
    }
}

/// The column tables a mark's program reads: one per program column, then one per join.
#[derive(Default)]
pub(crate) struct Tables {
    current: Vec<ColumnTable>,
    /// The geometry column's table before it was last rebuilt, kept while the mark eases from it.
    frozen: Option<ColumnTable>,
    joins: Vec<Join>,
    synced: bool,
    /// The row structure of the table last synced. A program that reads no columns tracks only
    /// this.
    structure: Option<Version>,
    /// Incremented whenever a table is swapped in.
    generation: u64,
}

/// What publishing rebuilt tables changed. Bit `i` of `columns` is set for each program column
/// whose table changed. Bit `i` of `data` is set for each whose data changed, not only its paging,
/// and of `valued` for each of those that held a value in some row before: a derived column that
/// held none, such as places before a layout lands, changes without anything to ease from. `blocks`
/// lists the row blocks whose pages changed, or is `None` when every row changed.
pub(crate) struct Published {
    pub(crate) columns: u64,
    pub(crate) data: u64,
    pub(crate) valued: u64,
    pub(crate) blocks: Option<Vec<u32>>,
}

/// A mark's own dataset and table, the tables derived beside it, and, for a paged table, the shapes
/// made one page of its order at a time, keyed by the field each is written as.
pub(crate) struct Source<'a> {
    pub(crate) data: &'a Snapshot,
    pub(crate) table: &'a Table,
    pub(crate) derived: Beside<'a>,
    pub(crate) paged: Vec<(Name, &'a PagedShapes)>,
}

impl<'a> Source<'a> {
    /// The source of a mark drawing `style`'s table: its dataset among `all`, and the tables
    /// `derived` holds beside it, without paged shapes, which only syncing reads. `None` until the
    /// dataset has the table.
    pub(crate) fn of(style: &Style, all: &'a [Snapshot], derived: &'a Derivations) -> Option<Source<'a>> {
        let data = all.iter().find(|d| *d.name() == style.data)?;
        let table = data.table(&style.table)?;
        Some(Source { data, table, derived: derived.beside(&style.data, &style.table), paged: Vec::new() })
    }

    /// The shapes written as field `name`, made one page of the drawn order at a time.
    fn paged(&self, name: &Name) -> Option<&'a PagedShapes> {
        self.paged.iter().find(|(field, _)| field == name).map(|&(_, shapes)| shapes)
    }

    /// The dataset and table `column` reads: the mark's own, another one among `all` joined by id,
    /// or the derived table beside the mark's own that holds the field.
    pub(crate) fn table_of(&self, column: &ColumnUse, all: &'a [Snapshot]) -> Option<(&'a Name, &'a Table)> {
        if column.derived {
            let mut beside = self.derived.iter().flatten();
            let table = beside.find(|t| t.field_named(&column.name).is_some()).copied().or(self.derived[0])?;
            return Some((self.data.name(), table));
        }
        match &column.from {
            None => Some((self.data.name(), self.table)),
            Some((data, table)) => {
                let data = all.iter().find(|d| d.name() == data)?;
                Some((data.name(), data.table(table)?))
            }
        }
    }
}

/// What a sync reads besides the mark's own rows: every dataset, the shown coordinate, the trace
/// window, and the order of each paged table in the mark's dataset.
pub(crate) struct Inputs<'a> {
    pub(crate) all: &'a [Snapshot],
    pub(crate) at: f64,
    pub(crate) window: Window,
    pub(crate) orders: &'a [(Name, Order)],
}

impl Inputs<'_> {
    /// The order of table `table` in the mark's dataset, if that table is paged.
    fn order_of(&self, table: &Name) -> Option<&Order> {
        self.orders.iter().find(|(name, _)| name == table).map(|(_, order)| order)
    }

    /// The order `column` gives the rows of `reference` their places in: that of the referenced
    /// table, when it is paged and the column reads places (`Words::Bits`) for a mark of the
    /// reference's own table. `None` for the rows as their table lists them.
    fn rank_of(&self, column: &ColumnUse, reference: &Reference) -> Option<&Order> {
        self.order_of(&reference.to).filter(|_| column.from.is_none() && column.words == Words::Bits)
    }
}

/// One column a program reads: a field, or the rows a join maps to.
enum Use<'a> {
    Field { column: &'a ColumnUse, join: u32 },
    Join(&'a (Name, Name)),
}

impl Tables {
    /// Rebuilds the tables whose inputs changed, for `source` paged as `rows`, with `inputs`.
    /// Changes are measured against the `staged` tables if any, otherwise the current ones. Each
    /// table is built once and requests its pages. `None` when nothing changed.
    pub(crate) fn rebuild(
        &mut self,
        program: &Program,
        source: &Source<'_>,
        rows: Rows<'_>,
        inputs: &Inputs<'_>,
        staged: Option<&Rebuilt>,
        gpu: &mut Inner,
    ) -> Option<Rebuilt> {
        let joins = joins(program);
        // Each join's rows, when the mark's rows are paged as its data is. A drawing holds the rows
        // in its own order, and packs each join's rows in that order instead.
        let built: Vec<usize> = match rows {
            Rows::Own => joins.iter().map(|from| self.join(from, source, inputs.all)).collect(),
            Rows::Held(_) => Vec::new(),
        };
        let fields = program.columns.iter().map(|column| {
            let join = match (&column.from, column.through) {
                (None, _) => wgsl::NONE,
                // The column of rows that the field's reference names.
                (Some(_), Some(rows)) => rows,
                (Some(from), None) => {
                    let k = joins.iter().position(|j| *j == from).expect("listed");
                    // A join whose rows each read their own row is no join.
                    let aligned = built.get(k).is_some_and(|&at| self.joins[at].rows.is_none());
                    if aligned { wgsl::NONE } else { (program.columns.len() + k) as u32 }
                }
            };
            Use::Field { column, join }
        });
        let uses: Vec<Use<'_>> = fields.chain(joins.iter().map(|from| Use::Join(from))).collect();
        // Rebuild every table when there are no tables of this shape yet. If a reshape is already
        // staged, compare against it instead.
        let reshaped = staged.is_some_and(|s| s.reshape && s.tables.len() == uses.len());
        let reshape = !reshaped
            && (!self.synced
                || self.current.len() != uses.len()
                || (uses.is_empty() && self.structure != Some(source.table.structure)));
        self.structure = Some(source.table.structure);
        let held = rows.stamp();
        let mut rebuilt: Vec<(usize, ColumnTable)> = Vec::new();
        for (i, use_) in uses.iter().enumerate() {
            let (stamp, paged) = match use_ {
                Use::Field { column, .. } => {
                    (stamp(column, source, inputs), if column.from.is_none() { held } else { 0 })
                }
                Use::Join(from) => match joined(from, inputs.all) {
                    Some(other) => (Stamp::Join(source.table.structure, other.structure), held),
                    None => (Stamp::Missing, held),
                },
            };
            // The join a field reads through, which changes when its tables come to list the same
            // rows, or stop.
            let join = match use_ {
                Use::Field { join, .. } => *join,
                Use::Join(_) => wgsl::NONE,
            };
            // The staged replacement for table `i` if any, else the current table.
            let waiting = staged.and_then(|s| s.tables.iter().find(|(j, _)| *j == i));
            let latest = waiting.map(|(_, t)| t).or(self.current.get(i));
            let same = |t: &ColumnTable| {
                t.stamp == stamp && t.held == paged && t.descriptor[wgsl::COLUMN_JOIN as usize] == join
            };
            if !reshape && latest.is_some_and(same) {
                continue;
            }
            let mut table = match use_ {
                Use::Field { column, .. } => {
                    let rows = if column.from.is_none() { rows } else { Rows::Own };
                    // The pages the GPU holds for the column now, which this table's pages may have
                    // been written over. A staged table's pages were never drawn.
                    let drawn = self.current.get(i).filter(|t| !reshape && !reshaped && paged == 0 && t.rewritable());
                    let mut builder = Builder::new(gpu, drawn.and_then(|t| t.pages.as_deref()));
                    let mut descriptor = builder.column(column, source, rows, inputs);
                    descriptor[wgsl::COLUMN_JOIN as usize] = join;
                    builder.finish(stamp, paged, descriptor)
                }
                Use::Join(from) => {
                    let join = built.get(i - program.columns.len()).map(|&at| &self.joins[at]);
                    let mut builder = Builder::new(gpu, None);
                    let descriptor = builder.join(join, from, source, rows, inputs.all);
                    builder.finish(stamp, paged, descriptor)
                }
            };
            if let Some(before) = waiting.map(|(_, t)| t).or(self.current.get(i)) {
                table.retain_trace(before);
            }
            rebuilt.push((i, table));
        }
        (reshape || !rebuilt.is_empty()).then_some(Rebuilt { tables: rebuilt, reshape })
    }

    /// Swaps in the `rebuilt` tables, whose pages are all resident, and releases the replaced ones.
    /// Pages rewritten in place take over their blocks now, written through `queue` before this
    /// frame's passes read them. The replaced table of geometry column `geometry` stays frozen
    /// instead, for the mark to ease from. `source` is the mark's table as the tables read it,
    /// paged as `rows`, among the datasets `all`.
    #[allow(clippy::too_many_arguments, reason = "one swap, and what it changed for the mark's rows")]
    pub(crate) fn publish(
        &mut self,
        rebuilt: Rebuilt,
        program: &Program,
        geometry: u32,
        source: &Source<'_>,
        rows: Rows<'_>,
        all: &[Snapshot],
        gpu: &mut Inner,
        queue: &Queue,
    ) -> Published {
        let Rebuilt { tables: mut rebuilt, reshape } = rebuilt;
        self.generation += 1;
        for (_, table) in &mut rebuilt {
            table.generation = self.generation;
            table.rewrite(gpu, queue);
        }
        let joins = joins(program);
        let published = if reshape {
            self.thaw(gpu);
            for table in std::mem::take(&mut self.current) {
                unpin(&table.pins, gpu);
            }
            let mut tables: Vec<Option<ColumnTable>> = Vec::new();
            for (i, table) in rebuilt {
                if tables.len() <= i {
                    tables.resize_with(i + 1, || None);
                }
                tables[i] = Some(table);
            }
            self.current = tables.into_iter().map(|t| t.expect("every table rebuilt")).collect();
            Published { columns: u64::MAX, data: u64::MAX, valued: u64::MAX, blocks: None }
        } else {
            let mut published = Published { columns: 0, data: 0, valued: 0, blocks: Some(Vec::new()) };
            let mut changes: Vec<(usize, Option<Changed>)> = Vec::new();
            for (i, table) in rebuilt {
                changes.push((i, changed(&self.current[i], &table)));
                let bits = match program.columns.get(i) {
                    Some(_) => Reads::column(i),
                    None => columns_from(program, joins[i - program.columns.len()]),
                };
                published.columns |= bits;
                if table.stamp != self.current[i].stamp {
                    published.data |= bits;
                    if self.current[i].valued {
                        published.valued |= bits;
                    }
                }
                let old = std::mem::replace(&mut self.current[i], table);
                if i as u32 == geometry {
                    self.thaw(gpu);
                    self.frozen = Some(old);
                } else {
                    old.retire(&self.current[i], gpu);
                }
            }
            // A field of another table changes the rows reading the rows written there, as the
            // mark's table now names them.
            for (i, change) in changes {
                let more = change.and_then(|change| match change {
                    Changed::Blocks(blocks) => Some(blocks),
                    Changed::Rows(written) => self
                        .via(program.columns.get(i)?, program, source, rows, all)
                        .and_then(|via| readers(&via, &written, source.table, rows)),
                });
                match (published.blocks.as_mut(), more) {
                    (Some(blocks), Some(more)) => blocks.extend(more),
                    _ => published.blocks = None,
                }
            }
            published
        };
        self.synced = true;
        published
    }

    /// Drops the frozen geometry table, so the mark stops easing from it.
    pub(crate) fn thaw(&mut self, gpu: &mut Inner) {
        if let Some(table) = self.frozen.take() {
            unpin(&table.pins, gpu);
        }
    }

    /// The column index the frozen geometry table is packed at, if there is one.
    pub(crate) fn frozen(&self) -> Option<u32> {
        self.frozen.as_ref().map(|_| self.current.len() as u32)
    }

    /// Publication that last replaced `column`, or 0 when the column is absent.
    pub(crate) fn column_generation(&self, column: u32) -> u64 {
        self.current.get(column as usize).map_or(0, |t| t.generation)
    }

    /// The most points the paths of geometry column `column` take. 0 for other columns.
    pub(crate) fn points(&self, column: u32) -> u32 {
        self.current.get(column as usize).map_or(0, |t| t.points)
    }

    /// Whether program column `column` reads a field its table has.
    pub(crate) fn holds(&self, column: u32) -> bool {
        self.current.get(column as usize).is_some_and(|t| t.stamp != Stamp::Missing)
    }

    /// Whether the tables were built at least once.
    pub(crate) fn synced(&self) -> bool {
        self.synced
    }

    /// What the traced column draws.
    pub(crate) fn plan(&self) -> Option<&Plan> {
        self.current.iter().find_map(|t| t.plan.as_ref())
    }

    /// Points the traced column draws.
    pub(crate) fn traced(&self) -> u32 {
        self.plan().map_or(0, |plan| plan.points)
    }

    /// Absolute trace-record address, points per row, row-block count, capacity, and ring head.
    /// Uniforms carry these dimensions, avoiding descriptor and header fetches for every vertex.
    pub(crate) fn trace_layout(&self, base: u32) -> Option<[u32; 5]> {
        let mut at = base + (self.packed().count() * WORDS).next_multiple_of(4) as u32;
        for table in self.packed() {
            if table.plan.is_some() {
                return Some([at + 4, table.words[0], table.words[1], table.words[2], table.words[3]]);
            }
            at += table.words.len().next_multiple_of(4) as u32;
        }
        None
    }

    /// Words the descriptors and tables take in the program buffer.
    pub(crate) fn len(&self) -> usize {
        (self.packed().count() * WORDS).next_multiple_of(4)
            + self.packed().map(|t| t.words.len().next_multiple_of(4)).sum::<usize>()
    }

    /// The tables packed: the current ones, then the frozen geometry table.
    fn packed(&self) -> impl Iterator<Item = &ColumnTable> + Clone {
        self.current.iter().chain(&self.frozen)
    }

    /// The pages the current and frozen tables pin.
    pub(crate) fn pins(&self) -> impl Iterator<Item = PageKey> + '_ {
        self.packed().flat_map(|t| t.pins.iter().copied())
    }

    /// Appends every descriptor, then every table. `base` is the program-buffer word of the first
    /// descriptor, which makes table offsets absolute.
    pub(crate) fn pack(&self, base: u32, out: &mut Vec<u32>) {
        let start = out.len();
        let descriptors = (self.packed().count() * WORDS).next_multiple_of(4);
        let mut at = base + descriptors as u32;
        for table in self.packed() {
            let mut d = table.descriptor;
            d[wgsl::COLUMN_TABLE as usize] += at;
            if d[wgsl::COLUMN_LOW as usize] != wgsl::NONE {
                d[wgsl::COLUMN_LOW as usize] += at;
            }
            out.extend(d);
            at += table.words.len().next_multiple_of(4) as u32;
        }
        out.resize(start + descriptors, 0);
        for table in self.packed() {
            let start = out.len();
            out.extend(&table.words);
            for &(destination, source, offset) in &table.cursors {
                let page = table.words[source];
                out[start + destination] = if page == wgsl::NONE { wgsl::NONE } else { page + offset };
            }
            out.resize(start + table.words.len().next_multiple_of(4), 0);
        }
    }

    /// Unpins every table and marks the tables unsynced.
    pub(crate) fn release(&mut self, gpu: &mut Inner) {
        self.thaw(gpu);
        for table in self.current.drain(..) {
            unpin(&table.pins, gpu);
        }
        self.synced = false;
    }

    /// Where the join from `from` lies among `joins`. It is built again only when either table's
    /// rows came or went, so a frame that changes values builds none.
    fn join(&mut self, from: &(Name, Name), source: &Source<'_>, all: &[Snapshot]) -> usize {
        let other = joined(from, all);
        let structure = (source.table.structure, other.map_or(source.table.structure, |other| other.structure));
        let at = self.joins.iter().position(|join| &join.from == from).unwrap_or(self.joins.len());
        if self.joins.get(at).is_none_or(|join| join.structure != structure) {
            let join = Join::of(from, source.table, other);
            match self.joins.get_mut(at) {
                Some(stale) => *stale = join,
                None => self.joins.push(join),
            }
        }
        at
    }

    /// How the mark's rows, paged as `rows`, read `column`, a field of another table. `None`
    /// when its join was built for other rows than the tables hold now.
    fn via<'a>(
        &'a self,
        column: &ColumnUse,
        program: &Program,
        source: &Source<'a>,
        rows: Rows<'_>,
        all: &'a [Snapshot],
    ) -> Option<Via<'a>> {
        let from = column.from.as_ref()?;
        if let Some(through) = column.through {
            let field = source.table.field_named(&program.columns.get(through as usize)?.name);
            let Some(Field::Reference(reference)) = field else { return None };
            return Some(Via::Naming(reference.inverse()));
        }
        let other = joined(from, all)?;
        if let Rows::Held(_) = rows {
            return Some(Via::Ids(other));
        }
        let join = self.joins.iter().find(|join| &join.from == from)?;
        let current = join.structure == (source.table.structure, other.structure);
        current.then(|| join.rows.as_ref().map_or(Via::Own, |rows| Via::Naming(rows.naming())))
    }
}

/// What swapping a table in changed: row blocks of the mark, or rows of the other table whose
/// field the table pages.
enum Changed {
    Blocks(Vec<u32>),
    Rows(Runs),
}

/// What differs between table `before` and table `now`, which replaces it. A field of another
/// table gives the rows written there. Any other table pages the mark's rows, and gives the pages
/// that differ. `None` when either lists no pages (see `ColumnTable::pages`), so every row changed.
fn changed(before: &ColumnTable, now: &ColumnTable) -> Option<Changed> {
    if let (Some(then), Some(read)) = (&before.read, &now.read) {
        return Some(Changed::Rows(read.written_since(then)));
    }
    let (Some(old), Some(new)) = (&before.pages, &now.pages) else { return None };
    let pages = (0..old.len().max(new.len())).filter(|&p| old.get(p) != new.get(p));
    Some(Changed::Blocks(pages.map(|p| p as u32).collect()))
}

/// How a mark's rows read the rows of another table.
enum Via<'a> {
    /// Each reads the row in its own place: a join of tables listing the same ids in the same
    /// order.
    Own,
    /// The rows reading each row are listed: a reference field's, or a join's whose rows the
    /// data pages.
    Naming(&'a Inverse),
    /// Each reads the row that shares its id: a join whose rows a drawing holds.
    Ids(&'a Table),
}

/// The row blocks of `table`, paged as `rows`, whose rows read any of rows `written` of another
/// table `via` a reference or a join. It follows the rows written to the rows reading them and
/// never visits the table. `None` when every row counts as reading them: every block has such a
/// row, every row read was written, or a drawing would look up more than a page of rows.
fn readers(via: &Via<'_>, written: &Runs, table: &Table, rows: Rows<'_>) -> Option<Vec<u32>> {
    let naming = match via {
        Via::Own => {
            let pages = |run: &Range<u32>| run.start >> wgsl::PAGE_BITS..=(run.end - 1) >> wgsl::PAGE_BITS;
            let mut blocks: Vec<u32> = written.ranges().iter().flat_map(pages).collect();
            blocks.dedup();
            return Some(blocks);
        }
        Via::Naming(naming) if written.len() >= naming.targets() => return None,
        Via::Naming(naming) => Some(*naming),
        Via::Ids(_) => None,
    };
    let count = match rows {
        Rows::Own => table.len().div_ceil(wgsl::PAGE_ROWS as usize),
        Rows::Held(drawing) => drawing.slot_count(),
    };
    // The data's pages place a row with a shift. A drawing looks it up.
    let mut left = match rows {
        Rows::Own => table.len(),
        Rows::Held(_) => wgsl::PAGE_ROWS as usize,
    };
    let (mut reads, mut found) = (vec![false; count], 0);
    // Counts one row followed, which `row` of the table reads if any.
    let mut follow = |row: Option<u32>| {
        left = left.checked_sub(1)?;
        if let Some(block) = row.and_then(|row| rows.block(row))
            && let Some(read) = reads.get_mut(block as usize)
            && !*read
        {
            *read = true;
            found += 1;
        }
        (found < count).then_some(())
    };
    match (naming, via) {
        (Some(naming), _) => {
            for run in written.ranges() {
                naming.over(run.clone()).iter().try_for_each(|&row| follow(Some(row)))?;
            }
        }
        (None, Via::Ids(other)) => {
            let own = |row: u32| other.ids.key(row as usize).and_then(|key| table.row(key));
            written.iter().try_for_each(|row| follow(own(row).map(|row| row as u32)))?;
        }
        (None, _) => {}
    }
    Some((0..count as u32).filter(|&block| reads[block as usize]).collect())
}

fn unpin(pins: &[PageKey], gpu: &mut Inner) {
    for &key in pins {
        gpu.arena.unpin(key);
    }
}

/// The distinct tables the program's joins read, in first-read order. A field read through a
/// reference joins nothing: the reference's rows are a column of the program.
fn joins(program: &Program) -> Vec<&(Name, Name)> {
    let mut joins: Vec<&(Name, Name)> = Vec::new();
    for from in program.columns.iter().filter(|c| c.through.is_none()).filter_map(|c| c.from.as_ref()) {
        if !joins.contains(&from) {
            joins.push(from);
        }
    }
    joins
}

/// Bits of the program's columns that read through the join from `from`.
fn columns_from(program: &Program, from: &(Name, Name)) -> u64 {
    program
        .columns
        .iter()
        .enumerate()
        .filter(|(_, c)| c.through.is_none() && c.from.as_ref() == Some(from))
        .fold(0, |bits, (i, _)| bits | Reads::column(i))
}

/// The table a join reads.
fn joined<'a>((data, table): &(Name, Name), all: &'a [Snapshot]) -> Option<&'a Table> {
    all.iter().find(|d| d.name() == data)?.table(table)
}

/// What a trace across `window` draws: the runs covering its frames at the level of detail they
/// need, with one point left out between runs that do not meet, which breaks the line.
///
/// Frames draw as they are while that takes no more points than two a pixel column. Past that,
/// entries narrower than a column draw as columns: two points a column, exact to the pixel. Only
/// entries wider than a column, which stand in while finer ones load or when the budget allows no
/// finer, draw as lines through their least and greatest values.
///
/// A column's entries stop where a value page of any of `blocks` ends, so every row block reads
/// them from one page. Without blocks, the plan is the same but for those stops.
fn plan(axis: &Samples, window: Window, blocks: &[(Samples, usize)]) -> Plan {
    let frames = window.across.map_or(axis.start()..axis.end(), |across| axis.across(across));
    let count = frames.end - frames.start;
    let columns = u64::from(window.columns.max(1));
    let level = detail(count, window.columns, window.most);
    // The width of a pixel column on the axis. Columns count from 0 on the axis, so panning keeps
    // each entry in its column. The width is rounded to an `f32`, so rounding in the window's ends
    // as it pans leaves the columns where they were.
    let width =
        window.across.or_else(|| axis.span()).map_or(0.0, |[a, b]| f64::from(((b - a) / columns as f64) as f32));
    let (mut runs, mut point, mut last) = (Vec::new(), 0, None);
    for run in axis.cover(frames, level) {
        let spanned = run.frames();
        if last.is_some_and(|end| end != spanned.start) {
            point += 1;
        }
        let lines = match run.level {
            0 => count <= 2 * columns,
            level => bucket_frames(level).saturating_mul(columns) > count,
        };
        let shape = if lines || width.is_nan() || width <= 0.0 {
            Shape::Lines
        } else {
            Shape::Columns(columns_of(axis, &run, width, &page_ends(blocks, &run)))
        };
        last = Some(spanned.end);
        let drawn = Drawn { run, first: point, shape };
        point += drawn.points(window.steps);
        runs.push(drawn);
    }
    Plan { runs, points: point, steps: window.steps }
}

/// Where each pixel column's entries start in `run`, with the bits of the coordinate at the
/// column's middle. A column `width` wide holds the entries whose middles lie in it. Its entries
/// stop at `TRACE_MOST`, the most a point reads, and before each of `ends`, and go on in another
/// column at the same coordinate.
fn columns_of(axis: &Samples, run: &Run, width: f64, ends: &[u64]) -> Vec<(u32, u64)> {
    let mut columns: Vec<(u32, u64)> = Vec::new();
    let (mut column, mut held) = (None, 0);
    for (i, x) in axis.drawn(run).into_iter().enumerate() {
        let within = (x / width).floor();
        let stops = held == wgsl::TRACE_MOST || ends.binary_search(&(run.entries.start + i as u64)).is_ok();
        if column != Some(within.to_bits()) || stops {
            columns.push((i as u32, ((within + 0.5) * width).to_bits()));
            (column, held) = (Some(within.to_bits()), 0);
        }
        held += 1;
    }
    columns
}

/// The entries of `run` at which a value page of any of `blocks` ends, ascending.
fn page_ends(blocks: &[(Samples, usize)], run: &Run) -> Vec<u64> {
    let mut ends: Vec<u64> = Vec::new();
    for (samples, block) in blocks {
        for side in 0..sides(run.level) {
            let pages = samples.pages(*block, run.level, side, run.entries.clone());
            ends.extend(pages.into_iter().map(|(_, held)| held.end));
        }
    }
    ends.sort_unstable();
    ends.dedup();
    ends
}

/// Where sampled `column` reads `samples` at axis coordinate `at`: the frame shown there, and how
/// far toward the next one it is (0 for a column that steps).
fn shown_frame(samples: &Samples, column: &ColumnUse, at: f64) -> (Option<u64>, f32) {
    let frame = samples.frame_at(at);
    let t = if column.step { 0.0 } else { frame.map_or(0.0, |f| samples.t(f, at)) };
    (frame, t)
}

/// A column descriptor with `flags`, reading no low parts and no join.
fn descriptor(flags: u32) -> [u32; WORDS] {
    let mut d = [0; WORDS];
    d[wgsl::COLUMN_FLAGS as usize] = flags;
    d[wgsl::COLUMN_LOW as usize] = wgsl::NONE;
    d[wgsl::COLUMN_JOIN as usize] = wgsl::NONE;
    d
}

/// The cache key of a column of `table` packed in `drawing`'s order: field `field` as `words`.
fn packing(drawing: &Drawing, source: &Source<'_>, table: &Name, field: Name, words: Words) -> Packing {
    Packing {
        order: drawing.order.id(),
        origin: source.data.origin(),
        table: table.clone(),
        field,
        derived: false,
        words,
        low: false,
        reads: 0,
    }
}

fn stamp(column: &ColumnUse, source: &Source<'_>, inputs: &Inputs<'_>) -> Stamp {
    if let Some(shapes) = source.paged(&column.name).filter(|_| column.derived) {
        return Stamp::Field(shapes.version, shapes.order);
    }
    let Some((_, table)) = source.table_of(column, inputs.all) else { return Stamp::Missing };
    match table.field_named(&column.name) {
        None => Stamp::Missing,
        Some(Field::Sampled(samples, version)) if column.trace => {
            Stamp::Trace(*version, plan(samples, inputs.window, &[]))
        }
        Some(Field::Sampled(samples, version)) => {
            let (frame, t) = shown_frame(samples, column, inputs.at);
            Stamp::Sampled(*version, frame, t.to_bits())
        }
        Some(Field::Reference(reference)) => {
            Stamp::Field(reference.version, inputs.rank_of(column, reference).map_or(0, Order::id))
        }
        Some(field) => Stamp::Field(field.version(), 0),
    }
}

/// Builds one column's table, requesting each page it reads.
struct Builder<'g> {
    words: Vec<u32>,
    cursors: Vec<(usize, usize, u32)>,
    asks: Vec<(usize, Ask)>,
    rewrites: Vec<Rewrite>,
    plan: Option<Plan>,
    points: u32,
    /// The page each page of rows reads, while every row reads only its own page.
    pages: Option<Vec<Option<PageId>>>,
    /// The page each page of rows reads in the table the GPU draws now, which this one replaces,
    /// when that table pins the pages it lists (see `ColumnTable::rewritable`).
    drawn: Option<&'g [Option<PageId>]>,
    read: Option<Column>,
    /// Whether any row read holds a value. Assumed unless the table reads a derived field that holds
    /// none.
    valued: bool,
    gpu: &'g mut Inner,
}

impl<'g> Builder<'g> {
    fn new(gpu: &'g mut Inner, drawn: Option<&'g [Option<PageId>]>) -> Builder<'g> {
        Builder {
            words: Vec::new(),
            cursors: Vec::new(),
            asks: Vec::new(),
            rewrites: Vec::new(),
            plan: None,
            points: 0,
            pages: Some(Vec::new()),
            drawn,
            read: None,
            valued: true,
            gpu,
        }
    }

    fn finish(self, stamp: Stamp, held: u64, descriptor: [u32; WORDS]) -> ColumnTable {
        let Builder { words, cursors, asks, rewrites, plan, points, pages, drawn: _, read, valued, gpu: _ } = self;
        ColumnTable {
            stamp,
            generation: 0,
            held,
            descriptor,
            words,
            cursors,
            asks,
            rewrites,
            pins: Vec::new(),
            missing: Vec::new(),
            plan,
            points,
            pages,
            read,
            valued,
        }
    }

    /// Appends a word for the offset of `page`, page `p` of a column of an unpaged table, read as
    /// `words`. A page written over the one the GPU draws there takes over its block when the
    /// dataset swaps in, so the word holds that block's offset now (see [`Rewrite`]). Any other
    /// page is requested whole. `content` builds the page's upload.
    fn page(&mut self, p: usize, page: &Page, words: Words, low: bool, content: impl FnOnce() -> Content) {
        let (key, need) = (PageKey::of(page.id, words, low), page.values.len() as u32);
        let Some((from, offset, rows)) = self.written_over(p, page, key, need) else {
            return self.push(key, need, content);
        };
        let ask = Ask { key, need, content: Some(content()) };
        self.rewrites.push(Rewrite { at: self.words.len(), from, rows, ask });
        self.words.push(offset);
    }

    /// The page the GPU draws as page `p` of the column, when `page` was written over it and can
    /// take over its block: its key, where its block lies, and the rows written since. `None` when
    /// the page is new to the column or already resident, when it no longer remembers the page it
    /// was written over, or when that page's block is uploading or too small.
    fn written_over(&self, p: usize, page: &Page, key: PageKey, need: u32) -> Option<(PageKey, u32, Vec<Range<u32>>)> {
        let drawn = (*self.drawn?.get(p)?)?;
        if drawn == page.id || self.gpu.arena.holds(key, 0) {
            return None;
        }
        let from = PageKey { page: drawn, ..key };
        let (offset, _) = self.gpu.arena.block_of(from, need)?;
        Some((from, offset, page.rows_since(drawn)?))
    }

    /// Requests page `key`, holding `need` words, whose offset goes to word `at` once it arrives.
    /// Until then the word is `NONE` and the table waits. `content` builds the upload when the
    /// arena lacks the page.
    fn place(&mut self, at: usize, key: PageKey, need: u32, content: impl FnOnce() -> Content) {
        let content = (!self.gpu.arena.holds(key, need)).then(content);
        self.asks.push((at, Ask { key, need, content }));
        self.words[at] = wgsl::NONE;
    }

    /// Appends a word for page `key`'s offset, which [`place`](Builder::place) fills.
    fn push(&mut self, key: PageKey, need: u32, content: impl FnOnce() -> Content) {
        self.words.push(wgsl::NONE);
        let at = self.words.len() - 1;
        self.place(at, key, need, content);
    }

    /// Records `page` as the page the next page of rows reads.
    fn list(&mut self, page: Option<PageId>) {
        if let Some(pages) = &mut self.pages {
            pages.push(page);
        }
    }

    fn column(&mut self, column: &ColumnUse, source: &Source<'_>, rows: Rows<'_>, inputs: &Inputs<'_>) -> [u32; WORDS] {
        let mut d = descriptor(if matches!(column.words, Words::Bits | Words::Rows) { wgsl::BITS } else { 0 });
        if let Rows::Held(drawing) = rows
            && let Some(shapes) = source.paged(&column.name).filter(|_| column.derived)
        {
            d[wgsl::COLUMN_ROWS as usize] = drawing.live();
            let packing = packing(drawing, source, &source.table.name, column.name.clone(), Words::Path);
            let pointed = |shapes: &Values| shapes.geometry().is_some_and(|geometry| !geometry.coords().is_empty());
            self.valued = shapes.pages.values().any(|page| pointed(&page.shapes)) || shapes.kept.values().any(pointed);
            self.shaped(shapes, drawing, &packing);
            return d;
        }
        let Some((data, table)) = source.table_of(column, inputs.all) else {
            self.pages = None;
            self.valued = !column.derived;
            return d;
        };
        d[wgsl::COLUMN_ROWS as usize] = table.len() as u32;
        let field = table.field_named(&column.name);
        // A row with no place or shape draws nothing, so a derived field that holds none has
        // nothing to ease from. A missing value of the data draws with the theme's look, which a
        // change eases from.
        self.valued = !column.derived
            || match field {
                Some(Field::Values(values, _)) => values.holds_any(),
                Some(_) => true,
                None => false,
            };
        if column.from.is_some() {
            self.read = match field {
                Some(Field::Values(values, _)) => Some(values.clone()),
                Some(Field::Reference(reference)) => Some(reference.rows.clone()),
                _ => None,
            };
        }
        if let Rows::Held(drawing) = rows {
            d[wgsl::COLUMN_ROWS as usize] = drawing.live();
            // A derived field, such as a layout's `x`, shares its table's name, and may share its name
            // with a field of the data.
            let packing = Packing {
                derived: column.derived,
                ..packing(drawing, source, &table.name, column.name.clone(), column.words)
            };
            self.held(column, data, field, drawing, packing, inputs, &mut d);
            return d;
        }
        match field {
            Some(Field::Values(values, _)) if column.words == Words::Codes => {
                let field = (data, &table.name, &column.name);
                for (p, page) in values.pages().iter().enumerate() {
                    self.list(Some(page.id));
                    // Each page is coded once, resident or not, so the dictionary holds its texts.
                    let codes = self.gpu.dictionaries.field(field.0, field.1, field.2).codes(page);
                    self.page(p, page, Words::Codes, false, || Content::Computed(codes.to_vec()));
                }
            }
            Some(Field::Values(values, _)) if column.words == Words::Path => self.path(values),
            Some(Field::Values(values, _)) => {
                values.pages().iter().for_each(|page| self.list(Some(page.id)));
                self.pages(values, column.words, false);
                if column.low {
                    d[wgsl::COLUMN_LOW as usize] = self.words.len() as u32;
                    self.pages(values, column.words, true);
                }
            }
            Some(Field::Reference(reference)) => {
                reference.rows.pages().iter().for_each(|page| self.list(Some(page.id)));
                match inputs.rank_of(column, reference) {
                    // The referenced rows' places in their table's order.
                    Some(order) => {
                        for (p, page) in reference.rows.pages().iter().enumerate() {
                            let id = self.gpu.packed.ranked(page.id, order.id());
                            let key = PageKey::of(id, Words::Bits, false);
                            let need = page.values.len() as u32;
                            self.push(key, need, || Content::Computed(packed::ranked_page(reference, p, order)));
                        }
                    }
                    None => self.pages(&reference.rows, Words::Bits, false),
                }
            }
            Some(Field::Sampled(samples, _)) if column.trace => {
                let blocks: Vec<(Samples, usize)> =
                    (0..table.len().div_ceil(wgsl::PAGE_ROWS as usize)).map(|b| (samples.clone(), b)).collect();
                self.trace(&mut d, samples, &blocks, inputs.window);
            }
            Some(Field::Sampled(samples, _)) => {
                let frame = self.sampled(&mut d, column, samples, inputs.at);
                self.cursors(samples, frame, table.len());
            }
            None => self.pages = None,
        }
        d
    }

    /// Sets descriptor `d` to read sampled `column` at axis coordinate `at`, through a cursor per
    /// page of rows. Returns the frame shown there.
    fn sampled(&mut self, d: &mut [u32; WORDS], column: &ColumnUse, samples: &Samples, at: f64) -> Option<u64> {
        self.pages = None;
        d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED | if column.step { wgsl::STEP } else { 0 };
        let (frame, t) = shown_frame(samples, column, at);
        d[wgsl::COLUMN_T as usize] = t.to_bits();
        frame
    }

    /// A paged table's column: one page packed in the table's order per slot, cached under
    /// `packing`.
    #[allow(clippy::too_many_arguments, reason = "one column's pages in its order")]
    fn held(
        &mut self,
        column: &ColumnUse,
        data: &Name,
        field: Option<&Field>,
        drawing: &Drawing,
        packing: Packing,
        inputs: &Inputs<'_>,
        d: &mut [u32; WORDS],
    ) {
        let order = &drawing.order;
        let slots = drawing.slot_count();
        match field {
            Some(Field::Values(values, _)) if column.words == Words::Codes => {
                let field = (packing.table.clone(), packing.field.clone());
                self.held_pages(drawing, &packing, Some(values), |gpu, rows| {
                    let mut codes = gpu.dictionaries.field(data, &field.0, &field.1).rows(values, rows);
                    codes.resize(wgsl::PAGE_ROWS as usize, wgsl::MISSING);
                    codes
                });
            }
            Some(Field::Values(values, _)) if column.words == Words::Path => self.held_path(values, drawing, &packing),
            Some(Field::Values(values, _)) => {
                let words = column.words;
                self.held_pages(drawing, &packing, Some(values), |_, rows| packed::values(values, rows, words, false));
                if column.low {
                    d[wgsl::COLUMN_LOW as usize] = self.words.len() as u32;
                    let low = Packing { low: true, ..packing };
                    let listed = self.pages.take();
                    self.held_pages(drawing, &low, Some(values), |_, rows| packed::values(values, rows, words, true));
                    self.pages = listed;
                }
            }
            Some(Field::Reference(reference)) => {
                // Rows no order ranks are the same words however the column reads them.
                let target = inputs.rank_of(column, reference);
                let packing = Packing { reads: target.map_or(0, Order::id), words: Words::Bits, ..packing };
                self.held_pages(drawing, &packing, Some(&reference.rows), |_, rows| {
                    packed::targets(reference, rows, target)
                });
            }
            Some(Field::Sampled(samples, version)) if column.trace => {
                let packing = Packing { reads: stamp_of(version), ..packing };
                let blocks: Vec<(Samples, usize)> = (0..slots)
                    .map(|s| match slot_key(&packing, drawing, s) {
                        None => (Samples::default(), 0),
                        Some((packing, page)) => {
                            (self.gpu.packed.samples(&packing, page, &drawing.rows(s), samples), 0)
                        }
                    })
                    .collect();
                self.trace(d, samples, &blocks, inputs.window);
            }
            Some(Field::Sampled(samples, version)) => {
                let frame = self.sampled(d, column, samples, inputs.at);
                // A cursor per slot, reading the frame packed in the slot's rows.
                for s in 0..slots {
                    let at = self.cursor_words();
                    let Some((base, page)) = slot_key(&packing, drawing, s) else { continue };
                    for (k, f) in [frame, frame.map(|f| f + 1)].into_iter().enumerate() {
                        let Some(f) = f.filter(|&f| samples.held(0, f)) else { continue };
                        let packing = Packing { reads: stamp_of((version, f)), ..base.clone() };
                        let id = self.gpu.packed.page(&packing, order, None, page);
                        let key = PageKey::of(id, Words::Values, false);
                        let rows = drawing.rows(s);
                        let counters = self.gpu.packed.counters();
                        let content = || {
                            counters.add(Count::Packed, rows.len() as u64);
                            Content::Computed(packed::frame(samples, &rows, Some(f)))
                        };
                        self.cursor(at, k, key, 0, wgsl::PAGE_ROWS, content);
                    }
                }
            }
            None => self.pages = None,
        }
    }

    /// Appends the page of `packing` in each slot of `drawing`, packed from `source` by `pack` the
    /// first time it is needed, or `NONE` for a free slot. The order's pages are looked up in one
    /// pass over the column, and each page of kept rows separately.
    fn held_pages(
        &mut self,
        drawing: &Drawing,
        packing: &Packing,
        source: Option<&Column>,
        pack: impl Fn(&mut Inner, &[u32]) -> Vec<u32>,
    ) {
        let slots = drawing.slot_count();
        let pages: Vec<u32> = (0..slots)
            .filter_map(|s| match drawing.holds(s) {
                Holds::Page(page) => Some(page),
                _ => None,
            })
            .collect();
        let mut ids = self.gpu.packed.pages_of(packing, &drawing.order, source, &pages).into_iter();
        for s in 0..slots {
            let id = match drawing.holds(s) {
                Holds::Free => None,
                Holds::Page(_) => ids.next(),
                Holds::Kept(_) => slot_page(&mut self.gpu.packed, packing, drawing, source, s),
            };
            let Some(id) = id else {
                self.words.push(wgsl::NONE);
                self.list(None);
                continue;
            };
            self.list(Some(id));
            let key = PageKey::of(id, packing.words, packing.low);
            let words = if self.gpu.arena.holds(key, wgsl::PAGE_ROWS) {
                Vec::new()
            } else {
                let rows = drawing.rows(s);
                self.gpu.packed.count(rows.len());
                pack(self.gpu, &rows)
            };
            self.push(key, wgsl::PAGE_ROWS, || Content::Computed(words));
        }
    }

    /// A join's table: a bits column holding, for each of the mark's rows, the row of the other
    /// table with the same id. `join` holds those rows for a table paged as its data is. It has
    /// none when every row reads its own, and then the table is empty: no field reads through it.
    fn join(
        &mut self,
        join: Option<&Join>,
        from: &(Name, Name),
        source: &Source<'_>,
        rows: Rows<'_>,
        all: &[Snapshot],
    ) -> [u32; WORDS] {
        self.pages = None;
        let mut d = descriptor(wgsl::BITS);
        d[wgsl::COLUMN_ROWS as usize] = source.table.len() as u32;
        if let Rows::Held(drawing) = rows {
            d[wgsl::COLUMN_ROWS as usize] = drawing.live();
            let Some(other) = joined(from, all) else { return d };
            let field = format!("{}/{}", from.0, from.1).into();
            let packing = Packing {
                reads: stamp_of((source.table.structure, other.structure, other.order)),
                ..packing(drawing, source, &source.table.name, field, Words::Bits)
            };
            self.held_pages(drawing, &packing, None, |_, rows| packed::joined(source.table, rows, other));
            return d;
        }
        let pages = join.and_then(|join| join.rows.as_ref()).map_or(&[][..], |rows| &rows.pages[..]);
        for (id, words) in pages {
            let key = PageKey::of(*id, Words::Bits, false);
            self.push(key, words.len() as u32, || Content::Computed(words.to_vec()));
        }
        d
    }

    /// Appends a word for each page of `column`, a column of an unpaged table, read as `words`.
    fn pages(&mut self, column: &Column, words: Words, low: bool) {
        for (p, page) in column.pages().iter().enumerate() {
            let values = page.values.clone();
            self.page(p, page, words, low, || Content::Values { values, words, low });
        }
    }

    /// A geometry column's table, in the layout `lib/read.wesl` reads: per page, the block of its
    /// row table (each row's first point), where its blocks of points are listed, its point count,
    /// and its row count, followed by those lists. A page's points take as many blocks as they
    /// need.
    fn path(&mut self, column: &Column) {
        let pages = column.pages();
        self.words.resize(wgsl::PATH_PAGE_WORDS as usize * pages.len(), 0);
        for (p, page) in pages.iter().enumerate() {
            self.list(Some(page.id));
            self.path_page(p, page.id, page.values.len() as u32, || page.points(), || path_pieces(&page.values));
        }
    }

    /// A paged table's geometry column: one page of points per slot, cached under `packing`.
    fn held_path(&mut self, column: &Column, drawing: &Drawing, packing: &Packing) {
        self.words.resize(wgsl::PATH_PAGE_WORDS as usize * drawing.slot_count(), 0);
        for s in 0..drawing.slot_count() {
            let Some(id) = slot_page(&mut self.gpu.packed, packing, drawing, Some(column), s) else {
                self.no_path_page(s);
                continue;
            };
            self.list(Some(id));
            let rows = drawing.rows(s);
            let counters = self.gpu.packed.counters();
            let pieces = || {
                counters.add(Count::Packed, rows.len() as u64);
                path_pieces(&column.pick(&rows))
            };
            self.path_page(s, id, rows.len() as u32, || rows_points(column, &rows), pieces);
        }
    }

    /// A paged table's derived shapes, made one page of its order at a time: those of each resident
    /// page, and of its kept rows individually, in pages cached under `packing` by their contents.
    /// A page draws nothing until its shapes are made.
    fn shaped(&mut self, shapes: &PagedShapes, drawing: &Drawing, packing: &Packing) {
        self.words.resize(wgsl::PATH_PAGE_WORDS as usize * drawing.slot_count(), 0);
        let alike = shapes.order == drawing.order.id();
        for s in 0..drawing.slot_count() {
            let page: Option<(PageId, std::borrow::Cow<'_, Values>)> = match drawing.holds(s) {
                Holds::Page(page) if alike => {
                    shapes.pages.get(&page).map(|p| (p.id, std::borrow::Cow::Borrowed(&p.shapes)))
                }
                Holds::Kept(_) if alike => {
                    let places = drawing.places(s);
                    let kept = places.iter().map(|d| Some((shapes.kept.get(d).and_then(Values::geometry)?, 0)));
                    let kept = Values::of_rows(shapes.depth, kept);
                    let packing =
                        Packing { order: stamp_of((packing.order, places, shapes.version)), ..packing.clone() };
                    let id = self.gpu.packed.page(&packing, &drawing.order, None, 0);
                    Some((id, std::borrow::Cow::Owned(kept)))
                }
                _ => None,
            };
            let Some((id, shaped)) = page else {
                self.no_path_page(s);
                continue;
            };
            self.list(Some(id));
            let rows = shaped.len() as u32;
            let counters = self.gpu.packed.counters();
            let pieces = || {
                counters.add(Count::Packed, u64::from(rows));
                path_pieces(&shaped)
            };
            self.path_page(s, id, rows, || shaped.points(), pieces);
        }
    }

    /// Page `p` of a geometry column's table, holding no rows: no row table and no points.
    fn no_path_page(&mut self, p: usize) {
        let per = wgsl::PATH_PAGE_WORDS as usize;
        self.words[per * p..per * (p + 1)].copy_from_slice(&[wgsl::NONE, 0, 0, 0]);
        self.list(None);
    }

    /// Page `p` (`id`, with `rows` rows) of a geometry column's table: its row table, then its
    /// pieces of points, each keyed by its contents, so a rewritten page uploads only the pieces
    /// whose points changed. `pieces` builds them when the GPU lacks one, and `points` counts the
    /// page's points when its pieces are not cached.
    fn path_page(
        &mut self,
        p: usize,
        id: PageId,
        rows: u32,
        points: impl FnOnce() -> usize,
        pieces: impl FnOnce() -> PathPage,
    ) {
        let per = wgsl::PATH_PAGE_WORDS as usize;
        let arena = &self.gpu.arena;
        let known = self.gpu.pieces.of(id);
        let points = known.as_ref().map_or_else(points, |&(_, points)| points);
        self.points += points as u32;
        let kept = known.map(|(keys, _)| keys).filter(|keys| keys.iter().all(|&key| arena.holds(key, 1)));
        let (keys, mut made) = if let Some(keys) = kept {
            (keys, Vec::new())
        } else {
            let PathPage { rows, pieces } = pieces();
            let made: Vec<Vec<u32>> = std::iter::once(rows).chain(pieces).collect();
            let keys: Arc<[PageKey]> = made.iter().map(|words| PageKey::piece(words)).collect();
            self.gpu.pieces.keep(id, keys.clone(), points);
            (keys, made)
        };
        let listed = self.words.len();
        self.words.resize(listed + keys.len() - 1, wgsl::NONE);
        for (piece, &key) in keys.iter().enumerate() {
            let at = if piece == 0 { per * p } else { listed + piece - 1 };
            let words = made.get_mut(piece).map(std::mem::take).unwrap_or_default();
            self.place(at, key, 1, || Content::Computed(words));
        }
        self.words[per * p + 1] = listed as u32;
        self.words[per * p + 2] = points as u32;
        self.words[per * p + 3] = rows;
    }

    /// A direct address plan for the visible trace. The aligned header holds point and row-block
    /// counts, ring capacity, and head. Each block holds one texel per slot: coordinate high/low,
    /// value address, and a word of the rows in that value's page, how many entries the point
    /// reads there, and whether it draws their greatest. Missing points have no address. Page
    /// offsets follow the records; packing resolves cursors after the dataset reserves its pages
    /// together.
    fn trace(&mut self, d: &mut [u32; WORDS], axis: &Samples, blocks: &[(Samples, usize)], window: Window) {
        self.pages = None;
        d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED;
        let plan = plan(axis, window, blocks);
        let points = plan.points as usize;
        let capacity = points.max(1).next_power_of_two();
        self.words.extend([plan.points, blocks.len() as u32, capacity as u32, 0]);
        self.words.resize(4 + 4 * capacity * blocks.len(), wgsl::NONE);
        let mapped: Vec<_> = (0..plan.points).map(|p| plan.point(p)).collect();
        for (i, drawn) in plan.runs.iter().enumerate() {
            let run = &drawn.run;
            let middles = axis.drawn(run);
            let end = plan.runs.get(i + 1).map_or(points, |next| next.first as usize);
            let stored = sides(run.level);
            for (b, (samples, block)) in blocks.iter().enumerate() {
                for side in 0..stored {
                    let pages = samples.pages(*block, run.level, side, run.entries.clone());
                    let sources: Vec<_> = pages
                        .iter()
                        .map(|(page, held)| {
                            let source = self.words.len();
                            let key = PageKey::of(page.id, Words::Values, false);
                            let need = ((held.end - page.first) * u64::from(page.per)) as u32;
                            self.push(key, need, || Content::Frames(page.clone()));
                            source
                        })
                        .collect();
                    let mut page_index = 0;
                    for (point, mapped) in mapped.iter().enumerate().take(end).skip(drawn.first as usize) {
                        // A frame stores one value, which is both its least and its greatest.
                        let Some(p) = mapped.as_ref().filter(|p| p.side.min(stored - 1) == side) else { continue };
                        let first = p.entries.start;
                        while pages.get(page_index).is_some_and(|(_, held)| held.end <= first) {
                            page_index += 1;
                        }
                        let Some((page, held)) = pages.get(page_index).filter(|(_, held)| held.contains(&first)) else {
                            continue;
                        };
                        let x = match p.at {
                            At::Entry(entry) => middles[(entry - run.entries.start) as usize],
                            At::Coordinate(bits) => f64::from_bits(bits),
                        };
                        let hi = x as f32;
                        let count = (p.entries.end.min(held.end) - first) as u32;
                        let greatest = if p.side == 1 { wgsl::TRACE_GREATEST } else { 0 };
                        let at = 4 + 4 * (b * capacity + point);
                        self.words[at..at + 4].copy_from_slice(&[
                            hi.to_bits(),
                            ((x - f64::from(hi)) as f32).to_bits(),
                            wgsl::NONE,
                            page.per | count << wgsl::TRACE_COUNT | greatest,
                        ]);
                        let offset = ((first - page.first) * u64::from(page.per)) as u32;
                        self.cursors.push((at + 2, sources[page_index], offset));
                    }
                }
            }
        }
        self.plan = Some(plan);
    }

    /// A cursor per page of `rows` rows, at `frame` and the frame after it.
    fn cursors(&mut self, samples: &Samples, frame: Option<u64>, rows: usize) {
        for block in 0..rows.div_ceil(wgsl::PAGE_ROWS as usize) {
            let at = self.cursor_words();
            for (k, f) in [frame, frame.map(|f| f + 1)].into_iter().enumerate() {
                let Some((page, base)) = f.and_then(|f| samples.cursor(block, f)) else { continue };
                let key = PageKey::of(page.id, Words::Values, false);
                self.cursor(at, k, key, base, page.per, || Content::Frames(page.clone()));
            }
        }
    }

    /// Appends a cursor's six words, as `lib/read.wesl` reads them: the block and word of the
    /// frame shown, the same for the next frame, and both frames' row counts. Each frame reads
    /// nothing until [`cursor`](Builder::cursor) sets it. Returns where the words start.
    fn cursor_words(&mut self) -> usize {
        let at = self.words.len();
        self.words.extend([wgsl::NONE, 0, wgsl::NONE, 0, 0, 0]);
        at
    }

    /// Sets frame `k` (0 the frame shown, 1 the next) of the cursor at `at` to `rows` rows from
    /// word `base` of page `key`, built by `content` when the arena lacks it.
    fn cursor(&mut self, at: usize, k: usize, key: PageKey, base: u32, rows: u32, content: impl FnOnce() -> Content) {
        self.place(at + 2 * k, key, base + rows, content);
        self.words[at + 2 * k + 1] = base;
        self.words[at + 4 + k] = rows;
    }
}

/// The cache key for the page in slot `s` of `drawing`, for a column packed as `packing`: a page of
/// the order by its number, or a page of kept rows by the places it holds. `None` for a free slot.
fn slot_key(packing: &Packing, drawing: &Drawing, s: usize) -> Option<(Packing, u32)> {
    match drawing.holds(s) {
        Holds::Free => None,
        Holds::Page(page) => Some((packing.clone(), page)),
        Holds::Kept(_) => Some((kept_packing(packing, drawing.kept_places(s)), 0)),
    }
}

/// The cache key for a page of kept rows at `places` of the order, in a column packed as `packing`.
fn kept_packing(packing: &Packing, places: &[u32]) -> Packing {
    Packing { order: stamp_of((packing.order, places)), ..packing.clone() }
}

/// The id of the page of `packing` in slot `s` of `drawing`, packed from `source`: a page of its
/// order, or of its kept rows, each cached until one of its rows is written. `None` if free.
fn slot_page(
    packed: &mut crate::gpu::packed::Packed,
    packing: &Packing,
    drawing: &Drawing,
    source: Option<&Column>,
    s: usize,
) -> Option<PageId> {
    match drawing.holds(s) {
        Holds::Free => None,
        Holds::Page(page) => Some(packed.page(packing, &drawing.order, source, page)),
        Holds::Kept(_) => {
            Some(packed.kept(&kept_packing(packing, drawing.kept_places(s)), source, &|| drawing.rows(s)))
        }
    }
}

/// The points that rows `rows` of geometry column `column` take, as shaders read them.
fn rows_points(column: &Column, rows: &[u32]) -> usize {
    rows.iter()
        .filter_map(|&r| column.at(r as usize))
        .filter(|(values, i)| values.is_valid(*i))
        .map(|(values, i)| values.geometry().map_or(0, |g| g.row_points(i)))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_corners_and_breaks_keep_absolute_entries() {
        let first = 1_u64 << 40;
        for (steps, corners) in [
            (0, vec![(0, 0), (1, 1), (2, 2)]),
            (wgsl::STEP_AFTER, vec![(0, 0), (1, 0), (1, 1), (2, 1), (2, 2)]),
            (wgsl::STEP_BEFORE, vec![(0, 0), (0, 1), (1, 1), (1, 2), (2, 2)]),
        ] {
            let n = corners.len() as u32;
            let frames = Drawn { run: Run { level: 0, entries: first..first + 3 }, first: 0, shape: Shape::Lines };
            let buckets = Drawn { run: Run { level: 1, entries: 100..102 }, first: n + 1, shape: Shape::Lines };
            let plan = Plan { runs: vec![frames, buckets], points: n + 6, steps };
            for (p, (across, value)) in corners.into_iter().enumerate() {
                let point = plan.point(p as u32).expect("a corner");
                assert_eq!(
                    (point.at, point.entries, point.side),
                    (At::Entry(first + across), first + value..first + value + 1, 0)
                );
            }
            assert_eq!(plan.point(n), None, "the point between runs breaks the line");
            // Two buckets draw their least values, a break, then their greatest.
            let drawn: Vec<_> =
                (0..5).map(|k| plan.entries(n + 1 + k).map(|(_, entries, side)| (entries, side))).collect();
            assert_eq!(
                drawn,
                [Some((100..101, 0)), Some((101..102, 0)), None, Some((100..101, 1)), Some((101..102, 1))]
            );
            assert_eq!(plan.point(plan.points), None);
        }
    }

    #[test]
    fn a_trace_reads_every_frame_in_view_once_a_side_within_its_budget() {
        // One row's history of 20,000 frames, one a second.
        let frames = 20_000_usize;
        let at: Vec<f64> = (0..frames).map(|f| f as f64).collect();
        let flow: Vec<f64> = (0..frames).map(|f| ((f * 7919) % 1000) as f64).collect();
        let data = crate::Data::new("d");
        let line = Table::new("Line", crate::Ids::count(1));
        data.apply(crate::Patch::new().axis("time", "s").replace(line).append("Line", at, [("flow", flow)]))
            .expect("valid");
        let data = data.snapshot();
        let Some(Field::Sampled(samples, _)) = data.table("Line").and_then(|t| t.field_named("flow")) else {
            panic!("a sampled field");
        };
        let columns = 256;
        let (mut lines, mut shared) = (false, false);
        // A few frames a column, the whole history, and the whole history on a small budget.
        for (across, most) in
            [(Some([100.0, 164.0]), u64::MAX), (Some([0.0, 4000.0]), u64::MAX), (None, u64::MAX), (None, 512)]
        {
            let plan = plan(samples, Window { across, columns, most, steps: 0 }, &[]);
            let wanted = across.map_or(samples.start()..samples.end(), |across| samples.across(across));
            let read: u64 = plan.runs.iter().map(|drawn| drawn.run.len() as u64).sum();
            assert!(read <= most, "{read} entries of {most}");
            assert!(plan.points <= 4 * columns + 8, "about two points a column at most: {}", plan.points);
            // The runs cover the frames in view, left to right.
            let mut next = wanted.start;
            for drawn in &plan.runs {
                let spanned = drawn.run.frames();
                assert!(spanned.start <= next && next < spanned.end, "frames {next}.. follow, not {spanned:?}");
                next = spanned.end;
            }
            assert!(next >= wanted.end, "the last frame in view is read");
            // Each side's points read their run's entries in order, each entry once, so a column
            // shows the least and greatest of exactly the frames in it.
            for drawn in &plan.runs {
                lines |= drawn.shape == Shape::Lines;
                shared |= matches!(drawn.shape, Shape::Columns(_));
                for side in 0..sides(drawn.run.level) {
                    let mut entry = drawn.run.entries.start;
                    for point in (drawn.first..drawn.first + drawn.points(plan.steps)).filter_map(|p| plan.point(p)) {
                        if point.side == side {
                            assert_eq!(point.entries.start, entry, "no entry is skipped or read twice");
                            assert!(point.entries.end - entry <= u64::from(wgsl::TRACE_MOST));
                            entry = point.entries.end;
                        }
                    }
                    assert_eq!(entry, drawn.run.entries.end, "every entry is read");
                }
            }
        }
        assert!(lines && shared, "frames a column apart draw as lines, and those sharing columns as columns");
    }

    #[test]
    fn direct_trace_cursors_pack_aligned_across_row_pages_steps_and_buckets() {
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        let mut inner = gpu.0.lock();
        for level in [0, 1] {
            let first = 1_u64 << 40;
            let rows = wgsl::PAGE_ROWS as usize + 1;
            let mut samples = Samples::from_frame(first << (3 * level));
            for entries in [first..first + 3, first + 5..first + 7] {
                let run = Run { level, entries };
                let coordinates: Vec<_> = run
                    .entries
                    .clone()
                    .flat_map(|e| {
                        let x = 1e12 + (e - first) as f64 * 0.125;
                        if level == 0 { vec![x] } else { vec![x, x + 0.0625] }
                    })
                    .collect();
                let values: Vec<_> = (0..run.len() * rows * crate::data::sides(level))
                    .map(|i| if i == rows - 1 { f32::NAN } else { i as f32 * 0.25 })
                    .collect();
                samples.insert(&run, &coordinates, &values, rows).unwrap();
            }
            for steps in [0, wgsl::STEP_BEFORE, wgsl::STEP_AFTER] {
                let mut builder = Builder::new(&mut inner, None);
                let mut d = descriptor(0);
                builder.trace(
                    &mut d,
                    &samples,
                    &[(samples.clone(), 0), (samples.clone(), 1)],
                    Window { across: None, columns: 1000, most: u64::MAX, steps },
                );
                let mut table = builder.finish(Stamp::Missing, 0, d);
                let mut values = vec![0; 17];
                for (at, ask) in &table.asks {
                    let Some(Content::Frames(page)) = &ask.content else { panic!("fresh sample page") };
                    table.words[*at] = values.len() as u32;
                    page.read(|v| values.extend(v.iter().map(|v| v.to_bits())));
                }
                let plan = table.plan.clone().unwrap();
                // A preceding odd-sized table exercises both descriptor and body padding.
                let mut prefix = Builder::new(&mut inner, None);
                prefix.words.extend([1, 2, 3]);
                let tables = Tables {
                    current: vec![prefix.finish(Stamp::Missing, 0, descriptor(0)), table],
                    ..Tables::default()
                };
                let mut packed = vec![0; 16];
                tables.pack(16, &mut packed);
                assert_eq!(packed.len(), 16 + tables.len());
                let base = packed[16 + WORDS + wgsl::COLUMN_TABLE as usize] as usize;
                assert_eq!(
                    tables.trace_layout(16),
                    Some([base as u32 + 4, packed[base], packed[base + 1], packed[base + 2], packed[base + 3]])
                );
                assert_eq!(base % 4, 0);
                for row in [0, rows - 1] {
                    for point in 0..plan.points {
                        let at = base
                            + 4
                            + 4 * ((row / wgsl::PAGE_ROWS as usize) * packed[base + 2] as usize + point as usize);
                        let cursor = &packed[at..at + 4];
                        let Some(Point { run, at: At::Entry(across), entries, side }) = plan.point(point) else {
                            assert_eq!(cursor[2], wgsl::NONE);
                            continue;
                        };
                        let level = plan.runs[run].run.level;
                        let x = f64::from(f32::from_bits(cursor[0])) + f64::from(f32::from_bits(cursor[1]));
                        assert_eq!(x, samples.drawn_at(level, across).unwrap());
                        let (_, expected) = samples.read(&Run { level, entries }, &[row]);
                        let value = f32::from_bits(values[cursor[2] as usize + row % wgsl::PAGE_ROWS as usize]);
                        assert!(value == expected[side] || (value.is_nan() && expected[side].is_nan()));
                        assert!(row % (wgsl::PAGE_ROWS as usize) < (cursor[3] & wgsl::TRACE_ROWS) as usize);
                    }
                }
            }
        }
    }

    #[test]
    fn moving_trace_windows_keep_records_through_wrap_and_growth() {
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        let mut inner = gpu.0.lock();
        let rows = wgsl::PAGE_ROWS as usize + 1;
        let coordinates: Vec<_> = (0..64).map(f64::from).collect();
        let values: Vec<_> = (0..64 * rows).map(|i| i as f32).collect();
        let mut samples = Samples::default();
        samples.append(&coordinates, &Values::from(values), rows).unwrap();
        for steps in [0, wgsl::STEP_BEFORE, wgsl::STEP_AFTER] {
            let mut before: Option<ColumnTable> = None;
            let mut previous = Vec::new();
            for (i, across) in
                [[4.0, 27.0], [5.0, 28.0], [13.0, 36.0], [0.0, 10.0], [0.0, 63.0], [50.0, 63.0], [0.0, 8.0]]
                    .into_iter()
                    .enumerate()
            {
                let mut builder = Builder::new(&mut inner, None);
                let mut descriptor = descriptor(0);
                builder.trace(
                    &mut descriptor,
                    &samples,
                    &[(samples.clone(), 0), (samples.clone(), 1)],
                    Window { across: Some(across), columns: 1000, most: u64::MAX, steps },
                );
                let mut table = builder.finish(Stamp::Missing, 0, descriptor);
                if let Some(old) = &before {
                    table.retain_trace(old);
                }
                let mut contents = vec![0; 17];
                for (at, ask) in &table.asks {
                    let Some(Content::Frames(page)) = &ask.content else { panic!("sample page") };
                    table.words[*at] = contents.len() as u32;
                    page.read(|v| contents.extend(v.iter().map(|v| v.to_bits())));
                }
                let mut tables = Tables { current: vec![table], ..Tables::default() };
                let mut packed = Vec::new();
                tables.pack(0, &mut packed);
                let [base, points, blocks, capacity, head] = tables.trace_layout(0).unwrap();
                assert_eq!(blocks, 2);
                let plan = tables.plan().unwrap();
                for row in [0, rows - 1] {
                    for point in 0..points {
                        let at = base as usize
                            + 4 * ((row / wgsl::PAGE_ROWS as usize) * capacity as usize
                                + ((head + point) & (capacity - 1)) as usize);
                        let cursor = &packed[at..at + 4];
                        let Some(Point { run, at: At::Entry(across), entries, side }) = plan.point(point) else {
                            assert_eq!(cursor[2], wgsl::NONE);
                            continue;
                        };
                        let level = plan.runs[run].run.level;
                        let x = f64::from(f32::from_bits(cursor[0])) + f64::from(f32::from_bits(cursor[1]));
                        assert_eq!(x, samples.drawn_at(level, across).unwrap());
                        let (_, expected) = samples.read(&Run { level, entries }, &[row]);
                        let value = f32::from_bits(contents[cursor[2] as usize + row % wgsl::PAGE_ROWS as usize]);
                        assert_eq!(value, expected[side]);
                    }
                }
                if i == 1 {
                    assert_ne!(head, 0, "the window advanced inside its existing allocation");
                    let changed = previous.iter().zip(&packed).filter(|(a, b)| a != b).count();
                    assert!(changed <= 32, "only the new records and header change, not the whole window: {changed}");
                }
                previous = packed;
                before = tables.current.pop();
            }
        }
    }

    #[test]
    fn rows_written_in_another_table_dirty_the_blocks_of_the_rows_reading_them() {
        let page = wgsl::PAGE_ROWS;
        let rows = 2 * page + 10;
        let zeros = |n: u32| vec![0.0_f32; n as usize];
        // The first page of rows names cell 0 and the rows after it cell 1. `Same` lists the rows'
        // ids in their order, and `Reverse` back to front.
        let cells: Vec<u64> = (0..rows).map(|row| u64::from(row >= page)).collect();
        let data = crate::Data::new("d");
        data.apply(
            crate::Patch::new()
                .set(Table::new("Cell", crate::Ids::count(3)).field("v", zeros(3)))
                .set(Table::new("Row", crate::Ids::count(rows)).reference("cell", "Cell", cells))
                .set(Table::new("Same", crate::Ids::count(rows)).field("v", zeros(rows)))
                .set(Table::new("Reverse", (0..u64::from(rows)).rev().collect::<Vec<_>>()).field("v", zeros(rows))),
        )
        .expect("valid");
        let table = |data: &Snapshot, name: &str| data.table(name).expect("the table").clone();
        let values = |table: &Table| match table.field_named("v") {
            Some(Field::Values(values, _)) => values.clone(),
            _ => panic!("a field of values"),
        };
        // The rows of `name` that writing a new value to its rows `ids` changes.
        let wrote = std::cell::Cell::new(0.0_f32);
        let write = |name: &str, ids: Vec<u64>| {
            let before = values(&table(&data.snapshot(), name));
            wrote.set(wrote.get() + 1.0);
            let new = vec![wrote.get(); ids.len()];
            data.apply(Table::new(name, ids).field("v", new)).expect("valid");
            values(&table(&data.snapshot(), name)).written_since(&before)
        };
        let own = table(&data.snapshot(), "Row");
        let reading = |via: &Via<'_>, written: &Runs| readers(via, written, &own, Rows::Own);
        // Through a reference: the rows naming a written row.
        let Some(Field::Reference(reference)) = own.field_named("cell") else { panic!("a reference") };
        let named = Via::Naming(reference.inverse());
        assert_eq!(reading(&named, &write("Cell", vec![0])), Some(vec![0]));
        assert_eq!(reading(&named, &write("Cell", vec![1])), Some(vec![1, 2]));
        assert_eq!(reading(&named, &write("Cell", vec![2])), Some(vec![]), "no row names it");
        assert_eq!(reading(&named, &write("Cell", vec![0, 1])), None, "every row named was written");
        // Through a join: the rows sharing an id with a written row.
        let from: (Name, Name) = ("d".into(), "Same".into());
        let (same, reverse) = (table(&data.snapshot(), "Same"), table(&data.snapshot(), "Reverse"));
        let aligned = Join::of(&from, &own, Some(&same));
        assert!(aligned.rows.is_none(), "tables listing the same ids in the same order need no rows");
        assert_eq!(reading(&Via::Own, &write("Same", vec![3, u64::from(page) + 5])), Some(vec![0, 1]));
        // `Reverse` holds the last row's id first, so its first row is read from the last block.
        let join = Join::of(&from, &own, Some(&reverse));
        let listed = Via::Naming(join.rows.as_ref().expect("rows that read other rows").naming());
        let last = write("Reverse", vec![u64::from(rows) - 1]);
        assert_eq!(reading(&listed, &last), Some(vec![2]));
        assert_eq!(reading(&Via::Ids(&reverse), &last), Some(vec![2]), "by id, as a drawing's rows are found");
        let every = write("Reverse", (0..u64::from(rows)).collect());
        assert_eq!((reading(&listed, &every), reading(&Via::Ids(&reverse), &every)), (None, None));
    }
}
