//! A mark's columns on the GPU: for every column its program reads, a descriptor and a page table of
//! arena offsets, or for sampled columns a cursor per page of rows at the shown coordinate.
//!
//! A table drawn as it is pages its rows as its data does, and its columns read the data's pages. A
//! table drawn in part pages its rows as its marks hold them, a page of its order in each slot, and
//! its columns read pages packed in that order, kept on the GPU by what they were packed from. A
//! reference names the rows of its table where they draw.
//!
//! A column a line traces holds what is in view instead: runs of entries, frames while there are at
//! most two per pixel column, else the buckets of the level of detail that fit, and where those are
//! not held, the coarser ones standing in or the finer ones there are. Each level it draws lists its
//! axis pages and, per page of rows, its pages of values.
//!
//! Only columns whose inputs changed are rebuilt, once each: moving the shown coordinate rebuilds
//! sampled columns' cursors and nothing else, and a table drawn in part rebuilds only where the pages
//! its marks hold changed. Rebuilt tables are staged with every other mark's of their dataset: the
//! dataset reserves every page they read at once, or none and waits for room, and once every page
//! landed the view swaps them all in, so a data version, and what a camera move draws, appear whole.
//! Staged tables are not built again while they wait, only where what they read changes again. A
//! rebuilt column that lists pages says which pages of rows hold pages that changed, so only their rows
//! evaluate again. While a mark eases, the table its geometry column had when the transition began
//! stays, packed after the rest, so paths morph from it.

use std::ops::Range;
use std::sync::Arc;

use super::drawing::{Drawing, Holds};
use crate::data::{Column, Field, FramePage, GeometryBuilder, PageId, Run, Samples, Values, Version, detail};
use crate::derive::Beside;
use crate::derive::order::Order;
use crate::derive::shapes::PagedShapes;
use crate::derive::stamp_of;
use crate::expr::compile::{ColumnUse, Program, Reads, Words};
use crate::gpu::Inner;
use crate::gpu::arena::{Ask, Content, PageKey, PathPage, path_pieces, path_points};
use crate::gpu::packed::{self, Packing};
use crate::gpu::shaders as wgsl;
use crate::gpu::work::Count;
use crate::{Name, Snapshot, Table};

const WORDS: usize = wgsl::COLUMN_WORDS as usize;

/// What one column's table was built from; a change in it means rebuilding the table.
#[derive(Clone, PartialEq, Debug)]
enum Stamp {
    Missing,
    /// A field, and the order the table a reference of it names draws in.
    Field(Version, u64),
    Sampled(Version, Option<u64>, u32),
    Trace(Version, Plan),
    Join(Version, Version),
}

/// What a trace shows: the window across, the pixel columns it spans, and the steps a line draws
/// between frames (`STEP_BEFORE` or `STEP_AFTER`, or 0).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Window {
    pub(crate) across: Option<[f64; 2]>,
    pub(crate) columns: u32,
    pub(crate) steps: u32,
}

/// What a traced column draws: runs of entries left to right, each with the point it starts at; the
/// level the window asks for; and the points the trace runs through in all.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Plan {
    pub(crate) level: u32,
    pub(crate) runs: Vec<(Run, u32)>,
    pub(crate) points: u32,
    steps: u32,
}

impl Plan {
    /// The entry point `point` draws: its level, its index, and its side, a bucket's least (0) or
    /// greatest (1); `None` for a point that breaks the line.
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

/// How a mark's columns of its own table page its rows: a page of the data at a time, or a page of
/// the order its drawing holds in each slot.
#[derive(Clone, Copy)]
pub(crate) enum Rows<'a> {
    Own,
    Held(&'a Drawing),
}

impl Rows<'_> {
    /// The stamp of how it pages rows: none for the data's own pages.
    fn stamp(self) -> u64 {
        match self {
            Rows::Own => 0,
            Rows::Held(drawing) => drawing.layout(),
        }
    }
}

/// One column on the GPU: its descriptor, whose table offsets are relative to `words`, its page table
/// or cursors, and the pages it reads: until its dataset reserves them, what it asks the arena for,
/// each with the word it lands at; then the pages it pins, and the words still waiting for a page.
struct ColumnTable {
    stamp: Stamp,
    /// How it pages its rows: 0 for the data's pages, else the stamp of the pages held.
    held: u64,
    descriptor: [u32; WORDS],
    words: Vec<u32>,
    asks: Vec<(usize, Ask)>,
    pins: Vec<PageKey>,
    /// Words waiting for a page's offset: the word, the page, and the words it must hold.
    missing: Vec<(usize, PageKey, u32)>,
    /// What a traced column draws.
    plan: Option<Plan>,
    /// At most how many points a geometry column's paths take.
    points: u32,
    /// The page of each page of rows the table lists, for a column whose rows read their own page;
    /// `None` for one whose every row changes when it does (cursors, traces, joins).
    pages: Option<Vec<Option<PageId>>>,
}

impl ColumnTable {
    /// Takes the offsets of the pages it waits for that landed; whether none waits now.
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

/// A mark's tables rebuilt, by index into its current ones; and whether every table was rebuilt,
/// which replaces them all.
pub(crate) struct Rebuilt {
    tables: Vec<(usize, ColumnTable)>,
    reshape: bool,
}

impl Rebuilt {
    /// Lets go of the pages its tables pin.
    fn release(self, gpu: &mut Inner) {
        for (_, table) in self.tables {
            unpin(&table.pins, gpu);
        }
    }

    /// Whether every table holds every page it reads, taking the offsets of those that landed.
    fn ready(&mut self, gpu: &Inner) -> bool {
        let mut ready = true;
        for (_, table) in &mut self.tables {
            ready &= table.asks.is_empty() && table.resolve(gpu);
        }
        ready
    }
}

/// What replaces what a view draws of a dataset: its marks' tables rebuilt since the dataset last
/// published, by mark. They wait until every page they read landed.
#[derive(Default)]
pub(crate) struct Staged {
    marks: Vec<(usize, Rebuilt)>,
}

impl Staged {
    /// Mark `mark`'s tables staged, if any.
    pub(crate) fn of(&self, mark: usize) -> Option<&Rebuilt> {
        self.marks.iter().find(|(m, _)| *m == mark).map(|(_, r)| r)
    }

    /// Stages mark `mark`'s tables `rebuilt`: tables rebuilt again replace those staged, whose pins
    /// go; every table rebuilt replaces them all.
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

    /// Reserves every page the tables staged ask for, all or none: `false` where the arena has no room
    /// for them now. Tables asking for pages the arena no longer holds, which they did not make, are
    /// dropped, to be built again.
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

    /// Whether every table staged holds every page it reads, taking the offsets of those that landed.
    pub(crate) fn ready(&mut self, gpu: &Inner) -> bool {
        self.marks.iter_mut().fold(true, |ready, (_, rebuilt)| rebuilt.ready(gpu) && ready)
    }

    /// Takes mark `mark`'s tables staged, to publish them.
    pub(crate) fn take(&mut self, mark: usize) -> Option<Rebuilt> {
        let at = self.marks.iter().position(|(m, _)| *m == mark)?;
        Some(self.marks.swap_remove(at).1)
    }

    /// Lets go of mark `mark`'s tables staged: it compiled again, or went.
    pub(crate) fn forget(&mut self, mark: usize, gpu: &mut Inner) {
        if let Some(rebuilt) = self.take(mark) {
            rebuilt.release(gpu);
        }
    }

    /// Lets go of every table staged.
    pub(crate) fn release(self, gpu: &mut Inner) {
        for (_, rebuilt) in self.marks {
            rebuilt.release(gpu);
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.marks.is_empty()
    }
}

/// What a mark's program reads, column by column: the program's columns, then one per join.
#[derive(Default)]
pub(crate) struct Tables {
    current: Vec<ColumnTable>,
    /// The geometry column's table before it was last rebuilt, kept while the mark eases from it.
    frozen: Option<ColumnTable>,
    joins: Vec<Join>,
    synced: bool,
    /// The rows of the table last synced, which a program reading no columns follows alone.
    structure: Option<Version>,
    /// Bumps whenever a table is swapped in.
    generation: u64,
}

/// What publishing rebuilt tables changed: bit `i` of `columns` for each program column whose table
/// changed, of `data` for each whose data did, not only where its rows are held; and the row blocks
/// whose pages changed, `None` when every row did.
pub(crate) struct Published {
    pub(crate) columns: u64,
    pub(crate) data: u64,
    pub(crate) blocks: Option<Vec<u32>>,
}

/// Where a mark's own rows come from, the tables the view derives beside them, and drawn in part, the
/// shapes it makes a page of their order at a time, by the field each is written as.
pub(crate) struct Source<'a> {
    pub(crate) data: &'a Snapshot,
    pub(crate) table: &'a Table,
    pub(crate) derived: Beside<'a>,
    pub(crate) paged: Vec<(Name, &'a PagedShapes)>,
}

impl<'a> Source<'a> {
    /// The shapes written as field `name`, made a page of the order drawn at a time.
    fn paged(&self, name: &Name) -> Option<&'a PagedShapes> {
        self.paged.iter().find(|(field, _)| field == name).map(|&(_, shapes)| shapes)
    }
}

/// What a sync reads besides the mark's own rows: every dataset, the coordinate shown, the window a
/// trace spans, and the order each table of its dataset drawn in part draws in.
pub(crate) struct Inputs<'a> {
    pub(crate) all: &'a [Snapshot],
    pub(crate) at: f64,
    pub(crate) window: Window,
    pub(crate) orders: &'a [(Name, Order)],
}

impl Inputs<'_> {
    /// The order table `table` of the mark's dataset draws in, when drawn in part.
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
    /// The tables of what `source` paged as `rows` reads, with what `inputs` reads, whose inputs changed
    /// since `staged`, the tables staged to replace these, or else since the current ones: built once
    /// each, asking for their pages. `None` where none changed.
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
        // Every table rebuilds where they have no tables of this shape yet, but where a reshape is
        // staged already: the tables are compared with it.
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
            // What replaces table `i` once ready, else what draws.
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

    /// Swaps in the tables `rebuilt`, every page they read resident: the current ones' pins go, but
    /// the geometry column's, `geometry`, which stays frozen while the mark eases from it.
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

    /// Drops the frozen geometry table: the mark no longer eases from it.
    pub(crate) fn thaw(&mut self, gpu: &mut Inner) {
        if let Some(table) = self.frozen.take() {
            unpin(&table.pins, gpu);
        }
    }

    /// The program column the frozen geometry table packs as, once there is one.
    pub(crate) fn frozen(&self) -> Option<u32> {
        self.frozen.as_ref().map(|_| self.current.len() as u32)
    }

    /// Bumps whenever a table is swapped in.
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// At most how many points the paths of geometry column `column` take; 0 for other columns.
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

    /// The pages the tables drawn pin.
    pub(crate) fn pins(&self) -> impl Iterator<Item = PageKey> + '_ {
        self.packed().flat_map(|t| t.pins.iter().copied())
    }

    /// Appends every descriptor, then every table; `base` is the word of the program buffer the
    /// first descriptor lands at, so table offsets are absolute.
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

    /// Releases every pin.
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

/// The pages of rows whose pages differ between table `before` and table `now`; `None` when either
/// reads no page alone, so every row changed.
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

/// The dataset and table a column reads: the mark's own, another one joined by id, or the derived
/// table beside the mark's own that holds the field.
pub(crate) fn table_of<'a>(
    column: &ColumnUse,
    source: &Source<'a>,
    all: &'a [Snapshot],
) -> Option<(&'a Name, &'a Table)> {
    if column.derived {
        let mut beside = source.derived.iter().flatten();
        let table = beside.find(|t| t.field_named(&column.name).is_some()).copied().or(source.derived[0])?;
        return Some((source.data.name(), table));
    }
    match &column.from {
        None => Some((source.data.name(), source.table)),
        Some((data, table)) => {
            let data = all.iter().find(|d| d.name() == data)?;
            Some((data.name(), data.table(table)?))
        }
    }
}

/// The table a join reads.
fn joined<'a>((data, table): &(Name, Name), all: &'a [Snapshot]) -> Option<&'a Table> {
    all.iter().find(|d| d.name() == data)?.table(table)
}

/// What a trace across `window` draws: the runs covering its frames at the level they ask for, a
/// point left out between runs that do not meet.
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

fn stamp(column: &ColumnUse, source: &Source<'_>, inputs: &Inputs<'_>) -> Stamp {
    if let Some(shapes) = source.paged(&column.name).filter(|_| column.derived) {
        return Stamp::Field(shapes.version, shapes.order);
    }
    let Some((_, table)) = table_of(column, source, inputs.all) else { return Stamp::Missing };
    match table.field_named(&column.name) {
        None => Stamp::Missing,
        Some(Field::Sampled(samples, version)) if column.trace => Stamp::Trace(*version, plan(samples, inputs.window)),
        Some(Field::Sampled(samples, version)) => {
            let frame = samples.frame_at(inputs.at);
            let t = if column.step { 0.0 } else { frame.map_or(0.0, |f| samples.t(f, inputs.at)) };
            Stamp::Sampled(*version, frame, t.to_bits())
        }
        Some(Field::Reference(reference)) => {
            let to = if column.from.is_none() { inputs.order_of(&reference.to).map_or(0, Order::id) } else { 0 };
            Stamp::Field(reference.version, to)
        }
        Some(field) => Stamp::Field(field.version(), 0),
    }
}

/// Builds one column's table, asking for each page it reads.
struct Builder<'g> {
    words: Vec<u32>,
    asks: Vec<(usize, Ask)>,
    plan: Option<Plan>,
    points: u32,
    /// The page of each page of rows, while every row reads its own page's.
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

    /// Asks for page `key`, holding `need` words, to land at word `at` once it does; until then
    /// `NONE`, and the table waits for it. `content` makes what it uploads, where the arena lacks it.
    fn place(&mut self, at: usize, key: PageKey, need: u32, content: impl FnOnce() -> Content) {
        let content = (!self.gpu.arena.holds(key, need)).then(content);
        self.asks.push((at, Ask { key, need, content }));
        self.words[at] = wgsl::NONE;
    }

    /// Appends where page `key` lies, as [`place`](Builder::place) writes it.
    fn push(&mut self, key: PageKey, need: u32, content: impl FnOnce() -> Content) {
        self.words.push(wgsl::NONE);
        let at = self.words.len() - 1;
        self.place(at, key, need, content);
    }

    /// Lists page `page` as the one a page of rows reads.
    fn list(&mut self, page: Option<PageId>) {
        if let Some(pages) = &mut self.pages {
            pages.push(page);
        }
    }

    fn column(&mut self, column: &ColumnUse, source: &Source<'_>, rows: Rows<'_>, inputs: &Inputs<'_>) -> [u32; WORDS] {
        let mut d = [0; WORDS];
        d[wgsl::COLUMN_LOW as usize] = wgsl::NONE;
        if column.words == Words::Bits {
            d[wgsl::COLUMN_FLAGS as usize] = wgsl::BITS;
        }
        if let Rows::Held(drawing) = rows
            && let Some(shapes) = source.paged(&column.name).filter(|_| column.derived)
        {
            d[wgsl::COLUMN_ROWS as usize] = drawing.live();
            let packing = Packing {
                order: drawing.order.id(),
                origin: source.data.origin(),
                table: source.table.name.clone(),
                field: column.name.clone(),
                words: Words::Path,
                low: false,
                reads: 0,
            };
            self.shaped(shapes, drawing, &packing);
            return d;
        }
        let Some((data, table)) = table_of(column, source, inputs.all) else {
            self.pages = None;
            return d;
        };
        d[wgsl::COLUMN_ROWS as usize] = table.len() as u32;
        let field = table.field_named(&column.name);
        if let Rows::Held(drawing) = rows {
            d[wgsl::COLUMN_ROWS as usize] = drawing.live();
            let packing = Packing {
                order: drawing.order.id(),
                origin: source.data.origin(),
                table: table.name.clone(),
                field: column.name.clone(),
                words: column.words,
                low: false,
                reads: 0,
            };
            self.held(column, data, field, drawing, packing, inputs, &mut d);
            return d;
        }
        match field {
            Some(Field::Values(values, _)) if column.words == Words::Codes => {
                let field = (data, &table.name, &column.name);
                for page in values.pages() {
                    self.list(Some(page.id));
                    let key = PageKey::of(page.id, Words::Codes, false);
                    // Coded once, whether or not the page is on the GPU, so the dictionary holds its texts.
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
                    // The rows it names where their table draws them.
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
                self.pages = None;
                d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED;
                let blocks: Vec<(Samples, usize)> =
                    (0..table.len().div_ceil(wgsl::PAGE_ROWS as usize)).map(|b| (samples.clone(), b)).collect();
                self.trace(samples, &blocks, plan(samples, inputs.window));
            }
            Some(Field::Sampled(samples, _)) => {
                self.pages = None;
                d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED | if column.step { wgsl::STEP } else { 0 };
                let frame = samples.frame_at(inputs.at);
                let t = if column.step { 0.0 } else { frame.map_or(0.0, |f| samples.t(f, inputs.at)) };
                d[wgsl::COLUMN_T as usize] = t.to_bits();
                self.cursors(samples, frame, table.len());
            }
            None => self.pages = None,
        }
        d
    }

    /// A column of a table drawn in part: a page packed in its order for each page its drawing holds,
    /// as `packing` keeps them.
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
                self.pages = None;
                d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED;
                let packing = Packing { reads: stamp_of(version), ..packing };
                let blocks: Vec<(Samples, usize)> = (0..slots)
                    .map(|s| match slot_key(&packing, drawing, s) {
                        None => (Samples::default(), 0),
                        Some((packing, page)) => {
                            (self.gpu.packed.samples(&packing, page, &drawing.rows(s), samples), 0)
                        }
                    })
                    .collect();
                self.trace(samples, &blocks, plan(samples, inputs.window));
            }
            Some(Field::Sampled(samples, version)) => {
                self.pages = None;
                d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED | if column.step { wgsl::STEP } else { 0 };
                let frame = samples.frame_at(inputs.at);
                let t = if column.step { 0.0 } else { frame.map_or(0.0, |f| samples.t(f, inputs.at)) };
                d[wgsl::COLUMN_T as usize] = t.to_bits();
                // Six words a page: this frame's block and word, the next frame's, and their rows.
                for s in 0..slots {
                    let at = self.words.len();
                    self.words.extend([wgsl::NONE, 0, wgsl::NONE, 0, 0, 0]);
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
                        self.place(at + 2 * k, key, wgsl::PAGE_ROWS, content);
                        self.words[at + 4 + k] = wgsl::PAGE_ROWS;
                    }
                }
            }
            None => self.pages = None,
        }
    }

    /// Appends the page of `packing` each slot of `drawing` holds, packed from `source`, made by `pack`
    /// from its rows the first time; nothing for a free slot. The pages of the order are found in one
    /// look at the column, each page of rows kept on its own.
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

    /// A join's table: a bits column of the mark's rows, the rows of the other table with their ids.
    fn join(
        &mut self,
        join: &Join,
        from: &(Name, Name),
        source: &Source<'_>,
        rows: Rows<'_>,
        all: &[Snapshot],
    ) -> [u32; WORDS] {
        self.pages = None;
        let mut d = [0; WORDS];
        d[wgsl::COLUMN_FLAGS as usize] = wgsl::BITS;
        d[wgsl::COLUMN_ROWS as usize] = source.table.len() as u32;
        d[wgsl::COLUMN_LOW as usize] = wgsl::NONE;
        d[wgsl::COLUMN_JOIN as usize] = wgsl::NONE;
        if let Rows::Held(drawing) = rows {
            d[wgsl::COLUMN_ROWS as usize] = drawing.live();
            let Some(other) = joined(from, all) else { return d };
            let packing = Packing {
                order: drawing.order.id(),
                origin: source.data.origin(),
                table: source.table.name.clone(),
                field: format!("{}/{}", from.0, from.1).into(),
                words: Words::Bits,
                low: false,
                reads: stamp_of((source.table.structure, other.structure, other.order)),
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

    /// A geometry column's table, as `lib/read.wesl` reads it: per page, the block of each row's
    /// first point, where the page's blocks of points are listed in the table, how many points it
    /// has, and how many rows; then those lists. A page's points take as many blocks of a chunk as
    /// they need.
    fn path(&mut self, column: &Column) {
        let pages = column.pages();
        self.words.resize(wgsl::PATH_PAGE_WORDS as usize * pages.len(), 0);
        for (p, page) in pages.iter().enumerate() {
            self.list(Some(page.id));
            let points = path_points(&page.values);
            self.path_page(p, page.id, points, page.values.len() as u32, || path_pieces(&page.values));
        }
    }

    /// The geometry column of a table drawn in part: a page of its points per page its drawing holds,
    /// as `packing` keeps them.
    fn held_path(&mut self, column: &Column, drawing: &Drawing, packing: &Packing) {
        let per = wgsl::PATH_PAGE_WORDS as usize;
        self.words.resize(per * drawing.slot_count(), 0);
        for s in 0..drawing.slot_count() {
            let Some(id) = slot_page(&mut self.gpu.packed, packing, drawing, Some(column), s) else {
                self.words[per * s..per * (s + 1)].copy_from_slice(&[wgsl::NONE, 0, 0, 0]);
                self.list(None);
                continue;
            };
            self.list(Some(id));
            let rows = drawing.rows(s);
            let points = rows_points(column, &rows);
            let counters = self.gpu.packed.counters();
            let pieces = || {
                counters.add(Count::Packed, rows.len() as u64);
                path_pieces(&column.pick(&rows))
            };
            self.path_page(s, id, points, rows.len() as u32, pieces);
        }
    }

    /// The shapes of a table drawn in part, made a page of its order at a time: those of each page its
    /// drawing holds, and of its rows kept, a row at a time, in pages `packing` keeps by what they
    /// hold. A page not shaped yet draws nothing until it is.
    fn shaped(&mut self, shapes: &PagedShapes, drawing: &Drawing, packing: &Packing) {
        let per = wgsl::PATH_PAGE_WORDS as usize;
        self.words.resize(per * drawing.slot_count(), 0);
        let alike = shapes.order == drawing.order.id();
        for s in 0..drawing.slot_count() {
            let page: Option<(PageId, std::borrow::Cow<'_, Values>)> = match drawing.holds(s) {
                Holds::Page(page) if alike => {
                    shapes.pages.get(&page).map(|p| (p.id, std::borrow::Cow::Borrowed(&p.shapes)))
                }
                Holds::Kept(_) if alike => {
                    let places = drawing.places(s);
                    let mut kept = GeometryBuilder::new(shapes.depth);
                    for d in &places {
                        match shapes.kept.get(d).and_then(Values::geometry) {
                            Some(shape) => kept.push_from(shape, 0),
                            None => kept.push_empty(),
                        }
                    }
                    let packing =
                        Packing { order: stamp_of((packing.order, places, shapes.version)), ..packing.clone() };
                    let id = self.gpu.packed.page(&packing, &drawing.order, None, 0);
                    Some((id, std::borrow::Cow::Owned(Values::of_geometry(kept.finish()))))
                }
                _ => None,
            };
            let Some((id, shaped)) = page else {
                self.words[per * s..per * (s + 1)].copy_from_slice(&[wgsl::NONE, 0, 0, 0]);
                self.list(None);
                continue;
            };
            self.list(Some(id));
            let rows = shaped.len() as u32;
            let counters = self.gpu.packed.counters();
            let points = path_points(&shaped);
            let pieces = || {
                counters.add(Count::Packed, u64::from(rows));
                path_pieces(&shaped)
            };
            self.path_page(s, id, points, rows, pieces);
        }
    }

    /// Page `p` of a geometry column's table, `id`, of `points` points and `rows` rows: its rows'
    /// table, then its pieces of points, each keyed by what it holds, so a page written again uploads
    /// only the pieces whose rows' points changed. `pieces` makes them where the GPU lacks one.
    fn path_page(&mut self, p: usize, id: PageId, points: usize, rows: u32, pieces: impl FnOnce() -> PathPage) {
        let per = wgsl::PATH_PAGE_WORDS as usize;
        self.points += points as u32;
        let arena = &self.gpu.arena;
        let kept = self.gpu.pieces.of(id).filter(|keys| keys.iter().all(|&key| arena.holds(key, 1)));
        let (keys, mut made) = if let Some(keys) = kept {
            (keys, Vec::new())
        } else {
            let PathPage { rows, pieces } = pieces();
            let made: Vec<Vec<u32>> = std::iter::once(rows).chain(pieces).collect();
            let keys: Arc<[PageKey]> = made.iter().map(|words| PageKey::piece(words)).collect();
            self.gpu.pieces.keep(id, keys.clone());
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

    /// What a line draws, laid out as `lib/trace.wesl` reads it: a header (how many runs, pages of
    /// rows, and levels, and the points in all); per run its level's place, first entry, entries,
    /// and first point; per level the level, how many axis pages and where they are listed, and
    /// where its pages' lists start; per level and page of rows how many pages of frames or least
    /// values and where they are listed, then of greatest values; then those lists, axis pages as
    /// (offset, first entry) and pages of values as (offset, first entry, words per entry). Offsets
    /// within the table are relative to it. `blocks` are the samples each page of rows reads, and its
    /// block among theirs.
    fn trace(&mut self, axis: &Samples, blocks: &[(Samples, usize)], plan: Plan) {
        // Each run has its own local origin. Even sparse runs billions of frames apart use
        // compact GPU offsets, while CPU plans retain their absolute 64-bit indexes.
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

    /// Appends `pages` as (offset, first entry, words per entry), each with the entries it holds.
    fn sample_pages(&mut self, pages: &[(FramePage, Range<u64>)], origin: u64) {
        for (page, held) in pages {
            let key = PageKey::of(page.id, Words::Values, false);
            let need = ((held.end - page.first) * u64::from(page.per)) as u32;
            self.push(key, need, || Content::Frames(page.clone()));
            self.words.extend([(page.first - origin) as u32, page.per]);
        }
    }

    /// Six words per page of rows: this frame's block and word, the next frame's, and their row
    /// counts.
    fn cursors(&mut self, samples: &Samples, frame: Option<u64>, rows: usize) {
        for block in 0..rows.div_ceil(wgsl::PAGE_ROWS as usize) {
            let at = self.words.len();
            self.words.extend([wgsl::NONE, 0, wgsl::NONE, 0, 0, 0]);
            for (i, f) in [frame, frame.map(|f| f + 1)].into_iter().enumerate() {
                let Some((page, base)) = f.and_then(|f| samples.cursor(block, f)) else { continue };
                let key = PageKey::of(page.id, Words::Values, false);
                let rows_in_page = page.per;
                self.place(at + 2 * i, key, base + rows_in_page, || Content::Frames(page.clone()));
                self.words[at + 2 * i + 1] = base;
                self.words[at + 4 + i] = rows_in_page;
            }
        }
    }
}

/// How the registry keeps the page slot `s` of `drawing` holds of a column packed as `packing`: a page
/// of the order by its number, a page of rows kept by the places it holds. `None` for a free slot.
fn slot_key(packing: &Packing, drawing: &Drawing, s: usize) -> Option<(Packing, u32)> {
    match drawing.holds(s) {
        Holds::Free => None,
        Holds::Page(page) => Some((packing.clone(), page)),
        Holds::Kept(_) => Some((kept_packing(packing, drawing.kept_places(s)), 0)),
    }
}

/// How the registry keeps a page of rows kept, at `places` of the order, of a column packed as
/// `packing`.
fn kept_packing(packing: &Packing, places: &[u32]) -> Packing {
    Packing { order: stamp_of((packing.order, places)), ..packing.clone() }
}

/// The id of the page of `packing` slot `s` of `drawing` holds, packed from `source`: a page of its
/// order, or of its rows kept, each kept while none of its rows was written since; `None` for a free
/// slot.
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

/// Points rows `rows` of geometry column `column` take as shaders read them.
fn rows_points(column: &Column, rows: &[u32]) -> usize {
    rows.iter()
        .filter_map(|&r| column.at(r as usize))
        .filter(|(values, i)| values.is_valid(*i))
        .map(|(values, i)| values.geometry().map_or(0, |g| g.row_points(i)))
        .sum()
}
