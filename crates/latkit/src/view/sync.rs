//! A mark's columns on the GPU: for every column its program reads, a descriptor and a page table of
//! arena offsets, or for sampled columns a cursor per row block at the shown coordinate.
//!
//! A column a line traces holds what is in view instead: runs of entries, frames while there are at
//! most two per pixel column, else the buckets of the level of detail that fit, and where those are
//! not held, the coarser ones standing in or the finer ones there are. Each level it draws lists its
//! axis pages and, per row block, its pages of values.
//!
//! Only columns whose inputs changed are rebuilt: moving the shown coordinate rebuilds sampled
//! columns' cursors and nothing else. A rebuilt column that lists pages says which row blocks hold
//! pages that changed, so only their rows evaluate again. A mark keeps drawing its current tables until every page of
//! its rebuilt ones is resident, then swaps them in together, so a data version appears whole.
//! Tables pin the pages they reference. While a mark eases, the table its geometry column had when
//! the transition began stays, packed after the rest, so paths morph from it.

use std::ops::Range;
use std::sync::Arc;

use crate::data::{Column, Field, FramePage, PAGE_ROWS, PageId, Run, Samples, Version, detail};
use crate::derive::Beside;
use crate::expr::compile::{ColumnUse, Program, Reads, Words};
use crate::gpu::Inner;
use crate::gpu::arena::{Content, PIECE_POINTS, PageKey, path_pieces, path_points};
use crate::gpu::shaders as wgsl;
use crate::{Data, Name, Table};

const WORDS: usize = wgsl::COLUMN_WORDS as usize;

/// What one column's table was built from; a change in it means rebuilding the table.
#[derive(Clone, PartialEq, Debug)]
enum Stamp {
    Missing,
    Field(Version),
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

/// One column on the GPU: its descriptor, whose table offsets are relative to `words`, its page table
/// or cursors, and the pages it pins.
struct ColumnTable {
    stamp: Stamp,
    descriptor: [u32; WORDS],
    words: Vec<u32>,
    pins: Vec<PageKey>,
    /// What a traced column draws.
    plan: Option<Plan>,
    /// At most how many points a geometry column's paths take.
    points: u32,
    /// The page of each row block the table lists, for a column whose rows read their own block's
    /// page; `None` for one whose every row changes when it does (cursors, traces, joins).
    pages: Option<Vec<PageId>>,
}

/// Rows of the mark's table joined by id to rows of another table.
struct Join {
    of: (Name, Name),
    structure: (Version, Version),
    pages: Vec<(PageId, Arc<[u32]>)>,
}

/// What a mark's program reads, column by column: the program's columns, then one per join.
#[derive(Default)]
pub(crate) struct Tables {
    current: Vec<ColumnTable>,
    /// Rebuilt tables waiting for their pages, by index into `current`.
    pending: Vec<(usize, ColumnTable)>,
    /// The geometry column's table before it was last rebuilt, kept while the mark eases from it.
    frozen: Option<ColumnTable>,
    joins: Vec<Join>,
    synced: bool,
    /// The rows of the table last synced, which a program reading no columns follows alone.
    structure: Option<crate::data::Version>,
    /// Bumps whenever a table is swapped in.
    generation: u64,
}

/// What a sync did.
pub(crate) enum Synced {
    /// Nothing changed.
    Same,
    /// Pages are uploading; the current tables still draw.
    Waiting,
    /// New tables: bit `i` of `columns` for each program column that changed, and the row blocks
    /// whose pages changed; `None` when every row did.
    Changed { columns: u64, blocks: Option<Vec<u32>> },
}

/// Where a mark's own rows come from, and the tables the view derives beside them.
pub(crate) struct Source<'a> {
    pub(crate) data: &'a Data,
    pub(crate) table: &'a Table,
    pub(crate) derived: Beside<'a>,
}

/// One column a program reads: a field, or the rows a join maps to.
enum Use<'a> {
    Field { column: &'a ColumnUse, join: u32 },
    Join(&'a (Name, Name)),
}

impl Tables {
    /// Brings the tables up to date with `source` and every dataset in `all` at coordinate `at`;
    /// traced columns hold the frames across `window`, or every frame without one. When column
    /// `geometry` is rebuilt, its table before stays frozen until [`thaw`](Tables::thaw).
    #[allow(clippy::too_many_arguments, reason = "one sync of a mark's tables")]
    pub(crate) fn sync(
        &mut self,
        program: &Program,
        source: &Source<'_>,
        all: &[Data],
        at: f64,
        window: Window,
        geometry: u32,
        gpu: &mut Inner,
    ) -> Synced {
        let joins = joins(program);
        let fields = program.columns.iter().map(|column| {
            let join = column.of.as_ref().map_or(wgsl::NONE, |of| {
                (program.columns.len() + joins.iter().position(|j| *j == of).expect("listed")) as u32
            });
            Use::Field { column, join }
        });
        let uses: Vec<Use<'_>> = fields.chain(joins.iter().map(|of| Use::Join(of))).collect();
        let reshape = !self.synced
            || self.current.len() != uses.len()
            || (uses.is_empty() && self.structure != Some(source.table.structure));
        self.structure = Some(source.table.structure);
        let mut rebuilt = Vec::new();
        let mut ready = true;
        for (i, use_) in uses.iter().enumerate() {
            let stamp = match use_ {
                Use::Field { column, .. } => stamp(column, source, all, at, window),
                Use::Join(of) => match joined(of, all) {
                    Some(other) => Stamp::Join(source.table.structure, other.structure),
                    None => Stamp::Missing,
                },
            };
            if !reshape && self.current[i].stamp == stamp {
                continue;
            }
            let mut builder = Builder {
                words: Vec::new(),
                pins: Vec::new(),
                ready: true,
                plan: None,
                points: 0,
                pages: Some(Vec::new()),
                gpu: &mut *gpu,
            };
            let descriptor = match use_ {
                Use::Field { column, join } => {
                    let mut descriptor = builder.column(column, source, all, at, window);
                    descriptor[wgsl::COLUMN_JOIN as usize] = *join;
                    descriptor
                }
                Use::Join(of) => {
                    let join = self.join(of, source, all);
                    let descriptor = builder.join(&join, source.table.len());
                    self.remember(join);
                    descriptor
                }
            };
            let Builder { words, pins, ready: column_ready, plan, points, pages, gpu: _ } = builder;
            for &key in &pins {
                gpu.arena.pin(key);
            }
            ready &= column_ready;
            rebuilt.push((i, ColumnTable { stamp, descriptor, words, pins, plan, points, pages }));
        }
        for (_, table) in std::mem::take(&mut self.pending) {
            unpin(&table.pins, gpu);
        }
        if rebuilt.is_empty() && !reshape {
            return Synced::Same;
        }
        if !ready {
            self.pending = rebuilt;
            return Synced::Waiting;
        }
        self.generation += 1;
        let mut blocks = Some(Vec::new());
        let changed = if reshape {
            self.thaw(gpu);
            for table in std::mem::take(&mut self.current) {
                unpin(&table.pins, gpu);
            }
            self.current = rebuilt.into_iter().map(|(_, table)| table).collect();
            blocks = None;
            u64::MAX
        } else {
            let mut changed = 0;
            for (i, table) in rebuilt {
                match (blocks.as_mut(), changed_blocks(&self.current[i], &table)) {
                    (Some(blocks), Some(more)) => blocks.extend(more),
                    _ => blocks = None,
                }
                let old = std::mem::replace(&mut self.current[i], table);
                if i as u32 == geometry {
                    self.thaw(gpu);
                    self.frozen = Some(old);
                } else {
                    unpin(&old.pins, gpu);
                }
                changed |= match &uses[i] {
                    Use::Field { .. } => Reads::column(i),
                    Use::Join(of) => columns_of(program, of),
                };
            }
            changed
        };
        self.synced = true;
        Synced::Changed { columns: changed, blocks }
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

    /// Whether rebuilt tables wait for pages to upload.
    pub(crate) fn waiting(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Words the descriptors and tables take in the program buffer.
    pub(crate) fn len(&self) -> usize {
        self.packed().map(|t| WORDS + t.words.len()).sum()
    }

    /// The tables packed: the current ones, then the frozen geometry table.
    fn packed(&self) -> impl Iterator<Item = &ColumnTable> + Clone {
        self.current.iter().chain(&self.frozen)
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
        for table in self.current.drain(..).chain(self.pending.drain(..).map(|(_, t)| t)) {
            unpin(&table.pins, gpu);
        }
        self.synced = false;
    }

    /// The join rows for `of`, reused while neither table's rows change.
    fn join(&self, of: &(Name, Name), source: &Source<'_>, all: &[Data]) -> Join {
        let Some(other) = joined(of, all) else {
            return Join {
                of: of.clone(),
                structure: (source.table.structure, source.table.structure),
                pages: Vec::new(),
            };
        };
        let structure = (source.table.structure, other.structure);
        if let Some(join) = self.joins.iter().find(|j| &j.of == of && j.structure == structure) {
            return Join { of: of.clone(), structure, pages: join.pages.clone() };
        }
        let rows: Vec<u32> = (0..source.table.len())
            .map(|r| source.table.ids.key(r).and_then(|key| other.row(key)).map_or(wgsl::NONE, |row| row as u32))
            .collect();
        let pages = rows.chunks(PAGE_ROWS).map(|chunk| (PageId::next(), Arc::from(chunk))).collect();
        Join { of: of.clone(), structure, pages }
    }

    fn remember(&mut self, join: Join) {
        self.joins.retain(|j| j.of != join.of);
        self.joins.push(join);
    }
}

/// The row blocks whose pages differ between table `before` and table `now`; `None` when either reads
/// no block's page alone, so every row changed.
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
    for of in program.columns.iter().filter_map(|c| c.of.as_ref()) {
        if !joins.contains(&of) {
            joins.push(of);
        }
    }
    joins
}

/// Bits of the program's columns that read through the join to `of`.
fn columns_of(program: &Program, of: &(Name, Name)) -> u64 {
    program
        .columns
        .iter()
        .enumerate()
        .filter(|(_, c)| c.of.as_ref() == Some(of))
        .fold(0, |bits, (i, _)| bits | Reads::column(i))
}

/// The dataset and table a column reads: the mark's own, another one joined by id, or the derived
/// table beside the mark's own that holds the field.
pub(crate) fn table_of<'a>(column: &ColumnUse, source: &Source<'a>, all: &'a [Data]) -> Option<(&'a Name, &'a Table)> {
    if column.derived {
        let mut beside = source.derived.iter().flatten();
        let table = beside.find(|t| t.field_named(&column.name).is_some()).copied().or(source.derived[0])?;
        return Some((source.data.name(), table));
    }
    match &column.of {
        None => Some((source.data.name(), source.table)),
        Some((data, table)) => {
            let data = all.iter().find(|d| d.name() == data)?;
            Some((data.name(), data.table(table)?))
        }
    }
}

/// The table a join reads.
fn joined<'a>((data, table): &(Name, Name), all: &'a [Data]) -> Option<&'a Table> {
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

fn stamp(column: &ColumnUse, source: &Source<'_>, all: &[Data], at: f64, window: Window) -> Stamp {
    let Some((_, table)) = table_of(column, source, all) else { return Stamp::Missing };
    match table.field_named(&column.name) {
        None => Stamp::Missing,
        Some(Field::Sampled(samples, version)) if column.trace => Stamp::Trace(*version, plan(samples, window)),
        Some(Field::Sampled(samples, version)) => {
            let frame = samples.frame_at(at);
            let t = if column.step { 0.0 } else { frame.map_or(0.0, |f| samples.t(f, at)) };
            Stamp::Sampled(*version, frame, t.to_bits())
        }
        Some(field) => Stamp::Field(field.version()),
    }
}

/// Builds one column's table, asking the arena for each page.
struct Builder<'g> {
    words: Vec<u32>,
    pins: Vec<PageKey>,
    ready: bool,
    plan: Option<Plan>,
    points: u32,
    /// The page of each row block, while every row reads its own block's.
    pages: Option<Vec<PageId>>,
    gpu: &'g mut Inner,
}

impl Builder<'_> {
    fn column(
        &mut self,
        column: &ColumnUse,
        source: &Source<'_>,
        all: &[Data],
        at: f64,
        window: Window,
    ) -> [u32; WORDS] {
        let mut d = [0; WORDS];
        d[wgsl::COLUMN_LOW as usize] = wgsl::NONE;
        if column.words == Words::Bits {
            d[wgsl::COLUMN_FLAGS as usize] = wgsl::BITS;
        }
        let Some((data, table)) = table_of(column, source, all) else {
            self.pages = None;
            return d;
        };
        d[wgsl::COLUMN_ROWS as usize] = table.len() as u32;
        match table.field_named(&column.name) {
            Some(Field::Values(values, _)) if column.words == Words::Codes => {
                let field = (data, &table.name, &column.name);
                self.listed(values);
                for page in values.pages() {
                    let key = PageKey::of(page.id, Words::Codes, false);
                    // Coded once, whether or not the page is on the GPU, so the dictionary holds its texts.
                    let codes = self.gpu.dictionaries.field(field.0, field.1, field.2).codes(page);
                    let offset =
                        self.gpu.arena.get(key, page.values.len() as u32, || Content::Computed(codes.to_vec()));
                    self.push(key, offset);
                }
            }
            Some(Field::Values(values, _)) if column.words == Words::Path => self.path(values),
            Some(Field::Values(values, _)) => {
                self.listed(values);
                self.pages(values, column.words, false);
                if column.low {
                    d[wgsl::COLUMN_LOW as usize] = self.words.len() as u32;
                    self.pages(values, column.words, true);
                }
            }
            Some(Field::Reference(reference)) => {
                self.listed(&reference.rows);
                self.pages(&reference.rows, Words::Bits, false);
            }
            Some(Field::Sampled(samples, _)) if column.trace => {
                self.pages = None;
                d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED;
                self.trace(samples, plan(samples, window), table.len());
            }
            Some(Field::Sampled(samples, _)) => {
                self.pages = None;
                d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED | if column.step { wgsl::STEP } else { 0 };
                let frame = samples.frame_at(at);
                let t = if column.step { 0.0 } else { frame.map_or(0.0, |f| samples.t(f, at)) };
                d[wgsl::COLUMN_T as usize] = t.to_bits();
                self.cursors(samples, frame, table.len());
            }
            None => self.pages = None,
        }
        d
    }

    /// A join's table: a bits column of the mark's rows.
    fn join(&mut self, join: &Join, rows: usize) -> [u32; WORDS] {
        self.pages = None;
        let mut d = [0; WORDS];
        d[wgsl::COLUMN_FLAGS as usize] = wgsl::BITS;
        d[wgsl::COLUMN_ROWS as usize] = rows as u32;
        d[wgsl::COLUMN_LOW as usize] = wgsl::NONE;
        d[wgsl::COLUMN_JOIN as usize] = wgsl::NONE;
        for (id, words) in &join.pages {
            let key = PageKey::of(*id, Words::Bits, false);
            let offset = self.gpu.arena.get(key, words.len() as u32, || Content::Computed(words.to_vec()));
            self.push(key, offset);
        }
        d
    }

    /// Lists 's pages as the row blocks the table reads.
    fn listed(&mut self, column: &Column) {
        if let Some(pages) = &mut self.pages {
            pages.extend(column.pages().iter().map(|page| page.id));
        }
    }

    fn pages(&mut self, column: &Column, words: Words, low: bool) {
        for page in column.pages() {
            let key = PageKey::of(page.id, words, low);
            let values = page.values.clone();
            let offset = self.gpu.arena.get(key, values.len() as u32, || Content::Values { values, words, low });
            self.push(key, offset);
        }
    }

    /// A geometry column's table, as `lib/read.wesl` reads it: per page, the block of each row's
    /// first point, where the page's blocks of points are listed in the table, and how many points
    /// it has; then those lists. A page's points take as many blocks of a chunk as they need.
    fn path(&mut self, column: &Column) {
        self.listed(column);
        let pages = column.pages();
        self.words.resize(3 * pages.len(), 0);
        for (p, page) in pages.iter().enumerate() {
            let points = path_points(&page.values);
            self.points += points as u32;
            let mut made: Option<Vec<Vec<u32>>> = None;
            let mut blocks = Vec::with_capacity(1 + points.div_ceil(PIECE_POINTS));
            for piece in 0..=points.div_ceil(PIECE_POINTS) {
                let key = PageKey { page: page.id, words: Words::Path, low: false, piece: piece as u32 };
                let offset = self.gpu.arena.get(key, 1, || {
                    let pieces = made.get_or_insert_with(|| path_pieces(&page.values));
                    Content::Computed(std::mem::take(&mut pieces[piece]))
                });
                self.pins.push(key);
                self.ready &= offset.is_some();
                blocks.push(offset.unwrap_or(wgsl::NONE));
            }
            let listed = self.words.len() as u32;
            self.words[3 * p..3 * p + 3].copy_from_slice(&[blocks[0], listed, points as u32]);
            self.words.extend(&blocks[1..]);
        }
    }

    /// What a line draws, laid out as `lib/trace.wesl` reads it: a header (how many runs, row blocks,
    /// and levels, and the points in all); per run its level's place, first entry, entries, and first
    /// point; per level the level, how many axis pages and where they are listed, and where its row
    /// blocks' lists start; per level and row block how many pages of frames or least values and where
    /// they are listed, then of greatest values; then those lists, axis pages as (offset, first entry)
    /// and pages of values as (offset, first entry, words per entry). Offsets within the table are
    /// relative to it.
    fn trace(&mut self, samples: &Samples, plan: Plan, rows: usize) {
        let blocks = rows.div_ceil(PAGE_ROWS);
        // Each run has its own local origin. Even sparse runs billions of frames apart use
        // compact GPU offsets, while CPU plans retain their absolute 64-bit indexes.
        self.words.extend([plan.runs.len() as u32, blocks as u32, plan.runs.len() as u32, plan.points]);
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
            let axis = samples.axis_pages(run.level, run.entries.clone());
            let listed_at = self.words.len() as u32;
            self.words[at + 4 * i..at + 4 * i + 3].copy_from_slice(&[run.level, axis.len() as u32, listed_at]);
            for (page, held) in &axis {
                let key = PageKey::of(page.id, Words::Values, false);
                let offset =
                    self.gpu.arena.get(key, ((held.end - page.first) * 2) as u32, || Content::Axis(page.clone()));
                self.pins.push(key);
                self.ready &= offset.is_some();
                self.words.extend([offset.unwrap_or(wgsl::NONE), (page.first - origin) as u32]);
            }
            let lists = self.words.len();
            self.words[at + 4 * i + 3] = lists as u32;
            self.words.resize(lists + 4 * blocks, 0);
            for block in 0..blocks {
                for side in 0..crate::data::sides(run.level) {
                    let pages = samples.pages(block, run.level, side, run.entries.clone());
                    self.words[lists + 4 * block + 2 * side] = pages.len() as u32;
                    self.words[lists + 4 * block + 2 * side + 1] = self.words.len() as u32;
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
            let offset = self.gpu.arena.get(key, need, || Content::Frames(page.clone()));
            self.pins.push(key);
            self.ready &= offset.is_some();
            self.words.extend([offset.unwrap_or(wgsl::NONE), (page.first - origin) as u32, page.per]);
        }
    }

    /// Six words per row block: this frame's block and word, the next frame's, and their row counts.
    fn cursors(&mut self, samples: &Samples, frame: Option<u64>, rows: usize) {
        for block in 0..rows.div_ceil(PAGE_ROWS) {
            let mut cursor = [wgsl::NONE, 0, wgsl::NONE, 0, 0, 0];
            for (i, f) in [frame, frame.map(|f| f + 1)].into_iter().enumerate() {
                let Some((page, base)) = f.and_then(|f| samples.cursor(block, f)) else { continue };
                let key = PageKey::of(page.id, Words::Values, false);
                let rows_in_page = page.per;
                let offset = self.gpu.arena.get(key, base + rows_in_page, || Content::Frames(page.clone()));
                self.pins.push(key);
                self.ready &= offset.is_some();
                cursor[2 * i] = offset.unwrap_or(wgsl::NONE);
                cursor[2 * i + 1] = base;
                cursor[4 + i] = rows_in_page;
            }
            self.words.extend(cursor);
        }
    }

    fn push(&mut self, key: PageKey, offset: Option<u32>) {
        self.pins.push(key);
        self.ready &= offset.is_some();
        self.words.push(offset.unwrap_or(wgsl::NONE));
    }
}
