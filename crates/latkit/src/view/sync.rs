//! A mark's columns on the GPU: for every column its program reads, a descriptor and a page table of
//! arena offsets, or for sampled columns a cursor per row block at the shown coordinate.
//!
//! A column a line traces holds what is in view instead: its axis pages and, per row block, its
//! frame pages; past two frames per pixel column, the buckets of the level of detail that fit and
//! the frames after the last bucket written.
//!
//! Only columns whose inputs changed are rebuilt: moving the shown coordinate rebuilds sampled
//! columns' cursors and nothing else. A mark keeps drawing its current tables until every page of
//! its rebuilt ones is resident, then swaps them in together, so a data version appears whole.
//! Tables pin the pages they reference. While a mark eases, the table its geometry column had when
//! the transition began stays, packed after the rest, so paths morph from it.

use std::ops::Range;
use std::sync::Arc;

use crate::data::{Column, Field, FramePage, Geometry, LEVELS, PAGE_ROWS, PageId, Samples, Version, bucket_frames};
use crate::derive::Beside;
use crate::expr::compile::{ColumnUse, Part, Program, Reads};
use crate::gpu::Inner;
use crate::gpu::arena::{Content, PageKey, page_words};
use crate::gpu::shaders as wgsl;
use crate::{Data, Name, Table};

const WORDS: usize = wgsl::COLUMN_WORDS as usize;

/// What one column's table was built from; a change in it means rebuilding the table.
#[derive(Clone, PartialEq, Debug)]
enum Stamp {
    Missing,
    Field(Version),
    Sampled(Version, Option<u32>, u32),
    Trace(Version, Plan),
    Join(Version, Version),
}

/// What a trace shows: the window across, and the pixel columns it spans.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Window {
    pub(crate) across: Option<[f64; 2]>,
    pub(crate) columns: u32,
}

/// What a traced column draws: buckets of a level of detail, then frames.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Plan {
    pub(crate) level: u32,
    pub(crate) buckets: Range<u32>,
    pub(crate) frames: Range<u32>,
}

impl Plan {
    /// Points the trace runs through: a bucket's least and greatest, then each frame.
    pub(crate) fn points(&self) -> u32 {
        2 * self.buckets.len() as u32 + self.frames.len() as u32
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
    /// New tables: bit `i` of `columns` for each program column that changed.
    Changed { columns: u64 },
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
            let mut builder =
                Builder { words: Vec::new(), pins: Vec::new(), ready: true, plan: None, points: 0, gpu: &mut *gpu };
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
            let Builder { words, pins, ready: column_ready, plan, points, gpu: _ } = builder;
            for &key in &pins {
                gpu.arena.pin(key);
            }
            ready &= column_ready;
            rebuilt.push((i, ColumnTable { stamp, descriptor, words, pins, plan, points }));
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
        let changed = if reshape {
            self.thaw(gpu);
            for table in std::mem::take(&mut self.current) {
                unpin(&table.pins, gpu);
            }
            self.current = rebuilt.into_iter().map(|(_, table)| table).collect();
            u64::MAX
        } else {
            let mut changed = 0;
            for (i, table) in rebuilt {
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
        Synced::Changed { columns: changed }
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
        self.plan().map_or(0, Plan::points)
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

/// The frames a trace across `window` draws: from the last frame at or before its start through the
/// first at or after its end.
fn traced(samples: &Samples, window: Option<[f64; 2]>) -> Range<u32> {
    let (start, end) = (samples.start(), samples.end());
    let Some([x0, x1]) = window else { return start..end };
    let first = samples.frame_at(x0).unwrap_or(start);
    let last = samples.frame_from(x1).map_or(start, |f| f + 1);
    first..last.max(first)
}

/// What a trace across `window` draws: every frame while there are at most two per pixel column,
/// else the buckets of the coarsest level needed, written so far, and the frames after them.
fn plan(samples: &Samples, window: Window) -> Plan {
    let frames = traced(samples, window.across);
    let needed = (frames.len() as u32).div_ceil(2 * window.columns.max(1));
    if needed <= 1 {
        return Plan { level: 0, buckets: 0..0, frames };
    }
    let level = (1..=LEVELS).find(|&k| bucket_frames(k) >= needed).unwrap_or(LEVELS);
    let span = bucket_frames(level);
    let first = frames.start / span;
    let end = samples.sealed(level).min(frames.end.div_ceil(span)).max(first);
    let tail = (end * span).max(frames.start).min(frames.end);
    Plan { level, buckets: first..end, frames: tail..frames.end }
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
        if column.part == Part::Bits {
            d[wgsl::COLUMN_FLAGS as usize] = wgsl::BITS;
        }
        let Some((data, table)) = table_of(column, source, all) else { return d };
        d[wgsl::COLUMN_ROWS as usize] = table.len() as u32;
        match table.field_named(&column.name) {
            Some(Field::Values(values, _)) if column.part == Part::Codes => {
                let field = (data, &table.name, &column.name);
                for page in values.pages() {
                    let key = PageKey { page: page.id, part: Part::Codes, low: false };
                    let dictionary = self.gpu.dictionaries.field(field.0, field.1, field.2);
                    dictionary.scan(page);
                    let codes = &mut self.gpu.dictionaries;
                    let offset = self.gpu.arena.get(key, page.values.len() as u32, || {
                        Content::Words(codes.field(field.0, field.1, field.2).codes(page))
                    });
                    self.push(key, offset);
                }
            }
            Some(Field::Values(values, _)) => {
                self.pages(values, column.part, false);
                if column.low {
                    d[wgsl::COLUMN_LOW as usize] = self.words.len() as u32;
                    self.pages(values, column.part, true);
                }
            }
            Some(Field::Reference(reference)) => self.pages(&reference.rows, Part::Bits, false),
            Some(Field::Sampled(samples, _)) if column.trace => {
                d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED;
                self.trace(samples, plan(samples, window), table.len());
            }
            Some(Field::Sampled(samples, _)) => {
                d[wgsl::COLUMN_FLAGS as usize] |= wgsl::SAMPLED | if column.step { wgsl::STEP } else { 0 };
                let frame = samples.frame_at(at);
                let t = if column.step { 0.0 } else { frame.map_or(0.0, |f| samples.t(f, at)) };
                d[wgsl::COLUMN_T as usize] = t.to_bits();
                self.cursors(samples, frame, table.len());
            }
            None => {}
        }
        d
    }

    /// A join's table: a bits column of the mark's rows.
    fn join(&mut self, join: &Join, rows: usize) -> [u32; WORDS] {
        let mut d = [0; WORDS];
        d[wgsl::COLUMN_FLAGS as usize] = wgsl::BITS;
        d[wgsl::COLUMN_ROWS as usize] = rows as u32;
        d[wgsl::COLUMN_LOW as usize] = wgsl::NONE;
        d[wgsl::COLUMN_JOIN as usize] = wgsl::NONE;
        for (id, words) in &join.pages {
            let key = PageKey { page: *id, part: Part::Bits, low: false };
            let offset = self.gpu.arena.get(key, words.len() as u32, || Content::Words(words.to_vec()));
            self.push(key, offset);
        }
        d
    }

    fn pages(&mut self, column: &Column, part: Part, low: bool) {
        for page in column.pages() {
            let key = PageKey { page: page.id, part, low };
            let values = page.values.clone();
            let offset = if part == Part::Path {
                // A geometry's points take as many words as they do; a resident page holds them all.
                self.points += values.geometry().map_or(0, Geometry::points) as u32;
                self.gpu.arena.get(key, 1, || Content::Words(page_words(&values, part, low)))
            } else {
                self.gpu.arena.get(key, values.len() as u32, || Content::Values { values, part, low })
            };
            self.push(key, offset);
        }
    }

    /// What a line draws, laid out as `lib/trace.wesl` reads it: a header (the first frame and how
    /// many, axis page and row block counts, the level, its first bucket and how many), the axis
    /// pages as (offset, first frame), per row block where its frame pages and level pages start and
    /// how many, then those pages as (offset, first frame or bucket, words per entry). Offsets within
    /// the table are relative to it.
    fn trace(&mut self, samples: &Samples, plan: Plan, rows: usize) {
        let span = bucket_frames(plan.level);
        let axis_frames =
            (plan.buckets.start * span).min(plan.frames.start)..plan.frames.end.max(plan.buckets.end * span);
        let axis = samples.axis_pages(axis_frames.clone());
        let blocks = rows.div_ceil(PAGE_ROWS);
        self.words.extend([
            plan.frames.start,
            plan.frames.len() as u32,
            axis.len() as u32,
            blocks as u32,
            plan.level,
            plan.buckets.start,
            plan.buckets.len() as u32,
            0,
        ]);
        for (i, page) in axis.iter().enumerate() {
            let through = axis.get(i + 1).map_or(axis_frames.end, |next| next.first).min(axis_frames.end);
            let key = PageKey { page: page.id, part: Part::Values, low: false };
            let need = through.saturating_sub(page.first) * 2;
            let offset = self.gpu.arena.get(key, need, || Content::Axis(page.clone()));
            self.pins.push(key);
            self.ready &= offset.is_some();
            self.words.extend([offset.unwrap_or(wgsl::NONE), page.first]);
        }
        let header = self.words.len();
        self.words.resize(header + 4 * blocks, 0);
        for block in 0..blocks {
            let frames = samples.frame_pages(block, plan.frames.clone());
            self.words[header + 4 * block] = frames.len() as u32;
            self.words[header + 4 * block + 1] = self.words.len() as u32;
            self.sample_pages(&frames, plan.frames.end);
            let buckets =
                if plan.level > 0 { samples.level_pages(block, plan.level, plan.buckets.clone()) } else { Vec::new() };
            self.words[header + 4 * block + 2] = buckets.len() as u32;
            self.words[header + 4 * block + 3] = self.words.len() as u32;
            self.sample_pages(&buckets, plan.buckets.end);
        }
        self.plan = Some(plan);
    }

    /// Appends `pages` as (offset, first entry, words per entry), each holding entries up to `end`.
    fn sample_pages(&mut self, pages: &[FramePage], end: u32) {
        for (i, page) in pages.iter().enumerate() {
            let through = pages.get(i + 1).map_or(end, |next| next.first).min(end);
            let key = PageKey { page: page.id, part: Part::Values, low: false };
            let need = through.saturating_sub(page.first) * page.rows;
            let offset = self.gpu.arena.get(key, need, || Content::Frames(page.clone()));
            self.pins.push(key);
            self.ready &= offset.is_some();
            self.words.extend([offset.unwrap_or(wgsl::NONE), page.first, page.rows]);
        }
    }

    /// Six words per row block: this frame's block and word, the next frame's, and their row counts.
    fn cursors(&mut self, samples: &Samples, frame: Option<u32>, rows: usize) {
        for block in 0..rows.div_ceil(PAGE_ROWS) {
            let mut cursor = [wgsl::NONE, 0, wgsl::NONE, 0, 0, 0];
            for (i, f) in [frame, frame.map(|f| f + 1)].into_iter().enumerate() {
                let Some((page, base)) = f.and_then(|f| samples.cursor(block, f)) else { continue };
                let key = PageKey { page: page.id, part: Part::Values, low: false };
                let rows_in_page = page.rows;
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
