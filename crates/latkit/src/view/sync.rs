//! A mark's columns on the GPU: for every column its program reads, a descriptor and a page table of
//! arena offsets, or for sampled columns a cursor per row block at the shown coordinate.
//!
//! A column a line traces holds every frame in view instead: its axis pages and, per row block, its
//! frame pages.
//!
//! Only columns whose inputs changed are rebuilt: moving the shown coordinate rebuilds sampled
//! columns' cursors and nothing else. A mark keeps drawing its current tables until every page of
//! its rebuilt ones is resident, then swaps them in together, so a data version appears whole.
//! Tables pin the pages they reference.

use std::ops::Range;
use std::sync::Arc;

use crate::data::{Column, Field, PAGE_ROWS, PageId, Samples, Version};
use crate::expr::compile::{ColumnUse, Part, Program, Reads};
use crate::gpu::Inner;
use crate::gpu::arena::{Content, PageKey};
use crate::gpu::shaders as wgsl;
use crate::{Data, Name, Table};

const WORDS: usize = wgsl::COLUMN_WORDS as usize;

/// What one column's table was built from; a change in it means rebuilding the table.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Stamp {
    Missing,
    Field(Version),
    Sampled(Version, Option<u32>, u32),
    Trace(Version, u32, u32),
    Join(Version, Version),
}

/// One column on the GPU: its descriptor, whose table offsets are relative to `words`, its page table
/// or cursors, and the pages it pins.
struct ColumnTable {
    stamp: Stamp,
    descriptor: [u32; WORDS],
    words: Vec<u32>,
    pins: Vec<PageKey>,
    /// Frames a traced column draws.
    frames: u32,
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
    joins: Vec<Join>,
    synced: bool,
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

/// Where a mark's own rows come from.
pub(crate) struct Source<'a> {
    pub(crate) data: &'a Data,
    pub(crate) table: &'a Table,
}

/// One column a program reads: a field, or the rows a join maps to.
enum Use<'a> {
    Field { column: &'a ColumnUse, join: u32 },
    Join(&'a (Name, Name)),
}

impl Tables {
    /// Brings the tables up to date with `source` and every dataset in `all` at coordinate `at`;
    /// traced columns hold the frames across `window`, or every frame without one.
    pub(crate) fn sync(
        &mut self,
        program: &Program,
        source: &Source<'_>,
        all: &[Data],
        at: f64,
        window: Option<[f64; 2]>,
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
        let reshape = !self.synced || self.current.len() != uses.len();
        let mut rebuilt = Vec::new();
        let mut ready = true;
        for (i, use_) in uses.iter().enumerate() {
            let stamp = match use_ {
                Use::Field { column, .. } => stamp(column, source, all, at, window),
                Use::Join(of) => match table_of(Some(of), source, all) {
                    Some((_, other)) => Stamp::Join(source.table.structure, other.structure),
                    None => Stamp::Missing,
                },
            };
            if !reshape && self.current[i].stamp == stamp {
                continue;
            }
            let mut builder = Builder { words: Vec::new(), pins: Vec::new(), ready: true, frames: 0, gpu: &mut *gpu };
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
            let Builder { words, pins, ready: column_ready, frames, gpu: _ } = builder;
            for &key in &pins {
                gpu.arena.pin(key);
            }
            ready &= column_ready;
            rebuilt.push((i, ColumnTable { stamp, descriptor, words, pins, frames }));
        }
        for (_, table) in std::mem::take(&mut self.pending) {
            unpin(&table.pins, gpu);
        }
        if rebuilt.is_empty() {
            return Synced::Same;
        }
        if !ready {
            self.pending = rebuilt;
            return Synced::Waiting;
        }
        let changed = if reshape {
            for table in std::mem::take(&mut self.current) {
                unpin(&table.pins, gpu);
            }
            self.current = rebuilt.into_iter().map(|(_, table)| table).collect();
            u64::MAX
        } else {
            let mut changed = 0;
            for (i, table) in rebuilt {
                unpin(&self.current[i].pins, gpu);
                self.current[i] = table;
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

    /// Whether the tables were built at least once.
    pub(crate) fn synced(&self) -> bool {
        self.synced
    }

    /// Frames the traced column draws.
    pub(crate) fn traced(&self) -> u32 {
        self.current.iter().map(|t| t.frames).max().unwrap_or(0)
    }

    /// Whether rebuilt tables wait for pages to upload.
    pub(crate) fn waiting(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Words the descriptors and tables take in the program buffer.
    pub(crate) fn len(&self) -> usize {
        self.current.iter().map(|t| WORDS + t.words.len()).sum()
    }

    /// Appends every descriptor, then every table; `base` is the word of the program buffer the
    /// first descriptor lands at, so table offsets are absolute.
    pub(crate) fn pack(&self, base: u32, out: &mut Vec<u32>) {
        let mut at = base + (self.current.len() * WORDS) as u32;
        for table in &self.current {
            let mut d = table.descriptor;
            d[wgsl::COLUMN_TABLE as usize] += at;
            if d[wgsl::COLUMN_LOW as usize] != wgsl::NONE {
                d[wgsl::COLUMN_LOW as usize] += at;
            }
            out.extend(d);
            at += table.words.len() as u32;
        }
        for table in &self.current {
            out.extend(&table.words);
        }
    }

    /// Releases every pin.
    pub(crate) fn release(&mut self, gpu: &mut Inner) {
        for table in self.current.drain(..).chain(self.pending.drain(..).map(|(_, t)| t)) {
            unpin(&table.pins, gpu);
        }
        self.synced = false;
    }

    /// The join rows for `of`, reused while neither table's rows change.
    fn join(&self, of: &(Name, Name), source: &Source<'_>, all: &[Data]) -> Join {
        let Some((_, other)) = table_of(Some(of), source, all) else {
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

/// The dataset and table a column reads: the mark's own, or another one joined by id.
pub(crate) fn table_of<'a>(
    of: Option<&(Name, Name)>,
    source: &Source<'a>,
    all: &'a [Data],
) -> Option<(&'a Data, &'a Table)> {
    match of {
        None => Some((source.data, source.table)),
        Some((data, table)) => {
            let data = all.iter().find(|d| d.name() == data)?;
            Some((data, data.table(table)?))
        }
    }
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

fn stamp(column: &ColumnUse, source: &Source<'_>, all: &[Data], at: f64, window: Option<[f64; 2]>) -> Stamp {
    let Some((_, table)) = table_of(column.of.as_ref(), source, all) else { return Stamp::Missing };
    match table.field_named(&column.name) {
        None => Stamp::Missing,
        Some(Field::Sampled(samples, version)) if column.trace => {
            let frames = traced(samples, window);
            Stamp::Trace(*version, frames.start, frames.end)
        }
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
    frames: u32,
    gpu: &'g mut Inner,
}

impl Builder<'_> {
    fn column(
        &mut self,
        column: &ColumnUse,
        source: &Source<'_>,
        all: &[Data],
        at: f64,
        window: Option<[f64; 2]>,
    ) -> [u32; WORDS] {
        let mut d = [0; WORDS];
        d[wgsl::COLUMN_LOW as usize] = wgsl::NONE;
        if column.part == Part::Bits {
            d[wgsl::COLUMN_FLAGS as usize] = wgsl::BITS;
        }
        let Some((data, table)) = table_of(column.of.as_ref(), source, all) else { return d };
        d[wgsl::COLUMN_ROWS as usize] = table.len() as u32;
        match table.field_named(&column.name) {
            Some(Field::Values(values, _)) if column.part == Part::Codes => {
                let field = (data.name(), &table.name, &column.name);
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
                self.trace(samples, traced(samples, window), table.len());
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
            let offset = self.gpu.arena.get(key, page.values.len() as u32, || Content::Values { values, part, low });
            self.push(key, offset);
        }
    }

    /// The frames a line draws: the first and how many, the axis pages as (offset, first frame), per
    /// row block its page count and where its pages start, then the frame pages as (offset, first
    /// frame, rows). Offsets within the table are relative to it.
    fn trace(&mut self, samples: &Samples, frames: Range<u32>, rows: usize) {
        self.frames = frames.end - frames.start;
        self.words.extend([frames.start, self.frames, 0, 0]);
        let axis = samples.axis_pages(frames.clone());
        for (i, page) in axis.iter().enumerate() {
            let through = axis.get(i + 1).map_or(frames.end, |next| next.first).min(frames.end);
            let key = PageKey { page: page.id, part: Part::Values, low: false };
            let need = through.saturating_sub(page.first) * 2;
            let offset = self.gpu.arena.get(key, need, || Content::Axis(page.clone()));
            self.pins.push(key);
            self.ready &= offset.is_some();
            self.words.extend([offset.unwrap_or(wgsl::NONE), page.first]);
        }
        self.words[2] = axis.len() as u32;
        let blocks = rows.div_ceil(PAGE_ROWS);
        self.words[3] = blocks as u32;
        let header = self.words.len();
        self.words.resize(header + 2 * blocks, 0);
        for block in 0..blocks {
            let pages = samples.frame_pages(block, frames.clone());
            self.words[header + 2 * block] = pages.len() as u32;
            self.words[header + 2 * block + 1] = self.words.len() as u32;
            for (i, page) in pages.iter().enumerate() {
                let through = pages.get(i + 1).map_or(frames.end, |next| next.first).min(frames.end);
                let key = PageKey { page: page.id, part: Part::Values, low: false };
                let need = through.saturating_sub(page.first) * page.rows;
                let offset = self.gpu.arena.get(key, need, || Content::Frames(page.clone()));
                self.pins.push(key);
                self.ready &= offset.is_some();
                self.words.extend([offset.unwrap_or(wgsl::NONE), page.first, page.rows]);
            }
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
