//! Samples: a field's values over the data's axis. Level 0 holds frames, each row's value at one
//! coordinate; each level `k` above it holds buckets of `8^k` frames, each row's least and greatest over
//! them, so a long history draws from as few entries as there are pixels. Every level keeps its
//! entries in pages, with each entry's coordinates (a frame's own; a bucket's first and last frame's),
//! so a level draws without the levels below it. Frames are numbered from the first ever written, and
//! a version reads `start..end`.
//!
//! Any entry may be missing. Frames appended grow the newest pages in place and seal each bucket whose
//! entries below are all held; runs of entries read from bytes or fetched as time tiles fill any span,
//! whatever lies around them. An entry is held when its level's coordinates hold it: every write writes
//! an entry's coordinates and every row block's values together.

use std::ops::Range;
use std::sync::{Arc, PoisonError, RwLock};

use super::column::{PAGE_BITS, PAGE_MASK, PAGE_ROWS};
use super::name::PageId;
use super::values::Values;
use crate::{Error, Result};

/// Words in a frame page: entries of one row block, entry-major. An axis page holds as many words on
/// the GPU, two for each entry.
pub(crate) const FRAME_PAGE_WORDS: usize = 1 << 16;
/// Levels of detail kept above frames: level `k` holds each row's least and greatest value over buckets
/// of `8^k` frames.
pub(crate) const LEVELS: u32 = 6;
/// Logs of a row block: its frames, then each level's least and greatest values.
const SLOTS: usize = 1 + 2 * LEVELS as usize;

/// Frames an entry of level `level` spans: a frame, or a bucket's frames.
pub(crate) fn bucket_frames(level: u32) -> u32 {
    1 << (3 * level)
}

/// The level of detail `frames` frames draw at across `columns` pixel columns: frames while there are
/// at most two a column, else the finest level whose buckets are no fewer.
pub(crate) fn detail(frames: u32, columns: u32) -> u32 {
    let needed = frames.div_ceil(2 * columns.max(1));
    if needed <= 1 { 0 } else { (1..=LEVELS).find(|&k| bucket_frames(k) >= needed).unwrap_or(LEVELS) }
}

/// Coordinates an entry of `level` holds: a frame its own, a bucket its first and last frame's.
pub(crate) fn coordinates(level: u32) -> usize {
    if level == 0 { 1 } else { 2 }
}

/// Values a row holds of an entry of `level`: a frame's, or a bucket's least and greatest.
pub(crate) fn sides(level: u32) -> usize {
    if level == 0 { 1 } else { 2 }
}

/// The log of a row block holding `level`'s values of `side`: its frames, or a level's least (0) or
/// greatest (1).
fn slot(level: u32, side: usize) -> usize {
    if level == 0 { 0 } else { 2 * level as usize - 1 + side }
}

/// Entries `entries` of level `level`.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Run {
    pub(crate) level: u32,
    pub(crate) entries: Range<u32>,
}

impl Run {
    /// The frames its entries span.
    pub(crate) fn frames(&self) -> Range<u32> {
        let span = bucket_frames(self.level);
        self.entries.start.saturating_mul(span)..self.entries.end.saturating_mul(span)
    }

    /// How many coordinates it holds, and how many values for `rows` rows.
    pub(crate) fn sizes(&self, rows: usize) -> (usize, usize) {
        let n = self.entries.len();
        (n * coordinates(self.level), n * rows * sides(self.level))
    }
}

/// Appends `run` to `runs`, joining it to the last where it follows it at the same level.
fn join(runs: &mut Vec<Run>, run: Run) {
    match runs.last_mut() {
        Some(last) if last.level == run.level && last.entries.end == run.entries.start => {
            last.entries.end = run.entries.end;
        }
        _ => runs.push(run),
    }
}

/// A list shared between versions. Indices are absolute: a version reads items `start..end`, so
/// forgetting the oldest never renumbers the rest.
///
/// A version that appends while it is the newest grows the shared list in place; any other change, an
/// older version appending, an item put between others or taken out, forks a copy of what it reads.
pub(crate) struct Log<T> {
    items: Arc<RwLock<Vec<T>>>,
    /// The absolute index of `items[0]`.
    base: usize,
    start: usize,
    end: usize,
}

impl<T> Clone for Log<T> {
    fn clone(&self) -> Log<T> {
        Log { items: self.items.clone(), base: self.base, start: self.start, end: self.end }
    }
}

impl<T> Default for Log<T> {
    fn default() -> Log<T> {
        Log { items: Arc::default(), base: 0, start: 0, end: 0 }
    }
}

impl<T: Clone> Log<T> {
    pub(crate) fn push(&mut self, item: T) {
        {
            let mut items = self.items.write().unwrap_or_else(PoisonError::into_inner);
            if self.base + items.len() == self.end {
                items.push(item);
                self.end += 1;
                return;
            }
        }
        self.edit(|items| items.push(item));
    }

    /// Changes the items this version reads in a copy of its own.
    fn edit(&mut self, f: impl FnOnce(&mut Vec<T>)) {
        let mut items = self.read(<[T]>::to_vec);
        f(&mut items);
        self.end = self.start + items.len();
        self.items = Arc::new(RwLock::new(items));
        self.base = self.start;
    }

    /// Reads items `start..end`.
    pub(crate) fn read<R>(&self, f: impl FnOnce(&[T]) -> R) -> R {
        let items = self.items.read().unwrap_or_else(PoisonError::into_inner);
        f(&items[self.start - self.base..self.end - self.base])
    }

    pub(crate) fn last(&self) -> Option<T> {
        self.read(|items| items.last().cloned())
    }

    /// Stops reading items before absolute index `start`. Storage shared with other versions stays
    /// theirs; this version copies what it keeps once the forgotten part outgrows a quarter of it.
    pub(crate) fn forget(&mut self, start: usize) {
        self.start = start.clamp(self.start, self.end);
        if self.start - self.base > (self.end - self.start) / 4 + 16 {
            let kept = self.read(<[T]>::to_vec);
            self.items = Arc::new(RwLock::new(kept));
            self.base = self.start;
        }
    }
}

/// What a page stores, shared by every version reading it, and whether appends grow it.
struct Store<T> {
    grows: bool,
    items: RwLock<Vec<T>>,
}

/// Consecutive entries of a level, `per` values each, entry-major: a row block's frames or a level's
/// least or greatest values, `per` its rows; or a level's coordinates, `per` an entry's. A page an
/// append opened grows in place while it is the newest version's last; a version reads at most `cap`
/// entries of it, fewer than it stores where a newer version grew it.
#[derive(Clone)]
pub(crate) struct Page<T> {
    pub(crate) id: PageId,
    pub(crate) first: u32,
    pub(crate) per: u32,
    cap: u32,
    store: Arc<Store<T>>,
}

/// A page of a row block's frames, or of a level's least or greatest values: `per` rows an entry.
pub(crate) type FramePage = Page<f32>;
/// A page of a level's coordinates: `per` an entry, a frame's own or a bucket's first and last.
pub(crate) type AxisPage = Page<f64>;

impl<T: Copy> Page<T> {
    fn new(first: u32, per: usize, items: Vec<T>, grows: bool) -> Page<T> {
        Page {
            id: PageId::next(),
            first,
            per: per as u32,
            cap: u32::MAX,
            store: Arc::new(Store { grows, items: RwLock::new(items) }),
        }
    }

    /// Reads the page's stored items.
    pub(crate) fn read<R>(&self, f: impl FnOnce(&[T]) -> R) -> R {
        f(&self.store.items.read().unwrap_or_else(PoisonError::into_inner))
    }

    /// Whether appends grow it: it takes room to grow into on the GPU.
    pub(crate) fn grows(&self) -> bool {
        self.store.grows
    }

    /// Entries this version reads of it.
    pub(crate) fn len(&self) -> u32 {
        ((self.read(<[T]>::len) / self.per.max(1) as usize) as u32).min(self.cap)
    }

    pub(crate) fn end(&self) -> u32 {
        self.first + self.len()
    }

    /// Appends `entry`'s `items` where this version reads the whole page, appends grow it, and the
    /// entry follows its last and fits within `limit` items.
    fn extend(&self, entry: u32, items: &[T], limit: usize) -> bool {
        let mut stored = self.store.items.write().unwrap_or_else(PoisonError::into_inner);
        let at = (entry - self.first) as usize * self.per as usize;
        let fits = items.len() == self.per as usize && at + items.len() <= limit;
        if !self.store.grows || self.cap != u32::MAX || stored.len() != at || !fits {
            return false;
        }
        stored.extend_from_slice(items);
        true
    }

    /// The page as a version that reads only its first `len` entries sees it.
    fn capped(&self, len: u32) -> Page<T> {
        Page { cap: len, ..self.clone() }
    }
}

impl AxisPage {
    /// Coordinate `which` of entry `index`: a frame's own, a bucket's first (0) or last (1) frame's.
    fn coordinate(&self, index: u32, which: u32) -> Option<f64> {
        if index < self.first || index >= self.end() {
            return None;
        }
        let i = (index - self.first) as usize * self.per as usize + which.min(self.per - 1) as usize;
        self.read(|c| c.get(i).copied())
    }

    /// Where entry `index` draws: a frame at its coordinate, a bucket at its middle.
    fn drawn(&self, index: u32) -> Option<f64> {
        Some(f64::midpoint(self.coordinate(index, 0)?, self.coordinate(index, 1)?))
    }

    /// Words the page takes on the GPU: where each entry draws, as a high and a low `f32`.
    pub(crate) fn words_len(&self) -> usize {
        2 * (self.read(<[f64]>::len) / self.per as usize)
    }

    /// The page's GPU words from word `from` on: a growing page uploads only its new tail.
    pub(crate) fn words(&self, from: usize) -> Vec<u32> {
        let per = self.per as usize;
        self.read(|c| {
            let drawn = |e: usize| if per == 1 { c[e] } else { f64::midpoint(c[per * e], c[per * e + 1]) };
            (from / 2..c.len() / per).flat_map(|e| split(drawn(e))).collect()
        })
    }
}

fn split(x: f64) -> [u32; 2] {
    let hi = x as f32;
    [hi.to_bits(), ((x - f64::from(hi)) as f32).to_bits()]
}

/// The page of `log` holding entry `index`, where one does.
fn holding<T: Copy>(log: &Log<Page<T>>, index: u32) -> Option<Page<T>> {
    log.read(|pages| {
        let i = pages.partition_point(|p| p.first <= index).checked_sub(1)?;
        (index < pages[i].end()).then(|| pages[i].clone())
    })
}

/// The pages of `log` holding any of `entries`, in order, each with those it holds. A page that stores
/// entries past the next page's first, where a version forked, holds them no longer.
fn held<T: Copy>(log: &Log<Page<T>>, entries: Range<u32>) -> Vec<(Page<T>, Range<u32>)> {
    if entries.is_empty() {
        return Vec::new();
    }
    log.read(|pages| {
        let from = pages.partition_point(|p| p.first <= entries.start).saturating_sub(1);
        let mut out = Vec::new();
        for (i, page) in pages.iter().enumerate().skip(from) {
            if page.first >= entries.end {
                break;
            }
            let end = pages.get(i + 1).map_or(page.end(), |next| next.first.min(page.end()));
            let range = page.first.max(entries.start)..end.min(entries.end);
            if !range.is_empty() {
                out.push((page.clone(), range));
            }
        }
        out
    })
}

/// The first of `entries` a page of `log` holds.
fn first_held<T: Copy>(log: &Log<Page<T>>, entries: Range<u32>) -> Option<u32> {
    log.read(|pages| {
        let from = pages.partition_point(|p| p.first <= entries.start).saturating_sub(1);
        for (i, page) in pages.iter().enumerate().skip(from) {
            let start = page.first.max(entries.start);
            if start >= entries.end {
                return None;
            }
            let end = pages.get(i + 1).map_or(page.end(), |next| next.first.min(page.end()));
            if start < end {
                return Some(start);
            }
        }
        None
    })
}

/// Puts `page` in its place in `log`, among pages holding none of its entries.
fn place<T: Copy>(log: &mut Log<Page<T>>, page: Page<T>) {
    let (at, tip) = log.read(|pages| {
        let at = pages.partition_point(|p| p.first < page.first);
        (at, at == pages.len())
    });
    if tip { log.push(page) } else { log.edit(|pages| pages.insert(at, page)) }
}

/// Makes the last page of `log` hold no entry from `end` on, as a version reading entries before `end`
/// sees it, before the version writes past `end`.
fn cap<T: Copy>(log: &mut Log<Page<T>>, end: u32) {
    if log.last().is_some_and(|page| page.end() > end) {
        log.edit(|pages| {
            let last = pages.last_mut().expect("a last page");
            *last = last.capped(end.saturating_sub(last.first));
        });
    }
}

/// Takes the pages of `log` holding only entries of `entries` out of it.
fn take_out<T: Copy>(log: &mut Log<Page<T>>, entries: &Range<u32>) {
    let (from, to) = log.read(|pages| {
        let from = pages.partition_point(|p| p.first < entries.start);
        (from, from + pages[from..].iter().take_while(|p| p.end() <= entries.end).count())
    });
    if to > from {
        log.edit(|pages| drop(pages.drain(from..to)));
    }
}

/// Forgets the pages of `log` whose entries all lie before entry `index`.
fn forget_before<T: Copy>(log: &mut Log<Page<T>>, index: u32) {
    let dropped = log.read(|pages| pages.partition_point(|p| p.end() <= index));
    let start = log.start;
    log.forget(start + dropped);
}

/// Writes entry `entry`, `items` of it, after the last of `log`: into its last page where that grows
/// and has room within `limit` items, else into a new page that grows.
fn grow<T: Copy>(log: &mut Log<Page<T>>, entry: u32, items: &[T], limit: usize) {
    if !log.last().is_some_and(|page| page.extend(entry, items, limit)) {
        log.push(Page::new(entry, items.len(), items.to_vec(), true));
    }
}

/// Writes `entries` of a level, `items` of `per` each, as pages placed in order, as many entries to a
/// page as `limit` items allow.
fn put<T: Copy>(log: &mut Log<Page<T>>, entries: &Range<u32>, items: &[T], per: usize, limit: usize) {
    let step = (limit / per.max(1)).max(1);
    for (k, chunk) in items.chunks(step * per.max(1)).enumerate() {
        let first = entries.start + (k * step) as u32;
        place(log, Page::new(first, per, chunk.to_vec(), false));
    }
}

/// The logs a write writes into: every level's coordinates, and each row block's logs.
struct Logs {
    axes: Vec<Log<AxisPage>>,
    blocks: Vec<Vec<Log<FramePage>>>,
}

/// A field's samples over the data's axis: frames, and levels of detail above them, with holes.
#[derive(Clone, Default)]
pub(crate) struct Samples {
    /// Frames this version reads, numbered from the first ever written.
    start: u32,
    end: u32,
    /// Frames before this one were forgotten: pages may still store some, which this version must not
    /// read again.
    forgotten: u32,
    /// Per level from 0: its entries' coordinates; empty until anything is written.
    axes: Arc<[Log<AxisPage>]>,
    /// Per row block: its frames, then each level's least and greatest values.
    blocks: Arc<[Vec<Log<FramePage>>]>,
}

impl Samples {
    /// No frames yet, the first to be appended numbered `first`: what samples read back from bytes or
    /// gathered from others start from, so their frames keep their numbers.
    pub(crate) fn from_frame(first: u32) -> Samples {
        Samples { start: first, end: first, ..Samples::default() }
    }

    /// The first frame this version reads.
    pub(crate) fn start(&self) -> u32 {
        self.start
    }

    /// One past the last frame.
    pub(crate) fn end(&self) -> u32 {
        self.end
    }

    /// Reads frames `frames`: what bytes say, after the runs they hold are put in.
    pub(crate) fn reads(&mut self, frames: Range<u32>) {
        (self.start, self.end) = (frames.start, frames.end);
    }

    /// The same frames, none of them held: what a dataset written as time tiles starts from.
    pub(crate) fn emptied(&self) -> Samples {
        let mut empty = Samples::from_frame(self.start);
        empty.reads(self.start..self.end);
        empty
    }

    /// The entries of `level` this version reads: those whose frames lie before its end, from the one
    /// holding its first frame.
    fn visible(&self, level: u32) -> Range<u32> {
        let k = 3 * level;
        self.start >> k..self.end >> k
    }

    /// Copies of the logs to write into, with every level's and at least `blocks` row blocks'.
    fn logs(&self, blocks: usize) -> Logs {
        let mut axes = self.axes.to_vec();
        axes.resize_with(LEVELS as usize + 1, Log::default);
        let mut all = self.blocks.to_vec();
        all.resize_with(blocks.max(all.len()), || (0..SLOTS).map(|_| Log::default()).collect());
        Logs { axes, blocks: all }
    }

    fn keep(&mut self, logs: Logs) {
        self.axes = logs.axes.into();
        self.blocks = logs.blocks.into();
    }

    /// The log of row block `block` holding `level`'s values of `side`.
    fn log(&self, block: usize, level: u32, side: usize) -> Option<&Log<FramePage>> {
        self.blocks.get(block)?.get(slot(level, side))
    }

    /// The page of `level`'s coordinates holding entry `index`, where this version holds it.
    fn axis_page(&self, level: u32, index: u32) -> Option<AxisPage> {
        if !self.visible(level).contains(&index) {
            return None;
        }
        holding(self.axes.get(level as usize)?, index)
    }

    /// Whether no entry is held, of any level.
    pub(crate) fn is_empty(&self) -> bool {
        self.axes.iter().enumerate().all(|(level, log)| first_held(log, self.visible(level as u32)).is_none())
    }

    /// Whether entry `index` of `level` is held.
    pub(crate) fn held(&self, level: u32, index: u32) -> bool {
        self.axis_page(level, index).is_some()
    }

    /// Coordinate `which` of entry `index` of `level`: a frame's own, a bucket's first (0) or last (1).
    pub(crate) fn coordinate(&self, level: u32, index: u32, which: u32) -> Option<f64> {
        self.axis_page(level, index)?.coordinate(index, which)
    }

    /// Where entry `index` of `level` draws: a frame at its coordinate, a bucket at its middle.
    pub(crate) fn drawn_at(&self, level: u32, index: u32) -> Option<f64> {
        self.axis_page(level, index)?.drawn(index)
    }

    /// The coordinate of `frame`, where it is held.
    pub(crate) fn at(&self, frame: u32) -> Option<f64> {
        self.coordinate(0, frame, 0)
    }

    /// The runs of entries held, level by level, each as long as held entries follow one another.
    pub(crate) fn runs(&self) -> Vec<Run> {
        let mut runs = Vec::new();
        for (level, log) in self.axes.iter().enumerate() {
            let level = level as u32;
            for (_, entries) in held(log, self.visible(level)) {
                join(&mut runs, Run { level, entries });
            }
        }
        runs
    }

    /// The runs bytes hold: every run held but the buckets whose eight entries a level below are all
    /// held, since those follow from them.
    pub(crate) fn stored_runs(&self) -> Vec<Run> {
        let runs = self.runs();
        let mut stored = Vec::new();
        for run in &runs {
            if run.level == 0 {
                stored.push(run.clone());
                continue;
            }
            // Buckets that follow from the runs below, in order: what this run leaves out.
            let derived = runs
                .iter()
                .filter(|r| r.level + 1 == run.level)
                .map(|r| r.entries.start.div_ceil(8)..r.entries.end / 8)
                .filter(|d| !d.is_empty());
            let mut at = run.entries.start;
            for d in derived {
                let (from, to) = (d.start.max(at), d.end.min(run.entries.end));
                if from >= to {
                    continue;
                }
                if at < from {
                    stored.push(Run { level: run.level, entries: at..from });
                }
                at = to;
            }
            if at < run.entries.end {
                stored.push(Run { level: run.level, entries: at..run.entries.end });
            }
        }
        stored
    }

    /// The first and last coordinates of what this version holds, at any level.
    pub(crate) fn span(&self) -> Option<[f64; 2]> {
        let mut span: Option<[f64; 2]> = None;
        for (level, log) in self.axes.iter().enumerate() {
            let pages = held(log, self.visible(level as u32));
            let (Some((first, a)), Some((last, b))) = (pages.first(), pages.last()) else { continue };
            let (Some(lo), Some(hi)) = (first.coordinate(a.start, 0), last.coordinate(b.end - 1, 1)) else { continue };
            span = Some(span.map_or([lo, hi], |s| [s[0].min(lo), s[1].max(hi)]));
        }
        span
    }

    /// The coordinate of the last frame, or of the last entry of any level.
    fn last_coordinate(&self) -> Option<f64> {
        self.end.checked_sub(1).and_then(|f| self.at(f)).or_else(|| self.span().map(|s| s[1]))
    }

    /// Appends frames: `values` holds `at.len()` frames of `rows` values each, frame-major.
    pub(crate) fn append(&mut self, at: &[f64], values: &Values, rows: usize) -> Result<()> {
        if values.len() != at.len() * rows {
            return Err(Error::invalid(format!("{} values for {} frames of {rows} rows", values.len(), at.len())));
        }
        let mut last = self.last_coordinate();
        for &t in at {
            if !t.is_finite() {
                return Err(Error::invalid("a frame's coordinate must be finite"));
            }
            if last.is_some_and(|last| t < last) {
                return Err(Error::invalid("frame coordinates must not decrease"));
            }
            last = Some(t);
        }
        let blocks = rows.div_ceil(PAGE_ROWS);
        let mut logs = self.logs(blocks);
        let mut frame_values = vec![0.0_f32; rows];
        for (f, &t) in at.iter().enumerate() {
            let frame = self.end;
            for (row, value) in frame_values.iter_mut().enumerate() {
                let i = f * rows + row;
                *value = if values.is_valid(i) { values.number(i) as f32 } else { f32::NAN };
            }
            for (b, block) in logs.blocks.iter_mut().enumerate().take(blocks) {
                let slice = &frame_values[b * PAGE_ROWS..rows.min((b + 1) * PAGE_ROWS)];
                grow(&mut block[0], frame, slice, FRAME_PAGE_WORDS);
            }
            grow(&mut logs.axes[0], frame, &[t], FRAME_PAGE_WORDS / 2);
            self.end += 1;
            seal(&mut logs, frame);
        }
        self.keep(logs);
        Ok(())
    }

    /// Appends frames of some rows: `values` holds `at.len()` frames of a value per row of `rows`,
    /// frame-major. The rest of the `total` rows hold their last frame's values, missing before any.
    pub(crate) fn append_rows(&mut self, at: &[f64], values: &Values, rows: &[usize], total: usize) -> Result<()> {
        let given = rows.len();
        if values.len() != at.len() * given {
            return Err(Error::invalid(format!("{} values for {} frames of {given} rows", values.len(), at.len())));
        }
        let mut frame = vec![f32::NAN; total];
        if self.end > self.start {
            self.read_frame(self.end - 1, &mut frame);
        }
        let mut dense = Vec::with_capacity(at.len() * total);
        for f in 0..at.len() {
            for (k, &row) in rows.iter().enumerate() {
                let i = f * given + k;
                frame[row] = if values.is_valid(i) { values.number(i) as f32 } else { f32::NAN };
            }
            dense.extend_from_slice(&frame);
        }
        self.append(at, &Values::from(dense), total)
    }

    /// Puts `run`, held nowhere yet, in: its `coordinates` ([`coordinates`] an entry), and its values
    /// for `rows` rows, entry-major, at level 0 one a row, above each row's least then, after every
    /// entry's, each row's greatest. What it spans past this version's frames widens them.
    pub(crate) fn insert(&mut self, run: &Run, coordinates: &[f64], values: &[f32], rows: usize) -> Result<()> {
        let level = run.level;
        if level > LEVELS {
            return Err(Error::invalid(format!("no level {level}: levels run to {LEVELS}")));
        }
        let (per, sides) = (self::coordinates(level), sides(level));
        if run.entries.is_empty() || run.sizes(rows) != (coordinates.len(), values.len()) {
            return Err(Error::invalid(format!(
                "a run of {} entries of level {level} for {rows} rows",
                run.entries.len()
            )));
        }
        if coordinates.iter().any(|c| !c.is_finite()) || coordinates.windows(2).any(|w| w[1] < w[0]) {
            return Err(Error::invalid("a run's coordinates must be finite and must not decrease"));
        }
        let frames = run.frames();
        if frames.end == u32::MAX {
            return Err(Error::invalid("a run past the last frame a field numbers"));
        }
        if frames.start < self.forgotten {
            return Err(Error::invalid("a run before frames the field forgot"));
        }
        let visible = self.visible(level);
        let within = run.entries.start.max(visible.start)..run.entries.end.min(visible.end);
        if self.axes.get(level as usize).is_some_and(|log| first_held(log, within).is_some()) {
            return Err(Error::invalid(format!("entries {:?} of level {level} are held already", run.entries)));
        }
        let blocks = rows.div_ceil(PAGE_ROWS);
        let mut logs = self.logs(blocks);
        // What a newer version grew past this one's frames stays the newer version's.
        cap(&mut logs.axes[level as usize], visible.end);
        put(&mut logs.axes[level as usize], &run.entries, coordinates, per, FRAME_PAGE_WORDS / 2);
        let n = run.entries.len();
        for (b, block) in logs.blocks.iter_mut().enumerate().take(blocks) {
            let width = rows.min((b + 1) * PAGE_ROWS) - b * PAGE_ROWS;
            for side in 0..sides {
                let side_values = &values[side * n * rows..(side + 1) * n * rows];
                let mut page = Vec::with_capacity(n * width);
                for entry in side_values.chunks(rows) {
                    page.extend_from_slice(&entry[b * PAGE_ROWS..b * PAGE_ROWS + width]);
                }
                let log = &mut block[slot(level, side)];
                cap(log, visible.end);
                put(log, &run.entries, &page, width, FRAME_PAGE_WORDS);
            }
        }
        self.keep(logs);
        if self.start == self.end {
            (self.start, self.end) = (frames.start, frames.end);
        } else {
            self.start = self.start.min(frames.start);
            self.end = self.end.max(frames.end);
        }
        Ok(())
    }

    /// Takes the pages holding only entries of `run` out: a span let go of.
    pub(crate) fn remove(&mut self, run: &Run) {
        let mut logs = self.logs(0);
        take_out(&mut logs.axes[run.level as usize], &run.entries);
        for block in &mut logs.blocks {
            for side in 0..sides(run.level) {
                take_out(&mut block[slot(run.level, side)], &run.entries);
            }
        }
        self.keep(logs);
    }

    /// Writes each bucket of `level` not held whose eight entries a level below are all held: what
    /// bytes leave out, as they follow from those.
    pub(crate) fn derive(&mut self, level: u32) {
        let below: Vec<Run> = self.runs().into_iter().filter(|r| r.level + 1 == level).collect();
        for run in below {
            let buckets = run.entries.start.div_ceil(8)..run.entries.end / 8;
            for missing in self.missing(level, buckets) {
                let (coordinates, values, rows) = self.bucket_values(level, &missing);
                let run = Run { level, entries: missing };
                self.insert(&run, &coordinates, &values, rows).expect("buckets held nowhere");
            }
        }
    }

    /// The parts of `entries` of `level` not held.
    fn missing(&self, level: u32, entries: Range<u32>) -> Vec<Range<u32>> {
        let visible = self.visible(level);
        let held_runs = self
            .axes
            .get(level as usize)
            .map_or_else(Vec::new, |log| held(log, entries.start.max(visible.start)..entries.end.min(visible.end)));
        let mut out = Vec::new();
        let mut at = entries.start;
        for (_, range) in held_runs {
            if at < range.start {
                out.push(at..range.start);
            }
            at = range.end;
        }
        if at < entries.end {
            out.push(at..entries.end);
        }
        out
    }

    /// Buckets `buckets` of `level`, each from its eight entries a level below: their coordinates, and
    /// their values as [`insert`](Samples::insert) takes them, with how many rows.
    fn bucket_values(&self, level: u32, buckets: &Range<u32>) -> (Vec<f64>, Vec<f32>, usize) {
        let children = buckets.start * 8..buckets.end * 8;
        let mut coordinates = Vec::with_capacity(2 * buckets.len());
        for b in buckets.clone() {
            coordinates.push(self.coordinate(level - 1, 8 * b, 0).unwrap_or(f64::NAN));
            coordinates.push(self.coordinate(level - 1, 8 * b + 7, 1).unwrap_or(f64::NAN));
        }
        let rows = self.rows();
        let n = buckets.len();
        let mut values = vec![f32::NAN; 2 * n * rows];
        for block in 0..self.blocks.len() {
            for side in 0..2 {
                let from = if level == 1 { 0 } else { side };
                let Some(log) = self.log(block, level - 1, from) else { continue };
                for (page, range) in held(log, children.clone()) {
                    page.read(|stored| {
                        for e in range {
                            let bucket = (e / 8 - buckets.start) as usize;
                            let base = ((e - page.first) * page.per) as usize;
                            let out = side * n * rows + bucket * rows + block * PAGE_ROWS;
                            for (r, &v) in stored[base..base + page.per as usize].iter().enumerate() {
                                let o = &mut values[out + r];
                                *o = if side == 0 { o.min(v) } else { o.max(v) };
                            }
                        }
                    });
                }
            }
        }
        (coordinates, values, rows)
    }

    /// Rows the row blocks' pages hold values of.
    fn rows(&self) -> usize {
        let block_rows = |b: usize| self.blocks[b].iter().filter_map(|log| log.last().map(|p| p.per as usize)).max();
        (0..self.blocks.len())
            .rev()
            .find_map(|b| block_rows(b).filter(|&r| r > 0).map(|r| b * PAGE_ROWS + r))
            .unwrap_or(0)
    }

    /// `run`'s coordinates, and its values for rows `rows`, in that order, as
    /// [`insert`](Samples::insert) takes them.
    pub(crate) fn read(&self, run: &Run, rows: &[usize]) -> (Vec<f64>, Vec<f32>) {
        let per = coordinates(run.level);
        let n = run.entries.len();
        let mut at = Vec::with_capacity(n * per);
        for (page, range) in self.axis_pages(run.level, run.entries.clone()) {
            let (from, to) = ((range.start - page.first) as usize * per, (range.end - page.first) as usize * per);
            page.read(|c| at.extend_from_slice(&c[from..to]));
        }
        at.resize(n * per, f64::NAN);
        let sides = sides(run.level);
        let mut values = vec![f32::NAN; sides * n * rows.len()];
        // Rows by block, so each page is read once for all of a block's rows.
        let mut by_block: Vec<(usize, usize)> =
            rows.iter().enumerate().map(|(i, &row)| (row >> PAGE_BITS, i)).collect();
        by_block.sort_unstable();
        for group in by_block.chunk_by(|a, b| a.0 == b.0) {
            for side in 0..sides {
                for (page, range) in self.pages(group[0].0, run.level, side, run.entries.clone()) {
                    page.read(|stored| {
                        for e in range {
                            let base = ((e - page.first) * page.per) as usize;
                            let out = side * n * rows.len() + (e - run.entries.start) as usize * rows.len();
                            for &(_, i) in group {
                                let local = rows[i] & PAGE_MASK;
                                if local < page.per as usize {
                                    values[out + i] = stored[base + local];
                                }
                            }
                        }
                    });
                }
            }
        }
        (at, values)
    }

    /// Forgets frames before coordinate `before`; pages that hold only forgotten entries drop. True
    /// when anything was forgotten.
    pub(crate) fn forget(&mut self, before: f64) -> bool {
        let first = self.bound(before, false).min(self.end);
        if first <= self.start {
            return false;
        }
        (self.start, self.forgotten) = (first, first);
        let mut logs = self.logs(0);
        for (level, log) in logs.axes.iter_mut().enumerate() {
            forget_before(log, first >> (3 * level));
        }
        for block in &mut logs.blocks {
            for (s, log) in block.iter_mut().enumerate() {
                forget_before(log, first >> (3 * s.div_ceil(2)));
            }
        }
        self.keep(logs);
        true
    }

    /// How many entries of `level` lie before `at` (with `past`, at it too), each by its coordinate
    /// `which`: by its last (1), those wholly before; by its first (0), those begun before. Where the
    /// entries held of the level settle it; else where the hole holding `at` starts.
    fn locate(&self, level: u32, at: f64, past: bool, which: u32) -> std::result::Result<u32, u32> {
        let before = |t: f64| if past { t <= at } else { t < at };
        let visible = self.visible(level);
        let Some(log) = self.axes.get(level as usize) else { return Err(visible.start) };
        let pages = held(log, visible.clone());
        // The first page whose last entry does not lie before `at`.
        let i = pages.partition_point(|(p, r)| p.coordinate(r.end - 1, which).is_some_and(before));
        let gap = if i == 0 { visible.start } else { pages[i - 1].1.end };
        let Some((page, range)) = pages.get(i) else {
            return if gap == visible.end { Ok(gap) } else { Err(gap) };
        };
        let per = page.per as usize;
        let edge = (which as usize).min(per - 1);
        let n = page.read(|c| {
            let entries = &c[(range.start - page.first) as usize * per..(range.end - page.first) as usize * per];
            entries.chunks(per).map(|e| e[edge]).collect::<Vec<f64>>().partition_point(|&t| before(t))
        }) as u32;
        if n > 0 || range.start == gap { Ok(range.start + n) } else { Err(gap) }
    }

    /// The frames before `at`, or with `past` at or before it: frames where held, else the whole
    /// buckets before it of the finest level held there. Where no level settles it, where the hole
    /// holding it starts.
    pub(crate) fn bound(&self, at: f64, past: bool) -> u32 {
        let mut hole = None;
        for level in 0..self.axes.len() as u32 {
            match self.locate(level, at, past, 1) {
                Ok(n) => return n.saturating_mul(bucket_frames(level)).clamp(self.start, self.end),
                Err(gap) if first_held(&self.axes[level as usize], self.visible(level)).is_some() => {
                    hole = Some(gap.saturating_mul(bucket_frames(level)));
                }
                Err(_) => {}
            }
        }
        hole.unwrap_or(self.start).clamp(self.start, self.end)
    }

    /// The frames at or before `at`, as finely as the finest level settling it tells: where frames
    /// are held, exactly; else the whole buckets at or before it and as far into the next as `at` lies
    /// between its first and last frame's coordinates.
    fn position(&self, at: f64) -> Option<f64> {
        (0..self.axes.len() as u32).find_map(|level| {
            let n = self.locate(level, at, true, 1).ok()?;
            let into = match (self.coordinate(level, n, 0), self.coordinate(level, n, 1)) {
                (Some(first), Some(last)) if level > 0 && first <= at && first < last => (at - first) / (last - first),
                _ => 0.0,
            };
            Some((f64::from(n) + into) * f64::from(bucket_frames(level)))
        })
    }

    /// The frames a trace across `across` draws: from the last frame at or before its start through
    /// the first after its end, as finely as what is held tells.
    pub(crate) fn across(&self, [x0, x1]: [f64; 2]) -> Range<u32> {
        let (Some(a), Some(b)) = (self.position(x0), self.position(x1)) else { return self.start..self.end };
        let first = (a.floor() as u32).saturating_sub(1).max(self.start);
        let last = (b.ceil() as u32).saturating_add(1).min(self.end);
        first..last.max(first)
    }

    /// The first frame held from `frame` on, of any level: where a hole ends.
    fn next_held(&self, frame: u32) -> Option<u32> {
        let mut next: Option<u32> = None;
        for (level, log) in self.axes.iter().enumerate() {
            let (span, visible) = (bucket_frames(level as u32), self.visible(level as u32));
            if let Some(entry) = first_held(log, (frame / span).max(visible.start)..visible.end) {
                let at = (entry * span).max(frame);
                next = Some(next.map_or(at, |n| n.min(at)));
            }
        }
        next
    }

    /// What covers frames `frames`, left to right: `(level, index)`, the coarsest held bucket that fits
    /// at each step, or a held frame as level 0; where neither does, the finest held bucket holding the
    /// frame stands in, reaching past the frames. Frames nothing holds are skipped.
    pub(crate) fn pieces(&self, frames: Range<u32>) -> Vec<(u32, u32)> {
        let mut pieces = Vec::new();
        let (mut f, end) = (frames.start.max(self.start), frames.end.min(self.end));
        while f < end {
            let fits = (1..=LEVELS).rev().find(|&k| {
                let span = bucket_frames(k);
                f.is_multiple_of(span) && f.saturating_add(span) <= end && self.held(k, f / span)
            });
            if let Some(k) = fits {
                pieces.push((k, f / bucket_frames(k)));
                f += bucket_frames(k);
            } else if self.held(0, f) {
                pieces.push((0, f));
                f += 1;
            } else if let Some(k) = (1..=LEVELS).find(|&k| self.held(k, f / bucket_frames(k))) {
                let bucket = f / bucket_frames(k);
                pieces.push((k, bucket));
                f = (bucket + 1) * bucket_frames(k);
            } else {
                let Some(next) = self.next_held(f + 1) else { break };
                f = next;
            }
        }
        pieces
    }

    /// What draws frames `frames` at `level`, left to right: runs of that level's entries where held;
    /// else the nearest coarser level's entry holding them, standing in; else finer levels' entries.
    /// Frames nothing holds draw nothing.
    pub(crate) fn cover(&self, frames: Range<u32>, level: u32) -> Vec<Run> {
        let mut runs = Vec::new();
        let frames = frames.start.max(self.start)..frames.end.min(self.end);
        self.cover_into(frames, level.min(LEVELS), &mut runs);
        runs
    }

    fn cover_into(&self, frames: Range<u32>, level: u32, runs: &mut Vec<Run>) {
        let span = bucket_frames(level);
        let (mut e, last) = (frames.start / span, frames.end.div_ceil(span));
        let visible = self.visible(level);
        while e < last {
            let here = self.axes.get(level as usize).and_then(|log| {
                held(log, e.max(visible.start)..last.min(visible.end)).into_iter().next().map(|(_, r)| r)
            });
            if let Some(range) = here.filter(|r| r.start == e) {
                e = range.end;
                join(runs, Run { level, entries: range });
                continue;
            }
            let frame = (e * span).max(frames.start);
            if let Some(k) = (level + 1..=LEVELS).find(|&k| self.held(k, frame / bucket_frames(k))) {
                let bucket = frame / bucket_frames(k);
                join(runs, Run { level: k, entries: bucket..bucket + 1 });
                e = ((bucket + 1) * bucket_frames(k)).div_ceil(span);
                continue;
            }
            let entry_end = ((e + 1) * span).min(frames.end);
            match self.next_held(frame) {
                Some(next) if next < entry_end && level > 0 => {
                    self.cover_into(next..entry_end, level - 1, runs);
                    e += 1;
                }
                Some(next) => e = (next / span).max(e + 1),
                None => break,
            }
        }
    }

    /// Folds piece `(level, index)` of row block `block` into `extent`, a least and a greatest value per
    /// row of the block, NaN until one is read.
    pub(crate) fn fold(&self, block: usize, (level, index): (u32, u32), extent: &mut [[f32; 2]]) {
        if !self.held(level, index) {
            return;
        }
        for side in 0..sides(level) {
            let Some(page) = self.log(block, level, side).and_then(|log| holding(log, index)) else { continue };
            let base = ((index - page.first) * page.per) as usize;
            page.read(|values| {
                for (e, &v) in extent.iter_mut().zip(&values[base..base + page.per as usize]) {
                    if level == 0 || side == 0 {
                        e[0] = e[0].min(v);
                    }
                    if level == 0 || side == 1 {
                        e[1] = e[1].max(v);
                    }
                }
            });
        }
    }

    /// The last frame held at or before `at`.
    pub(crate) fn frame_at(&self, at: f64) -> Option<u32> {
        let frame = self.locate(0, at, true, 0).ok()?.checked_sub(1)?;
        self.held(0, frame).then_some(frame)
    }

    /// How far `at` lies from `frame` toward the next frame, in `0..=1`.
    pub(crate) fn t(&self, frame: u32, at: f64) -> f32 {
        match (self.at(frame), self.at(frame + 1)) {
            (Some(a), Some(b)) if b > a => ((at - a) / (b - a)).clamp(0.0, 1.0) as f32,
            _ => 0.0,
        }
    }

    /// The page holding `frame` of `block` and the word where the frame starts in it.
    pub(crate) fn cursor(&self, block: usize, frame: u32) -> Option<(FramePage, u32)> {
        if !self.held(0, frame) {
            return None;
        }
        let page = holding(self.log(block, 0, 0)?, frame)?;
        let base = (frame - page.first) * page.per;
        Some((page, base))
    }

    /// The pages of `block` holding any of `level`'s entries `entries`, each with those it holds:
    /// frames, or a bucket's least (`side` 0) or greatest (1) values.
    pub(crate) fn pages(
        &self,
        block: usize,
        level: u32,
        side: usize,
        entries: Range<u32>,
    ) -> Vec<(FramePage, Range<u32>)> {
        let visible = self.visible(level);
        let entries = entries.start.max(visible.start)..entries.end.min(visible.end);
        self.log(block, level, side).map_or_else(Vec::new, |log| held(log, entries))
    }

    /// The coordinate pages of `level` holding any of entries `entries`, each with those it holds.
    pub(crate) fn axis_pages(&self, level: u32, entries: Range<u32>) -> Vec<(AxisPage, Range<u32>)> {
        let visible = self.visible(level);
        let entries = entries.start.max(visible.start)..entries.end.min(visible.end);
        self.axes.get(level as usize).map_or_else(Vec::new, |log| held(log, entries))
    }

    /// The value of `row` in `frame`, or `None` when missing.
    pub(crate) fn value(&self, row: usize, frame: u32) -> Option<f64> {
        self.entry(row, 0, 0, frame)
    }

    /// The value of `row` at entry `index` of `level`: a frame's, or a bucket's least (`side` 0) or
    /// greatest (1); `None` when missing.
    pub(crate) fn entry(&self, row: usize, level: u32, side: usize, index: u32) -> Option<f64> {
        if !self.held(level, index) {
            return None;
        }
        let page = holding(self.log(row >> PAGE_BITS, level, side)?, index)?;
        let local = (row & PAGE_MASK) as u32;
        let value = (local < page.per).then(|| page.read(|v| v[((index - page.first) * page.per + local) as usize]))?;
        (!value.is_nan()).then_some(f64::from(value))
    }

    /// `frame`'s values for the first `rows` rows into `out`; rows the frame lacks are NaN.
    fn read_frame(&self, frame: u32, out: &mut [f32]) {
        out.fill(f32::NAN);
        let rows = out.len();
        for block in 0..rows.div_ceil(PAGE_ROWS) {
            let Some((page, base)) = self.cursor(block, frame) else { continue };
            let start = block * PAGE_ROWS;
            let n = (page.per as usize).min(rows - start);
            page.read(|v| out[start..start + n].copy_from_slice(&v[base as usize..base as usize + n]));
        }
    }

    /// The samples of rows `rows`, in that order, at every level.
    pub(crate) fn gather(&self, rows: &[usize]) -> Samples {
        self.gather_runs(rows, &self.runs(), self.start..self.end)
    }

    /// The samples of rows `rows`, in that order, over the frames of `frames` held: what a table drawn
    /// in part shows of them about one coordinate.
    pub(crate) fn gather_frames(&self, rows: &[usize], frames: Range<u32>) -> Samples {
        let start = frames.start.max(self.start);
        let frames = start..frames.end.min(self.end).max(start);
        let runs: Vec<Run> = self
            .runs()
            .into_iter()
            .filter(|r| r.level == 0)
            .map(|r| Run { level: 0, entries: r.entries.start.max(frames.start)..r.entries.end.min(frames.end) })
            .filter(|r| !r.entries.is_empty())
            .collect();
        self.gather_runs(rows, &runs, frames)
    }

    /// The samples of rows `rows` over `runs`, reading frames `frames`.
    fn gather_runs(&self, rows: &[usize], runs: &[Run], frames: Range<u32>) -> Samples {
        let mut gathered = Samples::from_frame(frames.start);
        for run in runs {
            let (at, values) = self.read(run, rows);
            gathered.insert(run, &at, &values, rows.len()).expect("runs held apart");
        }
        gathered.reads(frames);
        gathered
    }
}

/// After `frame` is appended to `logs`, writes each bucket it completes whose eight entries a level
/// below are all held, level by level: its first and last frame's coordinates, and per row block the
/// least of its entries' least values and the greatest of their greatest.
fn seal(logs: &mut Logs, frame: u32) {
    let next = frame + 1;
    for level in 1..=LEVELS {
        let span = bucket_frames(level);
        if !next.is_multiple_of(span) {
            break;
        }
        let bucket = next / span - 1;
        let children = bucket * 8..bucket * 8 + 8;
        let below = held(&logs.axes[level as usize - 1], children.clone());
        if below.iter().map(|(_, r)| r.len()).sum::<usize>() != 8 {
            break;
        }
        let first = below[0].0.coordinate(children.start, 0);
        let last = below[below.len() - 1].0.coordinate(children.end - 1, 1);
        let (Some(first), Some(last)) = (first, last) else { break };
        grow(&mut logs.axes[level as usize], bucket, &[first, last], FRAME_PAGE_WORDS / 2);
        for block in &mut logs.blocks {
            for side in 0..2 {
                let from = &block[slot(level - 1, if level == 1 { 0 } else { side })];
                let parts = held(from, children.clone());
                let Some(rows) = parts.iter().map(|(p, _)| p.per as usize).max() else { continue };
                let mut sealed = vec![f32::NAN; rows];
                for (page, range) in &parts {
                    page.read(|values| {
                        for e in range.clone() {
                            let base = ((e - page.first) * page.per) as usize;
                            for (out, &v) in sealed.iter_mut().zip(&values[base..base + page.per as usize]) {
                                *out = if side == 0 { out.min(v) } else { out.max(v) };
                            }
                        }
                    });
                }
                grow(&mut block[slot(level, side)], bucket, &sealed, FRAME_PAGE_WORDS);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_keep_each_buckets_least_and_greatest() {
        let mut samples = Samples::default();
        for t in 0..130 {
            let v = if t == 70 { -5.0 } else { f64::from(t) };
            samples.append(&[f64::from(t)], &Values::from(vec![v, 2.0 * v]), 2).expect("frame");
        }
        assert!(samples.held(1, 15) && !samples.held(1, 16), "130 frames seal 16 buckets of 8");
        assert!(samples.held(2, 1) && !samples.held(2, 2), "and 2 of 64");
        // Bucket 8 spans frames 64..72, where frame 70 dips to -5.
        assert_eq!(samples.entry(0, 1, 0, 8), Some(-5.0));
        assert_eq!(samples.entry(1, 1, 0, 8), Some(-10.0));
        assert_eq!(samples.entry(1, 1, 1, 8), Some(142.0));
        // Bucket 1 of level 2 spans frames 64..128.
        assert_eq!(samples.entry(1, 2, 0, 1), Some(-10.0));
        assert_eq!(samples.entry(0, 2, 1, 1), Some(127.0));
        assert_eq!(samples.coordinate(2, 1, 0), Some(64.0), "a bucket holds its first frame's coordinate");
        assert_eq!(samples.coordinate(2, 1, 1), Some(127.0), "and its last's");
        assert_eq!(samples.drawn_at(2, 1), Some(95.5), "and draws at their middle");
    }

    #[test]
    fn appends_read_back_by_coordinate() {
        let mut samples = Samples::default();
        samples.append(&[0.0, 1.0], &Values::from(vec![1.0_f64, 2.0, 3.0, 4.0]), 2).expect("frames");
        assert_eq!(samples.end(), 2);
        assert_eq!(samples.frame_at(0.5), Some(0));
        assert_eq!(samples.value(1, 1), Some(4.0));
        assert_eq!(samples.frame_at(-1.0), None);
        assert_eq!(samples.bound(0.5, false), 1);
        assert!(samples.append(&[0.5], &Values::from(vec![0.0_f64, 0.0]), 2).is_err());
    }

    #[test]
    fn newest_version_grows_in_place_and_older_versions_fork() {
        let mut newest = Samples::default();
        newest.append(&[0.0], &Values::from(vec![1.0_f64]), 1).expect("frame");
        let older = newest.clone();
        newest.append(&[1.0], &Values::from(vec![2.0_f64]), 1).expect("frame");
        let page = |s: &Samples| s.cursor(0, 0).expect("a page").0.id;
        assert_eq!(page(&newest), page(&older));
        let mut forked = older.clone();
        forked.append(&[2.0], &Values::from(vec![3.0_f64]), 1).expect("frame");
        assert_eq!(forked.value(0, 1), Some(3.0));
        assert_eq!(newest.value(0, 1), Some(2.0));
        assert_eq!(older.end(), 1);
        assert_eq!(older.value(0, 1), None, "a version reads only its own frames");
    }

    #[test]
    fn an_older_version_writing_past_its_end_keeps_the_newer_ones_frames_out() {
        let mut newest = Samples::default();
        newest.append(&[0.0, 1.0], &Values::from(vec![1.0_f64, 2.0]), 1).expect("frames");
        let mut older = newest.clone();
        newest.append(&[2.0, 3.0], &Values::from(vec![3.0_f64, 4.0]), 1).expect("frames");
        // The older version holds frames 0 and 1; frames 4 and 5 widen it past a hole at 2 and 3.
        older.insert(&Run { level: 0, entries: 4..6 }, &[4.0, 5.0], &[5.0, 6.0], 1).expect("a run");
        assert_eq!(older.value(0, 2), None, "the newer version's frame 2 is not the older one's");
        assert_eq!(older.value(0, 4), Some(5.0));
        assert_eq!(newest.value(0, 2), Some(3.0));
    }

    #[test]
    fn forgetting_keeps_frame_numbers_and_older_versions() {
        let rows = 4096;
        let mut samples = Samples::default();
        for t in 0..100 {
            samples.append(&[f64::from(t)], &Values::from(vec![t as f32; rows]), rows).expect("frame");
        }
        let older = samples.clone();
        let pages = |s: &Samples| s.blocks[0][0].read(<[FramePage]>::len);
        let before = pages(&samples);
        assert!(samples.forget(50.0));
        assert!(!samples.forget(50.0), "nothing more to forget");
        assert_eq!((samples.start(), samples.end()), (50, 100));
        assert_eq!(samples.value(7, 60), Some(60.0), "frames keep their numbers");
        assert_eq!(samples.at(49), None);
        assert!(pages(&samples) < before, "whole pages before the first kept frame drop");
        assert_eq!(older.value(7, 10), Some(10.0), "an older version still reads them");
        samples.append(&[100.0], &Values::from(vec![1.0_f32; rows]), rows).expect("frame");
        assert_eq!(samples.end(), 101);
        let run = Run { level: 0, entries: 10..11 };
        assert!(samples.insert(&run, &[10.0], &vec![0.0; rows], rows).is_err(), "frames forgotten stay so");
    }

    #[test]
    fn gather_keeps_each_rows_history() {
        let mut samples = Samples::default();
        samples.append(&[0.0, 1.0], &Values::from(vec![1.0_f64, 2.0, 3.0, 4.0]), 2).expect("frames");
        let gathered = samples.gather(&[1]);
        assert_eq!(gathered.value(0, 0), Some(2.0));
        assert_eq!(gathered.value(0, 1), Some(4.0));
        let one = samples.gather_frames(&[0], 1..2);
        assert_eq!((one.start(), one.end(), one.value(0, 1), one.value(0, 0)), (1, 2, Some(3.0), None));
    }

    /// Level 1 buckets 0..4 (frames 0..32) and the frames of bucket 1, of two rows.
    fn holed() -> (Samples, Run, Run) {
        let mut samples = Samples::default();
        let buckets = Run { level: 1, entries: 0..4 };
        let at: Vec<f64> = (0..4).flat_map(|b| [f64::from(b * 8), f64::from(b * 8 + 7)]).collect();
        let least: Vec<f32> = (0..4).flat_map(|b| [b as f32, -(b as f32)]).collect();
        let greatest: Vec<f32> = (0..4).flat_map(|b| [b as f32 + 10.0, 10.0 - b as f32]).collect();
        samples.insert(&buckets, &at, &[least, greatest].concat(), 2).expect("buckets");
        let frames = Run { level: 0, entries: 8..16 };
        let coordinates: Vec<f64> = (8..16).map(f64::from).collect();
        let values: Vec<f32> = (8..16).flat_map(|f| [f as f32, -(f as f32)]).collect();
        samples.insert(&frames, &coordinates, &values, 2).expect("frames");
        (samples, buckets, frames)
    }

    #[test]
    fn runs_fill_any_span_and_cover_draws_the_finest_held() {
        let (mut samples, buckets, frames) = holed();
        assert_eq!((samples.start(), samples.end()), (0, 32));
        let (at, values) = samples.read(&frames, &[0, 1]);
        assert!(samples.insert(&frames, &at, &values, 2).is_err(), "held already");
        assert_eq!(
            samples.cover(0..32, 0),
            vec![Run { level: 1, entries: 0..1 }, Run { level: 0, entries: 8..16 }, Run { level: 1, entries: 2..4 },],
            "frames where held, else the buckets standing in"
        );
        assert_eq!(samples.cover(0..32, 1), vec![buckets.clone()]);
        assert_eq!(samples.entry(1, 1, 1, 2), Some(8.0));
        assert_eq!(samples.value(0, 9), Some(9.0));
        assert_eq!(samples.frame_at(12.5), Some(12));
        assert_eq!(samples.frame_at(20.0), None, "frame 20 is not held");
        assert_eq!(samples.bound(20.0, false), 16, "past the frames, whole buckets count");
        assert_eq!(samples.pieces(0..32), vec![(1, 0), (1, 1), (1, 2), (1, 3)]);
        let read = samples.read(&buckets, &[0, 1]);
        let mut copy = Samples::default();
        copy.insert(&buckets, &read.0, &read.1, 2).expect("read back");
        assert_eq!(copy.entry(0, 1, 0, 3), Some(3.0));
        assert_eq!(samples.runs(), vec![frames.clone(), buckets.clone()]);
        let stored = vec![frames.clone(), Run { level: 1, entries: 0..1 }, Run { level: 1, entries: 2..4 }];
        assert_eq!(samples.stored_runs(), stored);
        samples.remove(&frames);
        assert!(!samples.held(0, 9), "a span let go of");
        assert_eq!(samples.cover(0..32, 0), vec![buckets]);
    }

    #[test]
    fn derived_buckets_follow_from_the_entries_below() {
        let mut samples = Samples::default();
        for t in 0..64 {
            samples.append(&[f64::from(t)], &Values::from(vec![f64::from(t % 10)]), 1).expect("frame");
        }
        let stored = samples.stored_runs();
        assert_eq!(stored, vec![Run { level: 0, entries: 0..64 }], "every bucket follows from the frames");
        let mut copy = Samples::from_frame(0);
        let (at, values) = samples.read(&stored[0], &[0]);
        copy.insert(&stored[0], &at, &values, 1).expect("frames");
        for level in 1..=LEVELS {
            copy.derive(level);
        }
        assert_eq!(copy.runs(), samples.runs());
        for b in 0..8 {
            assert_eq!(copy.entry(0, 1, 0, b), samples.entry(0, 1, 0, b));
            assert_eq!(copy.entry(0, 1, 1, b), samples.entry(0, 1, 1, b));
            assert_eq!(copy.coordinate(1, b, 1), samples.coordinate(1, b, 1));
        }
        assert_eq!(copy.entry(0, 2, 1, 0), Some(9.0));
    }

    #[test]
    fn appends_after_a_run_seal_only_whole_buckets() {
        let mut samples = Samples::default();
        let run = Run { level: 0, entries: 4..8 };
        samples.insert(&run, &[4.0, 5.0, 6.0, 7.0], &[1.0, 2.0, 3.0, 4.0], 1).expect("run");
        let at: Vec<f64> = (8..16).map(f64::from).collect();
        samples.append(&at, &Values::from(vec![5.0_f64; 8]), 1).expect("frames");
        assert!(!samples.held(1, 0), "frames 0..4 are missing");
        assert!(samples.held(1, 1));
        assert_eq!(samples.cover(0..16, 1), vec![run, Run { level: 1, entries: 1..2 }]);
    }
}
