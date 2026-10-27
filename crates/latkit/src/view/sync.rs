//! A mark's columns on the GPU. Each column the program reads gets a descriptor and a page table of
//! arena offsets. A sampled column instead gets a cursor per page of rows at the shown coordinate.
//!
//! An unpaged table's rows are paged as its data is, and its columns read the data's pages. A paged
//! table's rows are paged by slot, one page of its order per slot. Its columns read pages packed in
//! that order, cached on the GPU by what they were packed from. A reference column to a paged table
//! holds the referenced rows' places in that table's order.
//!
//! A column a line traces holds only what is in view: runs of entries, as raw frames while there
//! are at most two per pixel column, otherwise as buckets of the level of detail that fits. Where
//! the samples lack those, coarser buckets are shown as placeholders, or else the finer ones
//! available. Each level drawn lists its axis pages and, per page of rows, its pages of values.
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

use std::ops::Range;
use std::sync::Arc;

use super::drawing::{Drawing, Holds};
use crate::data::{Column, Field, FramePage, PageId, Run, Samples, Values, Version, detail};
use crate::derive::order::Order;
use crate::derive::shapes::PagedShapes;
use crate::derive::stamp_of;
use crate::derive::{Beside, Derivations};
use crate::expr::compile::{ColumnUse, Program, Reads, Words};
use crate::gpu::Inner;
use crate::gpu::arena::{Ask, Content, PageKey, PathPage, path_pieces};
use crate::gpu::packed::{self, Packing};
use crate::gpu::shaders as wgsl;
use crate::gpu::work::Count;
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

/// What a trace shows: the axis window, the pixel columns it spans, and how a line steps between
/// frames (`STEP_BEFORE`, `STEP_AFTER`, or 0).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Window {
    pub(crate) across: Option<[f64; 2]>,
    pub(crate) columns: u32,
    pub(crate) steps: u32,
}

/// What a traced column draws: runs of entries left to right, each with its first point, the level
/// of detail the window needs, and the total point count.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Plan {
    pub(crate) level: u32,
    pub(crate) runs: Vec<(Run, u32)>,
    pub(crate) points: u32,
    steps: u32,
}

impl Plan {
    /// The entry that point `point` draws: its level, its index, and its side, a bucket's minimum
    /// (0) or maximum (1). `None` for a point that breaks the line.
    pub(crate) fn entry(&self, point: u32) -> Option<(u32, u64, usize)> {
        let i = self.runs.partition_point(|(_, first)| *first <= point).checked_sub(1)?;
        let (run, first) = &self.runs[i];
        let (k, n) = (point - first, run.len() as u32);
        if run.level > 0 {
            return (k < 2 * n).then(|| (run.level, run.entries.start + u64::from(k / 2), (k % 2) as usize));
        }
        let (up, count) = match self.steps {
            wgsl::STEP_AFTER => (k / 2, 2 * n - 1),
            wgsl::STEP_BEFORE => (k.div_ceil(2), 2 * n - 1),
            _ => (k, n),
        };
        (k < count).then(|| (0, run.entries.start + u64::from(up), 0))
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
}

/// One column on the GPU: its descriptor (whose table offsets are relative to `words`), its page
/// table or cursors in `words`, and the pages it reads. Until its dataset reserves them, `asks`
/// lists the pages it needs, each with the word that receives its offset. After that, `pins` lists
/// its pinned pages, and `missing` the words still waiting for an offset.
struct ColumnTable {
    stamp: Stamp,
    /// How it pages its rows: 0 for the data's pages, otherwise the stamp of its drawing's slots.
    held: u64,
    descriptor: [u32; WORDS],
    words: Vec<u32>,
    asks: Vec<(usize, Ask)>,
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
}

impl ColumnTable {
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
    pages: Vec<(PageId, Arc<[u32]>)>,
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
    /// content to upload for it, is discarded and rebuilt later.
    pub(crate) fn reserve(&mut self, gpu: &mut Inner, device: &wgpu::Device, queue: &crate::gpu::work::Queue) -> bool {
        let gone = |table: &ColumnTable| {
            table.asks.iter().any(|(_, a)| a.content.is_none() && !gpu.arena.holds(a.key, a.need))
        };
        for (_, rebuilt) in &mut self.marks {
            rebuilt.tables.retain(|(_, table)| !gone(table));
        }
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

    /// Whether every page each staged table reads is resident, filling in the offsets of those that
    /// arrived.
    pub(crate) fn ready(&mut self, gpu: &Inner) -> bool {
        self.marks.iter_mut().fold(true, |ready, (_, rebuilt)| rebuilt.ready(gpu) && ready)
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
/// whose table changed. Bit `i` of `data` is set for each whose data changed, not only its paging.
/// `blocks` lists the row blocks whose pages changed, or is `None` when every row changed.
pub(crate) struct Published {
    pub(crate) columns: u64,
    pub(crate) data: u64,
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
        let fields = program.columns.iter().map(|column| {
            let join = column.from.as_ref().map_or(wgsl::NONE, |from| {
                (program.columns.len() + joins.iter().position(|j| *j == from).expect("listed")) as u32
            });
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
            // The staged replacement for table `i` if any, else the current table.
            let waiting = staged.and_then(|s| s.tables.iter().find(|(j, _)| *j == i));
            let latest = waiting.map(|(_, t)| t).or(self.current.get(i));
            if !reshape && latest.is_some_and(|t| t.stamp == stamp && t.held == paged) {
                continue;
            }
            let mut builder = Builder::new(gpu);
            let descriptor = match use_ {
                Use::Field { column, join } => {
                    let rows = if column.from.is_none() { rows } else { Rows::Own };
                    let mut descriptor = builder.column(column, source, rows, inputs);
                    descriptor[wgsl::COLUMN_JOIN as usize] = *join;
                    descriptor
                }
                Use::Join(from) => {
                    let join = self.join(from, source, inputs.all);
                    let descriptor = builder.join(&join, from, source, rows, inputs.all);
                    self.remember(join);
                    descriptor
                }
            };
            rebuilt.push((i, builder.finish(stamp, paged, descriptor)));
        }
        (reshape || !rebuilt.is_empty()).then_some(Rebuilt { tables: rebuilt, reshape })
    }

    /// Swaps in the `rebuilt` tables, whose pages are all resident, and unpins the replaced ones.
    /// The replaced table of geometry column `geometry` stays frozen instead, for the mark to ease
    /// from.
    pub(crate) fn publish(&mut self, rebuilt: Rebuilt, program: &Program, geometry: u32, gpu: &mut Inner) -> Published {
        let Rebuilt { tables: rebuilt, reshape } = rebuilt;
        self.generation += 1;
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
            Published { columns: u64::MAX, data: u64::MAX, blocks: None }
        } else {
            let mut published = Published { columns: 0, data: 0, blocks: Some(Vec::new()) };
            for (i, table) in rebuilt {
                match (published.blocks.as_mut(), changed_blocks(&self.current[i], &table)) {
                    (Some(blocks), Some(more)) => blocks.extend(more),
                    _ => published.blocks = None,
                }
                let bits = match program.columns.get(i) {
                    Some(_) => Reads::column(i),
                    None => columns_from(program, joins[i - program.columns.len()]),
                };
                published.columns |= bits;
                if table.stamp != self.current[i].stamp {
                    published.data |= bits;
                }
                let old = std::mem::replace(&mut self.current[i], table);
                if i as u32 == geometry {
                    self.thaw(gpu);
                    self.frozen = Some(old);
                } else {
                    unpin(&old.pins, gpu);
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

    /// Incremented whenever a table is swapped in.
    pub(crate) fn generation(&self) -> u64 {
        self.generation
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

    /// Words the descriptors and tables take in the program buffer.
    pub(crate) fn len(&self) -> usize {
        self.packed().map(|t| WORDS + t.words.len()).sum()
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
        let mut at = base + (self.packed().count() * WORDS) as u32;
        for table in self.packed() {
            let mut d = table.descriptor;
            d[wgsl::COLUMN_TABLE as usize] += at;
            if d[wgsl::COLUMN_LOW as usize] != wgsl::NONE {
                d[wgsl::COLUMN_LOW as usize] += at;
            }
            out.extend(d);
            at += table.words.len() as u32;
        }
        for table in self.packed() {
            out.extend(&table.words);
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

    /// The join rows for `from`, reused while neither table's rows change.
    fn join(&self, from: &(Name, Name), source: &Source<'_>, all: &[Snapshot]) -> Join {
        let Some(other) = joined(from, all) else {
            return Join {
                from: from.clone(),
                structure: (source.table.structure, source.table.structure),
                pages: Vec::new(),
            };
        };
        let structure = (source.table.structure, other.structure);
        if let Some(join) = self.joins.iter().find(|j| &j.from == from && j.structure == structure) {
            return Join { from: from.clone(), structure, pages: join.pages.clone() };
        }
        let rows: Vec<u32> = (0..source.table.len())
            .map(|r| source.table.ids.key(r).and_then(|key| other.row(key)).map_or(wgsl::NONE, |row| row as u32))
            .collect();
        let pages = rows.chunks(wgsl::PAGE_ROWS as usize).map(|chunk| (PageId::next(), Arc::from(chunk))).collect();
        Join { from: from.clone(), structure, pages }
    }

    fn remember(&mut self, join: Join) {
        self.joins.retain(|j| j.from != join.from);
        self.joins.push(join);
    }
}

/// The pages of rows whose page differs between table `before` and table `now`. `None` when either
/// table has no page list (see `ColumnTable::pages`), so every row changed.
fn changed_blocks(before: &ColumnTable, now: &ColumnTable) -> Option<Vec<u32>> {
    let (Some(old), Some(new)) = (&before.pages, &now.pages) else { return None };
    Some((0..old.len().max(new.len())).filter(|&p| old.get(p) != new.get(p)).map(|p| p as u32).collect())
}

fn unpin(pins: &[PageKey], gpu: &mut Inner) {
    for &key in pins {
        gpu.arena.unpin(key);
    }
}

/// The distinct tables the program's joins read, in first-read order.
fn joins(program: &Program) -> Vec<&(Name, Name)> {
    let mut joins: Vec<&(Name, Name)> = Vec::new();
    for from in program.columns.iter().filter_map(|c| c.from.as_ref()) {
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
        .filter(|(_, c)| c.from.as_ref() == Some(from))
        .fold(0, |bits, (i, _)| bits | Reads::column(i))
}

/// The table a join reads.
fn joined<'a>((data, table): &(Name, Name), all: &'a [Snapshot]) -> Option<&'a Table> {
    all.iter().find(|d| d.name() == data)?.table(table)
}

/// What a trace across `window` draws: the runs covering its frames at the level of detail they
/// need, with one point left out between runs that do not meet, which breaks the line.
fn plan(samples: &Samples, window: Window) -> Plan {
    let frames = window.across.map_or(samples.start()..samples.end(), |across| samples.across(across));
    let level = detail(frames.end - frames.start, window.columns);
    let (mut runs, mut point, mut last) = (Vec::new(), 0, None);
    for run in samples.cover(frames, level) {
        let spanned = run.frames();
        if last.is_some_and(|end| end != spanned.start) {
            point += 1;
        }
        let n = run.len() as u32;
        let points = match (run.level, window.steps) {
            (0, 0) => n,
            (0, _) => 2 * n - 1,
            _ => 2 * n,
        };
        last = Some(spanned.end);
        runs.push((run, point));
        point += points;
    }
    Plan { level, runs, points: point, steps: window.steps }
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
        Some(Field::Sampled(samples, version)) if column.trace => Stamp::Trace(*version, plan(samples, inputs.window)),
        Some(Field::Sampled(samples, version)) => {
            let (frame, t) = shown_frame(samples, column, inputs.at);
            Stamp::Sampled(*version, frame, t.to_bits())
        }
        Some(Field::Reference(reference)) => {
            let to = if column.from.is_none() { inputs.order_of(&reference.to).map_or(0, Order::id) } else { 0 };
            Stamp::Field(reference.version, to)
        }
        Some(field) => Stamp::Field(field.version(), 0),
    }
}

/// Builds one column's table, requesting each page it reads.
struct Builder<'g> {
    words: Vec<u32>,
    asks: Vec<(usize, Ask)>,
    plan: Option<Plan>,
    points: u32,
    /// The page each page of rows reads, while every row reads only its own page.
    pages: Option<Vec<Option<PageId>>>,
    gpu: &'g mut Inner,
}

impl<'g> Builder<'g> {
    fn new(gpu: &'g mut Inner) -> Builder<'g> {
        Builder { words: Vec::new(), asks: Vec::new(), plan: None, points: 0, pages: Some(Vec::new()), gpu }
    }

    fn finish(self, stamp: Stamp, held: u64, descriptor: [u32; WORDS]) -> ColumnTable {
        let Builder { words, asks, plan, points, pages, gpu: _ } = self;
        ColumnTable { stamp, held, descriptor, words, asks, pins: Vec::new(), missing: Vec::new(), plan, points, pages }
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
        let mut d = descriptor(if column.words == Words::Bits { wgsl::BITS } else { 0 });
        if let Rows::Held(drawing) = rows
            && let Some(shapes) = source.paged(&column.name).filter(|_| column.derived)
        {
            d[wgsl::COLUMN_ROWS as usize] = drawing.live();
            let packing = packing(drawing, source, &source.table.name, column.name.clone(), Words::Path);
            self.shaped(shapes, drawing, &packing);
            return d;
        }
        let Some((data, table)) = source.table_of(column, inputs.all) else {
            self.pages = None;
            return d;
        };
        d[wgsl::COLUMN_ROWS as usize] = table.len() as u32;
        let field = table.field_named(&column.name);
        if let Rows::Held(drawing) = rows {
            d[wgsl::COLUMN_ROWS as usize] = drawing.live();
            let packing = packing(drawing, source, &table.name, column.name.clone(), column.words);
            self.held(column, data, field, drawing, packing, inputs, &mut d);
            return d;
        }
        match field {
            Some(Field::Values(values, _)) if column.words == Words::Codes => {
                let field = (data, &table.name, &column.name);
                for page in values.pages() {
                    self.list(Some(page.id));
                    let key = PageKey::of(page.id, Words::Codes, false);
                    // Each page is coded once, resident or not, so the dictionary holds its texts.
                    let codes = self.gpu.dictionaries.field(field.0, field.1, field.2).codes(page);
                    self.push(key, page.values.len() as u32, || Content::Computed(codes.to_vec()));
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
                match inputs.order_of(&reference.to).filter(|_| column.from.is_none()) {
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
                let target = inputs.order_of(&reference.to);
                let packing = Packing { reads: target.map_or(0, Order::id), ..packing };
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
    /// table with the same id.
    fn join(
        &mut self,
        join: &Join,
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
        for (id, words) in &join.pages {
            let key = PageKey::of(*id, Words::Bits, false);
            self.push(key, words.len() as u32, || Content::Computed(words.to_vec()));
        }
        d
    }

    fn pages(&mut self, column: &Column, words: Words, low: bool) {
        for page in column.pages() {
            let key = PageKey::of(page.id, words, low);
            let values = page.values.clone();
            self.push(key, values.len() as u32, || Content::Values { values, words, low });
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

    /// What a line draws, in the layout `lib/trace.wesl` reads:
    ///
    /// - a header: the run count, pages of rows, level count, and total points;
    /// - per run: its level's index, first entry, entry count, and first point;
    /// - per level: the level, its axis page count and list offset, and its page lists' start;
    /// - per level and page of rows: the count and list offset of its pages of frames or minimum
    ///   values, then the same for maximum values;
    /// - the lists: axis pages as (offset, first entry), and pages of values as (offset, first
    ///   entry, words per entry).
    ///
    /// Offsets within the table are relative to it. `blocks` gives each page of rows the samples it
    /// reads and its block among them. Descriptor `d` reads it as sampled, across `window`.
    fn trace(&mut self, d: &mut [u32; WORDS], axis: &Samples, blocks: &[(Samples, usize)], window: Window) {
        self.pages = None;
        d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED;
        let plan = plan(axis, window);
        // Each run has its own origin, so runs billions of frames apart still get 32-bit GPU
        // offsets. CPU plans keep absolute 64-bit indexes.
        self.words.extend([plan.runs.len() as u32, blocks.len() as u32, plan.runs.len() as u32, plan.points]);
        let origins: Vec<u64> = plan
            .runs
            .iter()
            .map(|(r, _)| r.entries.start.saturating_sub(crate::data::FRAME_PAGE_WORDS as u64))
            .collect();
        for (i, (run, point)) in plan.runs.iter().enumerate() {
            self.words.extend([i as u32, (run.entries.start - origins[i]) as u32, run.len() as u32, *point]);
        }
        let at = self.words.len();
        self.words.resize(at + 4 * plan.runs.len(), 0);
        for (i, (run, _)) in plan.runs.iter().enumerate() {
            let origin = origins[i];
            let axis_pages = axis.axis_pages(run.level, run.entries.clone());
            let listed_at = self.words.len() as u32;
            self.words[at + 4 * i..at + 4 * i + 3].copy_from_slice(&[run.level, axis_pages.len() as u32, listed_at]);
            for (page, held) in &axis_pages {
                let key = PageKey::of(page.id, Words::Values, false);
                let need = ((held.end - page.first) * 2) as u32;
                self.push(key, need, || Content::Axis(page.clone()));
                self.words.push((page.first - origin) as u32);
            }
            let lists = self.words.len();
            self.words[at + 4 * i + 3] = lists as u32;
            self.words.resize(lists + 4 * blocks.len(), 0);
            for (b, (samples, block)) in blocks.iter().enumerate() {
                for side in 0..crate::data::sides(run.level) {
                    let pages = samples.pages(*block, run.level, side, run.entries.clone());
                    self.words[lists + 4 * b + 2 * side] = pages.len() as u32;
                    self.words[lists + 4 * b + 2 * side + 1] = self.words.len() as u32;
                    self.sample_pages(&pages, origin);
                }
            }
        }
        self.plan = Some(plan);
    }

    /// Appends `pages` as (offset, first entry, words per entry), requesting each page with the
    /// entries it must hold.
    fn sample_pages(&mut self, pages: &[(FramePage, Range<u64>)], origin: u64) {
        for (page, held) in pages {
            let key = PageKey::of(page.id, Words::Values, false);
            let need = ((held.end - page.first) * u64::from(page.per)) as u32;
            self.push(key, need, || Content::Frames(page.clone()));
            self.words.extend([(page.first - origin) as u32, page.per]);
        }
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
            let holds = |row: u32| drawing.held_row(row).is_some_and(|h| (h / wgsl::PAGE_ROWS) as usize == s);
            Some(packed.kept(&kept_packing(packing, drawing.kept_places(s)), source, holds))
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
