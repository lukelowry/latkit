//! Samples: a field's values over the dataset's axis, stored as levels of detail.
//!
//! Level 0 holds frames: each row's value at one axis coordinate. Each level `k` above holds
//! buckets of `8^k` frames: each row's least and greatest value over the bucket. A long history can
//! then be drawn from about as many entries as there are pixels. Each level stores its entries in
//! pages together with their coordinates (a frame's own; a bucket's first and last frame's), so a
//! level can be drawn without the levels below it. Frames are numbered from the first ever
//! written, and a version reads frames `start..end`.
//!
//! Any entry may be missing. Appended frames grow the newest pages in place and write each bucket
//! whose eight entries one level below are all present. Runs of entries decoded from bytes or
//! fetched as time tiles can fill any range, regardless of what surrounds it. An entry is present
//! when its level's coordinate pages contain it: every write stores an entry's coordinates and
//! every row block's values together.

use std::ops::Range;
use std::sync::{Arc, PoisonError, RwLock};

use super::column::{PAGE_BITS, PAGE_MASK, PAGE_ROWS};
use super::name::PageId;
use super::values::Values;
use crate::{Error, Result};

/// Words in a frame page, which holds entries of one row block, entry-major. An axis page takes at
/// most as many words on the GPU, two per entry.
pub(crate) const FRAME_PAGE_WORDS: usize = 1 << 16;
/// Levels of detail that appends write above frames. Level `k` holds each row's least and greatest
/// value over buckets of `8^k` frames. Inserted runs can go higher, up to [`MAX_LEVEL`].
pub(crate) const LEVELS: u32 = 6;
/// The highest level the format allows: a bucket of `8^21 = 2^63` frames still fits a `u64`.
pub(crate) const MAX_LEVEL: u32 = 21;

/// The number of frames an entry of `level` covers: `8^level`.
pub(crate) fn bucket_frames(level: u32) -> u64 {
    1 << (3 * level)
}

/// The level of detail for drawing `frames` frames across `columns` pixel columns: frames (level
/// 0) while there are at most two per column, else the finest level with at most two buckets per
/// column.
pub(crate) fn detail(frames: u64, columns: u32) -> u32 {
    let needed = frames.div_ceil(2 * u64::from(columns.max(1)));
    if needed <= 1 { 0 } else { (1..=MAX_LEVEL).find(|&k| bucket_frames(k) >= needed).unwrap_or(MAX_LEVEL) }
}

/// Coordinates stored per entry of `level`: 1 for a frame, 2 for a bucket (its first and last
/// frame's).
pub(crate) fn coordinates(level: u32) -> usize {
    if level == 0 { 1 } else { 2 }
}

/// Values stored per row per entry of `level`: 1 for a frame, 2 for a bucket (least and greatest).
pub(crate) fn sides(level: u32) -> usize {
    if level == 0 { 1 } else { 2 }
}

/// The index, among a row block's logs, of the log holding `level`'s `side` values: 0 for frames,
/// then each level's least (`side` 0) and greatest (`side` 1).
fn slot(level: u32, side: usize) -> usize {
    if level == 0 { 0 } else { 2 * level as usize - 1 + side }
}

/// A range of entries of one level.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Run {
    pub(crate) level: u32,
    pub(crate) entries: Range<u64>,
}

impl Run {
    /// The number of entries. A run held in memory always fits in `usize`.
    pub(crate) fn len(&self) -> usize {
        usize::try_from(self.entries.end - self.entries.start).expect("run fits in memory")
    }

    /// The frames its entries cover.
    pub(crate) fn frames(&self) -> Range<u64> {
        let span = bucket_frames(self.level);
        self.entries.start.saturating_mul(span)..self.entries.end.saturating_mul(span)
    }

    /// Its coordinate count, and its value count for `rows` rows; `None` on overflow.
    pub(crate) fn sizes(&self, rows: usize) -> Option<(usize, usize)> {
        let n = usize::try_from(self.entries.end.checked_sub(self.entries.start)?).ok()?;
        Some((n.checked_mul(coordinates(self.level))?, n.checked_mul(rows)?.checked_mul(sides(self.level))?))
    }
}

/// Appends `run` to `runs`, merging it into the last run when it continues that run at the same
/// level.
fn join(runs: &mut Vec<Run>, run: Run) {
    match runs.last_mut() {
        Some(last) if last.level == run.level && last.entries.end == run.entries.start => {
            last.entries.end = run.entries.end;
        }
        _ => runs.push(run),
    }
}

/// A list shared between versions. Indices are absolute: a version reads items `start..end`, so
/// forgetting the oldest items never renumbers the rest.
///
/// The newest version appends to the shared list in place. Any other change (an older version
/// appending, or an item inserted or removed) first copies the items the version reads.
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

    /// Applies `f` to a private copy of the items this version reads.
    fn edit(&mut self, f: impl FnOnce(&mut Vec<T>)) {
        let mut items = self.read(<[T]>::to_vec);
        f(&mut items);
        self.end = self.start + items.len();
        self.items = Arc::new(RwLock::new(items));
        self.base = self.start;
    }

    /// Calls `f` with items `start..end`.
    pub(crate) fn read<R>(&self, f: impl FnOnce(&[T]) -> R) -> R {
        let items = self.items.read().unwrap_or_else(PoisonError::into_inner);
        f(&items[self.start - self.base..self.end - self.base])
    }

    pub(crate) fn last(&self) -> Option<T> {
        self.read(|items| items.last().cloned())
    }

    /// Stops reading items before absolute index `start`. Shared storage is left to the other
    /// versions; once the forgotten prefix exceeds a quarter of the kept items (plus 16), this
    /// version copies the items it keeps.
    pub(crate) fn forget(&mut self, start: usize) {
        self.start = start.clamp(self.start, self.end);
        if self.start - self.base > (self.end - self.start) / 4 + 16 {
            let kept = self.read(<[T]>::to_vec);
            self.items = Arc::new(RwLock::new(kept));
            self.base = self.start;
        }
    }
}

/// A page's storage, shared by every version that reads the page, and whether appends may grow it.
struct Store<T> {
    grows: bool,
    items: RwLock<Vec<T>>,
}

/// Consecutive entries of one level, `per` items each, entry-major. In a frame page the items are
/// a row block's frames or one side (least or greatest) of a level, and `per` is the block's row
/// count. In an axis page the items are a level's coordinates, and `per` is the coordinates per
/// entry. A page opened by an append grows in place while it is the newest version's last page. A
/// version reads at most `cap` entries, fewer than are stored when a newer version grew the page.
#[derive(Clone)]
pub(crate) struct Page<T> {
    pub(crate) id: PageId,
    pub(crate) first: u64,
    pub(crate) per: u32,
    cap: u32,
    store: Arc<Store<T>>,
}

/// A page of a row block's frames, or of a level's least or greatest values: `per` rows per entry.
pub(crate) type FramePage = Page<f32>;
/// A page of a level's coordinates, `per` per entry: a frame's own, or a bucket's first and last.
pub(crate) type AxisPage = Page<f64>;

impl<T: Copy> Page<T> {
    fn new(first: u64, per: usize, items: Vec<T>, grows: bool) -> Page<T> {
        Page {
            id: PageId::next(),
            first,
            per: per as u32,
            cap: u32::MAX,
            store: Arc::new(Store { grows, items: RwLock::new(items) }),
        }
    }

    /// Calls `f` with every stored item, which may include items past `cap`.
    pub(crate) fn read<R>(&self, f: impl FnOnce(&[T]) -> R) -> R {
        f(&self.store.items.read().unwrap_or_else(PoisonError::into_inner))
    }

    /// Whether appends may grow it. The GPU allocates such pages at full size so they can grow in
    /// place.
    pub(crate) fn grows(&self) -> bool {
        self.store.grows
    }

    /// The number of entries this version reads.
    pub(crate) fn len(&self) -> u32 {
        ((self.read(<[T]>::len) / self.per.max(1) as usize) as u32).min(self.cap)
    }

    pub(crate) fn end(&self) -> u64 {
        self.first + u64::from(self.len())
    }

    /// Appends `entry`'s `items` in place, returning whether it did. Succeeds only if the page
    /// grows, this version reads all of it and nothing newer is stored past it, `entry` directly
    /// follows the last entry, and the page stays within `limit` items.
    fn extend(&self, entry: u64, items: &[T], limit: usize) -> bool {
        if entry != self.end() {
            return false;
        }
        let mut stored = self.store.items.write().unwrap_or_else(PoisonError::into_inner);
        let at = (entry - self.first) as usize * self.per as usize;
        let fits = items.len() == self.per as usize && at + items.len() <= limit;
        if !self.store.grows || self.cap != u32::MAX || stored.len() != at || !fits {
            return false;
        }
        stored.extend_from_slice(items);
        true
    }

    /// A handle to the same page that reads only its first `len` entries.
    fn capped(&self, len: u32) -> Page<T> {
        Page { cap: len, ..self.clone() }
    }
}

impl AxisPage {
    /// Coordinate `which` of entry `index`: a frame's own, or a bucket's first (0) or last (1)
    /// frame's.
    fn coordinate(&self, index: u64, which: u32) -> Option<f64> {
        if index < self.first || index >= self.end() {
            return None;
        }
        let i = (index - self.first) as usize * self.per as usize + which.min(self.per - 1) as usize;
        self.read(|c| c.get(i).copied())
    }

    /// The coordinate at which entry `index` is drawn: a frame's own, or a bucket's midpoint.
    fn drawn(&self, index: u64) -> Option<f64> {
        Some(f64::midpoint(self.coordinate(index, 0)?, self.coordinate(index, 1)?))
    }

    /// The page's size in GPU words: each entry's drawn coordinate as a high and a low `f32`.
    pub(crate) fn words_len(&self) -> usize {
        2 * (self.read(<[f64]>::len) / self.per as usize)
    }

    /// The page's GPU words from word `from` on, so a growing page uploads only its new tail.
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

/// The page of `log` containing entry `index`, if any.
fn holding<T: Copy>(log: &Log<Page<T>>, index: u64) -> Option<Page<T>> {
    log.read(|pages| {
        let i = pages.partition_point(|p| p.first <= index).checked_sub(1)?;
        (index < pages[i].end()).then(|| pages[i].clone())
    })
}

/// The pages of `log` containing any of `entries`, in order, each with the range of `entries` it
/// contains. A page that stores entries past the next page's first entry (left by a fork) is cut
/// off at that entry.
fn held<T: Copy>(log: &Log<Page<T>>, entries: Range<u64>) -> Vec<(Page<T>, Range<u64>)> {
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

/// The first of `entries` that a page of `log` contains.
fn first_held<T: Copy>(log: &Log<Page<T>>, entries: Range<u64>) -> Option<u64> {
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

/// Inserts `page` into `log` in entry order. No page of `log` may contain its entries.
fn place<T: Copy>(log: &mut Log<Page<T>>, page: Page<T>) {
    let (at, tip) = log.read(|pages| {
        let at = pages.partition_point(|p| p.first < page.first);
        (at, at == pages.len())
    });
    if tip { log.push(page) } else { log.edit(|pages| pages.insert(at, page)) }
}

/// Caps the last page of `log` at entry `end`, so this version no longer reads entries a newer
/// version appended from `end` on. Called before this version writes past `end`.
fn cap<T: Copy>(log: &mut Log<Page<T>>, end: u64) {
    if log.last().is_some_and(|page| page.end() > end) {
        log.edit(|pages| {
            let last = pages.last_mut().expect("a last page");
            *last = last.capped(end.saturating_sub(last.first) as u32);
        });
    }
}

/// Removes the pages of `log` whose entries all lie within `entries`.
fn take_out<T: Copy>(log: &mut Log<Page<T>>, entries: &Range<u64>) {
    let (from, to) = log.read(|pages| {
        let from = pages.partition_point(|p| p.first < entries.start);
        (from, from + pages[from..].iter().take_while(|p| p.end() <= entries.end).count())
    });
    if to > from {
        log.edit(|pages| drop(pages.drain(from..to)));
    }
}

/// Forgets the pages of `log` whose entries all lie before entry `index`.
fn forget_before<T: Copy>(log: &mut Log<Page<T>>, index: u64) {
    let dropped = log.read(|pages| pages.partition_point(|p| p.end() <= index));
    let start = log.start;
    log.forget(start + dropped);
}

/// Writes `entry`'s `items` after the last entry of `log`: into the last page if it can grow and
/// has room within `limit` items, else into a new growable page.
fn grow<T: Copy>(log: &mut Log<Page<T>>, entry: u64, items: &[T], limit: usize) {
    if !log.last().is_some_and(|page| page.extend(entry, items, limit)) {
        log.push(Page::new(entry, items.len(), items.to_vec(), true));
    }
}

/// Writes `entries` of a level, `per` items each, as new fixed-size pages inserted in order, each
/// holding as many entries as fit in `limit` items.
fn put<T: Copy>(log: &mut Log<Page<T>>, entries: &Range<u64>, items: &[T], per: usize, limit: usize) {
    let step = (limit / per.max(1)).max(1);
    for (k, chunk) in items.chunks(step * per.max(1)).enumerate() {
        let first = entries.start + (k * step) as u64;
        place(log, Page::new(first, per, chunk.to_vec(), false));
    }
}

/// Writable copies of the logs: every level's coordinates, and each row block's value logs.
struct Logs {
    axes: Vec<Log<AxisPage>>,
    blocks: Vec<Vec<Log<FramePage>>>,
}

/// A sampled field's values over the axis: frames and the levels of detail above them, any of
/// which may have gaps. Values are stored per row block of [`PAGE_ROWS`] rows.
#[derive(Clone, Default)]
pub(crate) struct Samples {
    /// The frames this version reads, `start..end`, numbered from the first ever written.
    start: u64,
    end: u64,
    /// Frames before this were forgotten. Shared pages may still store some, and this version must
    /// not read them again.
    forgotten: u64,
    /// Per level from 0, its entries' coordinates. Empty until something is written.
    axes: Arc<[Log<AxisPage>]>,
    /// Per row block, its frames, then each level's least and greatest values.
    blocks: Arc<[Vec<Log<FramePage>>]>,
}

impl Samples {
    /// Empty samples whose first frame will be numbered `first`. Samples decoded from bytes or
    /// gathered from others start here, so their frames keep their numbers.
    pub(crate) fn from_frame(first: u64) -> Samples {
        Samples { start: first, end: first, ..Samples::default() }
    }

    /// The first frame this version reads.
    pub(crate) fn start(&self) -> u64 {
        self.start
    }

    /// One past the last frame.
    pub(crate) fn end(&self) -> u64 {
        self.end
    }

    /// Sets the frames this version reads to `frames`. Decoding calls it after inserting the runs,
    /// to restore the encoded frame range.
    pub(crate) fn reads(&mut self, frames: Range<u64>) {
        (self.start, self.end) = (frames.start, frames.end);
    }

    /// Samples with the same frame range but no entries: the base of a dataset written as time
    /// tiles.
    pub(crate) fn emptied(&self) -> Samples {
        let mut empty = Samples::from_frame(self.start);
        empty.reads(self.start..self.end);
        empty
    }

    /// The entries of `level` this version reads: from the entry containing frame `start` through
    /// the last entry that ends by frame `end`.
    fn visible(&self, level: u32) -> Range<u64> {
        let k = 3 * level;
        self.start >> k..self.end >> k
    }

    /// Writable copies of the logs, covering at least levels 0 through [`LEVELS`] and `blocks` row
    /// blocks.
    fn logs(&self, blocks: usize) -> Logs {
        self.logs_at(blocks, LEVELS)
    }

    /// The highest level with stored pages. The binary format records it rather than assuming
    /// [`LEVELS`], which only bounds the levels appends write.
    pub(crate) fn levels(&self) -> u32 {
        self.axes.iter().rposition(|log| log.read(|pages| !pages.is_empty())).unwrap_or(0) as u32
    }

    fn logs_at(&self, blocks: usize, level: u32) -> Logs {
        let levels = (level as usize + 1).max(self.axes.len());
        let slots = 1 + 2 * levels.saturating_sub(1);
        let mut axes = self.axes.to_vec();
        axes.resize_with(levels, Log::default);
        let mut all = self.blocks.to_vec();
        all.resize_with(blocks.max(all.len()), Vec::new);
        for block in &mut all {
            block.resize_with(slots, Log::default);
        }
        Logs { axes, blocks: all }
    }

    fn keep(&mut self, logs: Logs) {
        self.axes = logs.axes.into();
        self.blocks = logs.blocks.into();
    }

    /// The log of row block `block` holding `level`'s `side` values.
    fn log(&self, block: usize, level: u32, side: usize) -> Option<&Log<FramePage>> {
        self.blocks.get(block)?.get(slot(level, side))
    }

    /// The coordinate page of `level` containing entry `index`, if this version reads that entry
    /// and it is present.
    fn axis_page(&self, level: u32, index: u64) -> Option<AxisPage> {
        if !self.visible(level).contains(&index) {
            return None;
        }
        holding(self.axes.get(level as usize)?, index)
    }

    /// Whether no entry of any level is present.
    pub(crate) fn is_empty(&self) -> bool {
        self.axes.iter().enumerate().all(|(level, log)| first_held(log, self.visible(level as u32)).is_none())
    }

    /// Whether entry `index` of `level` is present.
    pub(crate) fn held(&self, level: u32, index: u64) -> bool {
        self.axis_page(level, index).is_some()
    }

    /// Coordinate `which` of entry `index` of `level`: a frame's own, or a bucket's first (0) or
    /// last (1) frame's.
    pub(crate) fn coordinate(&self, level: u32, index: u64, which: u32) -> Option<f64> {
        self.axis_page(level, index)?.coordinate(index, which)
    }

    /// The coordinate at which entry `index` of `level` is drawn: a frame's own, or a bucket's
    /// midpoint.
    pub(crate) fn drawn_at(&self, level: u32, index: u64) -> Option<f64> {
        self.axis_page(level, index)?.drawn(index)
    }

    /// The coordinate of `frame`, if present.
    pub(crate) fn at(&self, frame: u64) -> Option<f64> {
        self.coordinate(0, frame, 0)
    }

    /// The runs of present entries, level by level, each run as long as its entries are contiguous.
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

    /// The runs the binary format stores: every present run, minus the buckets whose eight entries
    /// one level below are all present, since decoding derives those.
    pub(crate) fn stored_runs(&self) -> Vec<Run> {
        let runs = self.runs();
        let mut stored = Vec::new();
        for run in &runs {
            if run.level == 0 {
                stored.push(run.clone());
                continue;
            }
            // Buckets derivable from the runs one level below, in order; this run omits them.
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

    /// The first and last coordinates of the entries this version reads, across all levels.
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

    /// The coordinate of the last frame, or if that frame is missing, the end of the span across
    /// all levels.
    fn last_coordinate(&self) -> Option<f64> {
        self.end.checked_sub(1).and_then(|f| self.at(f)).or_else(|| self.span().map(|s| s[1]))
    }

    /// Appends frames: `values` holds `at.len()` frames of `rows` values each, frame-major. Errors
    /// on a length mismatch, a non-finite coordinate, or a coordinate below the last one.
    pub(crate) fn append(&mut self, at: &[f64], values: &Values, rows: usize) -> Result<()> {
        if at.len().checked_mul(rows) != Some(values.len()) {
            return Err(Error::invalid(format!("{} values for {} frames of {rows} rows", values.len(), at.len())));
        }
        self.end.checked_add(at.len() as u64).ok_or_else(|| Error::invalid("too many frames"))?;
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

    /// Appends frames for some rows: `values` holds `at.len()` frames of one value per row in
    /// `rows`, frame-major. The other rows of `total` repeat their value from the last frame, or
    /// are missing if there is none.
    pub(crate) fn append_rows(&mut self, at: &[f64], values: &Values, rows: &[usize], total: usize) -> Result<()> {
        let given = rows.len();
        if at.len().checked_mul(given) != Some(values.len()) {
            return Err(Error::invalid(format!("{} values for {} frames of {given} rows", values.len(), at.len())));
        }
        let mut frame = vec![f32::NAN; total];
        if self.end > self.start {
            self.read_frame(self.end - 1, &mut frame);
        }
        let mut dense =
            Vec::with_capacity(at.len().checked_mul(total).ok_or_else(|| Error::invalid("too many values"))?);
        for f in 0..at.len() {
            for (k, &row) in rows.iter().enumerate() {
                let i = f * given + k;
                frame[row] = if values.is_valid(i) { values.number(i) as f32 } else { f32::NAN };
            }
            dense.extend_from_slice(&frame);
        }
        self.append(at, &Values::from(dense), total)
    }

    /// Inserts `run`, none of whose entries may be present yet: its `coordinates` ([`coordinates`]
    /// per entry) and its values for `rows` rows, entry-major. At level 0 that is one value per
    /// row; above, every entry's least values come first, then every entry's greatest. Frames the
    /// run covers outside this version's range extend the range.
    ///
    /// Errors if the level is above [`MAX_LEVEL`], the sizes do not match, the coordinates are not
    /// finite and non-decreasing, the run starts before forgotten frames, or an entry is present.
    pub(crate) fn insert(&mut self, run: &Run, coordinates: &[f64], values: &[f32], rows: usize) -> Result<()> {
        let level = run.level;
        if level > MAX_LEVEL {
            return Err(Error::invalid(format!("level {level} is above the highest level, {MAX_LEVEL}")));
        }
        let (per, sides) = (self::coordinates(level), sides(level));
        if run.entries.is_empty() || run.sizes(rows) != Some((coordinates.len(), values.len())) {
            return Err(Error::invalid(format!("wrong sizes for {} level-{level} entries and {rows} rows", run.len())));
        }
        if coordinates.iter().any(|c| !c.is_finite()) || coordinates.windows(2).any(|w| w[1] < w[0]) {
            return Err(Error::invalid("a run's coordinates must be finite and must not decrease"));
        }
        let frames = run.frames();
        if run.entries.end.checked_mul(bucket_frames(level)).is_none() {
            return Err(Error::invalid("the run ends past the largest frame number"));
        }
        if frames.start < self.forgotten {
            return Err(Error::invalid("the run starts at a forgotten frame"));
        }
        let visible = self.visible(level);
        let within = run.entries.start.max(visible.start)..run.entries.end.min(visible.end);
        if self.axes.get(level as usize).is_some_and(|log| first_held(log, within).is_some()) {
            return Err(Error::invalid(format!("entries {:?} of level {level} are already present", run.entries)));
        }
        let blocks = rows.div_ceil(PAGE_ROWS);
        let mut logs = self.logs_at(blocks, level);
        // Entries a newer version appended past this version's frames stay the newer version's.
        cap(&mut logs.axes[level as usize], visible.end);
        put(&mut logs.axes[level as usize], &run.entries, coordinates, per, FRAME_PAGE_WORDS / 2);
        let n = run.len();
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

    /// Removes the pages whose entries all lie within `run`, as when a time tile span is no longer
    /// needed.
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

    /// Writes each missing bucket of `level` whose eight entries one level below are all present.
    /// Decoding uses it to rebuild the buckets the binary format omits.
    pub(crate) fn derive(&mut self, level: u32) {
        let below: Vec<Run> = self.runs().into_iter().filter(|r| r.level + 1 == level).collect();
        for run in below {
            let buckets = run.entries.start.div_ceil(8)..run.entries.end / 8;
            for missing in self.missing(level, buckets) {
                let (coordinates, values, rows) = self.bucket_values(level, &missing);
                let run = Run { level, entries: missing };
                self.insert(&run, &coordinates, &values, rows).expect("only missing buckets are inserted");
            }
        }
    }

    /// The ranges of `entries` of `level` that are not present.
    fn missing(&self, level: u32, entries: Range<u64>) -> Vec<Range<u64>> {
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

    /// Computes buckets `buckets` of `level` from their eight entries one level below: their
    /// coordinates, their values in [`insert`](Samples::insert)'s layout, and the row count.
    fn bucket_values(&self, level: u32, buckets: &Range<u64>) -> (Vec<f64>, Vec<f32>, usize) {
        let children = buckets.start * 8..buckets.end * 8;
        let mut coordinates = Vec::with_capacity(2 * (buckets.end - buckets.start) as usize);
        for b in buckets.clone() {
            coordinates.push(self.coordinate(level - 1, 8 * b, 0).unwrap_or(f64::NAN));
            coordinates.push(self.coordinate(level - 1, 8 * b + 7, 1).unwrap_or(f64::NAN));
        }
        let rows = self.rows();
        let n = (buckets.end - buckets.start) as usize;
        let mut values = vec![f32::NAN; 2 * n * rows];
        for block in 0..self.blocks.len() {
            for side in 0..2 {
                let from = if level == 1 { 0 } else { side };
                let Some(log) = self.log(block, level - 1, from) else { continue };
                for (page, range) in held(log, children.clone()) {
                    page.read(|stored| {
                        for e in range {
                            let bucket = (e / 8 - buckets.start) as usize;
                            let base = ((e - page.first) * u64::from(page.per)) as usize;
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

    /// The number of rows the row blocks' pages store values for.
    fn rows(&self) -> usize {
        let block_rows = |b: usize| self.blocks[b].iter().filter_map(|log| log.last().map(|p| p.per as usize)).max();
        (0..self.blocks.len())
            .rev()
            .find_map(|b| block_rows(b).filter(|&r| r > 0).map(|r| b * PAGE_ROWS + r))
            .unwrap_or(0)
    }

    /// `run`'s coordinates, and its values for rows `rows` in that order, in
    /// [`insert`](Samples::insert)'s layout. Missing entries read as NaN.
    pub(crate) fn read(&self, run: &Run, rows: &[usize]) -> (Vec<f64>, Vec<f32>) {
        let per = coordinates(run.level);
        let n = run.len();
        let mut at = Vec::with_capacity(n * per);
        for (page, range) in self.axis_pages(run.level, run.entries.clone()) {
            let (from, to) = ((range.start - page.first) as usize * per, (range.end - page.first) as usize * per);
            page.read(|c| at.extend_from_slice(&c[from..to]));
        }
        at.resize(n * per, f64::NAN);
        let sides = sides(run.level);
        let mut values = vec![f32::NAN; sides * n * rows.len()];
        // Group rows by row block, so each page is read once for all of a block's rows.
        let mut by_block: Vec<(usize, usize)> =
            rows.iter().enumerate().map(|(i, &row)| (row >> PAGE_BITS, i)).collect();
        by_block.sort_unstable();
        for group in by_block.chunk_by(|a, b| a.0 == b.0) {
            for side in 0..sides {
                for (page, range) in self.pages(group[0].0, run.level, side, run.entries.clone()) {
                    page.read(|stored| {
                        for e in range {
                            let base = ((e - page.first) * u64::from(page.per)) as usize;
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

    /// Forgets frames before coordinate `before`, dropping pages that contain only forgotten
    /// entries. Returns whether anything was forgotten.
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

    /// Counts the entries of `level` before `at` (at or before it, with `past`), comparing each
    /// entry's coordinate `which`: its last (1) counts entries wholly before, its first (0) entries
    /// begun before. Returns `Ok(count)` when the present entries determine it, or `Err(start)`
    /// with the first entry of the gap containing `at`.
    fn locate(&self, level: u32, at: f64, past: bool, which: u32) -> std::result::Result<u64, u64> {
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
            let (mut lo, mut hi) = (0, entries.len() / per);
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                if before(entries[mid * per + edge]) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            lo
        }) as u64;
        if n > 0 || range.start == gap { Ok(range.start + n) } else { Err(gap) }
    }

    /// The number of frames before `at` (at or before it, with `past`), as an absolute frame index
    /// clamped to `start..=end`. Counts frames where present, elsewhere whole buckets of the finest
    /// level present. If no level determines it, returns where the gap containing `at` starts.
    pub(crate) fn bound(&self, at: f64, past: bool) -> u64 {
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

    /// The fractional number of frames at or before `at`, as precise as the finest level that
    /// determines it. Exact where frames are present; elsewhere, the whole buckets at or before
    /// `at`, plus the fraction of the next bucket given by where `at` lies between its first and
    /// last frame's coordinates.
    fn position(&self, at: f64) -> Option<f64> {
        (0..self.axes.len() as u32).find_map(|level| {
            let n = self.locate(level, at, true, 1).ok()?;
            let into = match (self.coordinate(level, n, 0), self.coordinate(level, n, 1)) {
                (Some(first), Some(last)) if level > 0 && first <= at && first < last => (at - first) / (last - first),
                _ => 0.0,
            };
            Some((n as f64 + into) * bucket_frames(level) as f64)
        })
    }

    /// The frames a trace over coordinates `across` draws: from the last frame at or before its
    /// start through the first frame after its end, as precisely as the present levels allow. All
    /// frames if either bound cannot be determined.
    pub(crate) fn across(&self, [x0, x1]: [f64; 2]) -> Range<u64> {
        let (Some(a), Some(b)) = (self.position(x0), self.position(x1)) else { return self.start..self.end };
        let first = (a.floor() as u64).saturating_sub(1).max(self.start);
        let last = (b.ceil() as u64).saturating_add(1).min(self.end);
        first..last.max(first)
    }

    /// The first frame from `frame` on that any level has present: where a gap ends.
    fn next_held(&self, frame: u64) -> Option<u64> {
        let mut next: Option<u64> = None;
        for (level, log) in self.axes.iter().enumerate() {
            let (span, visible) = (bucket_frames(level as u32), self.visible(level as u32));
            if let Some(entry) = first_held(log, (frame / span).max(visible.start)..visible.end) {
                let at = (entry * span).max(frame);
                next = Some(next.map_or(at, |n| n.min(at)));
            }
        }
        next
    }

    /// The entries covering frames `frames`, left to right, as `(level, index)`. Each step takes
    /// the coarsest present bucket that fits in the remaining frames, or a present frame (level 0).
    /// If neither exists, it takes the finest present bucket containing the frame, which can extend
    /// past `frames`. Frames no level has are skipped.
    pub(crate) fn pieces(&self, frames: Range<u64>) -> Vec<(u32, u64)> {
        let mut pieces = Vec::new();
        let (mut f, end) = (frames.start.max(self.start), frames.end.min(self.end));
        while f < end {
            let fits = (1..=self.levels()).rev().find(|&k| {
                let span = bucket_frames(k);
                f.is_multiple_of(span) && f.saturating_add(span) <= end && self.held(k, f / span)
            });
            if let Some(k) = fits {
                pieces.push((k, f / bucket_frames(k)));
                f += bucket_frames(k);
            } else if self.held(0, f) {
                pieces.push((0, f));
                f += 1;
            } else if let Some(k) = (1..=self.levels()).find(|&k| self.held(k, f / bucket_frames(k))) {
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

    /// The runs that draw frames `frames` at `level`, left to right: that level's entries where
    /// present; else, as a placeholder, the entry of the nearest coarser level that contains them;
    /// else finer levels' entries. Frames no level has are not drawn.
    pub(crate) fn cover(&self, frames: Range<u64>, level: u32) -> Vec<Run> {
        let mut runs = Vec::new();
        let frames = frames.start.max(self.start)..frames.end.min(self.end);
        self.cover_into(frames, level.min(self.levels()), &mut runs);
        runs
    }

    fn cover_into(&self, frames: Range<u64>, level: u32, runs: &mut Vec<Run>) {
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
            if let Some(k) = (level + 1..=self.levels()).find(|&k| self.held(k, frame / bucket_frames(k))) {
                let bucket = frame / bucket_frames(k);
                join(runs, Run { level: k, entries: bucket..bucket + 1 });
                e = (bucket + 1).saturating_mul(bucket_frames(k)).div_ceil(span);
                continue;
            }
            let entry_end = (e + 1).saturating_mul(span).min(frames.end);
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

    /// Folds piece `(level, index)` of row block `block` into `extent`, which holds a least and a
    /// greatest value per row of the block (NaN until a value is read).
    pub(crate) fn fold(&self, block: usize, (level, index): (u32, u64), extent: &mut [[f32; 2]]) {
        if !self.held(level, index) {
            return;
        }
        for side in 0..sides(level) {
            let Some(page) = self.log(block, level, side).and_then(|log| holding(log, index)) else { continue };
            let base = ((index - page.first) * u64::from(page.per)) as usize;
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

    /// The last frame at or before `at`. `None` if `at` lies before the first frame or in a gap in
    /// the frames.
    pub(crate) fn frame_at(&self, at: f64) -> Option<u64> {
        let frame = self.locate(0, at, true, 0).ok()?.checked_sub(1)?;
        self.held(0, frame).then_some(frame)
    }

    /// How far `at` lies from `frame` toward the next frame, in `0..=1`; 0 if the next frame is
    /// missing.
    pub(crate) fn t(&self, frame: u64, at: f64) -> f32 {
        match (self.at(frame), self.at(frame + 1)) {
            (Some(a), Some(b)) if b > a => ((at - a) / (b - a)).clamp(0.0, 1.0) as f32,
            _ => 0.0,
        }
    }

    /// The frame page of row block `block` containing `frame`, and the word offset where that
    /// frame starts in it.
    pub(crate) fn cursor(&self, block: usize, frame: u64) -> Option<(FramePage, u32)> {
        if !self.held(0, frame) {
            return None;
        }
        let page = holding(self.log(block, 0, 0)?, frame)?;
        let base = (frame - page.first) * u64::from(page.per);
        Some((page, base as u32))
    }

    /// The pages of row block `block` containing any of `level`'s `entries` that this version
    /// reads, each with the range it contains: frames, or buckets' least (`side` 0) or greatest (1)
    /// values.
    pub(crate) fn pages(
        &self,
        block: usize,
        level: u32,
        side: usize,
        entries: Range<u64>,
    ) -> Vec<(FramePage, Range<u64>)> {
        let visible = self.visible(level);
        let entries = entries.start.max(visible.start)..entries.end.min(visible.end);
        self.log(block, level, side).map_or_else(Vec::new, |log| held(log, entries))
    }

    /// The coordinate pages of `level` containing any of `entries` that this version reads, each
    /// with the range it contains.
    pub(crate) fn axis_pages(&self, level: u32, entries: Range<u64>) -> Vec<(AxisPage, Range<u64>)> {
        let visible = self.visible(level);
        let entries = entries.start.max(visible.start)..entries.end.min(visible.end);
        self.axes.get(level as usize).map_or_else(Vec::new, |log| held(log, entries))
    }

    /// The value of `row` in `frame`, or `None` when missing.
    pub(crate) fn value(&self, row: usize, frame: u64) -> Option<f64> {
        self.entry(row, 0, 0, frame)
    }

    /// The value of `row` at entry `index` of `level`: a frame's, or a bucket's least (`side` 0) or
    /// greatest (1); `None` when missing.
    pub(crate) fn entry(&self, row: usize, level: u32, side: usize, index: u64) -> Option<f64> {
        if !self.held(level, index) {
            return None;
        }
        let page = holding(self.log(row >> PAGE_BITS, level, side)?, index)?;
        let local = (row & PAGE_MASK) as u32;
        let value = (local < page.per)
            .then(|| page.read(|v| v[((index - page.first) * u64::from(page.per) + u64::from(local)) as usize]))?;
        (!value.is_nan()).then_some(f64::from(value))
    }

    /// Writes `frame`'s values for the first `out.len()` rows into `out`; rows without a value are
    /// NaN.
    fn read_frame(&self, frame: u64, out: &mut [f32]) {
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

    /// The samples of rows `rows` over `runs`, reading frames `frames`.
    fn gather_runs(&self, rows: &[usize], runs: &[Run], frames: Range<u64>) -> Samples {
        let mut gathered = Samples::from_frame(frames.start);
        for run in runs {
            let (at, values) = self.read(run, rows);
            gathered.insert(run, &at, &values, rows.len()).expect("runs do not overlap");
        }
        gathered.reads(frames);
        gathered
    }
}

/// After `frame` is appended to `logs`, writes each bucket it completes, level by level, while the
/// bucket's eight entries one level below are all present. A bucket stores its first and last
/// frame's coordinates and, per row block, the least of its entries' least values and the greatest
/// of their greatest values.
fn seal(logs: &mut Logs, frame: u64) {
    let next = frame + 1;
    for level in 1..=LEVELS {
        let span = bucket_frames(level);
        if !next.is_multiple_of(span) {
            break;
        }
        let bucket = next / span - 1;
        let children = bucket * 8..bucket * 8 + 8;
        let below = held(&logs.axes[level as usize - 1], children.clone());
        if below.iter().map(|(_, r)| (r.end - r.start) as usize).sum::<usize>() != 8 {
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
                            let base = ((e - page.first) * u64::from(page.per)) as usize;
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
        assert!(samples.held(1, 15) && !samples.held(1, 16), "130 frames complete 16 buckets of 8");
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
    fn an_older_version_writing_past_its_end_ignores_newer_frames() {
        let mut newest = Samples::default();
        newest.append(&[0.0, 1.0], &Values::from(vec![1.0_f64, 2.0]), 1).expect("frames");
        let mut older = newest.clone();
        newest.append(&[2.0, 3.0], &Values::from(vec![3.0_f64, 4.0]), 1).expect("frames");
        // The older version has frames 0 and 1; inserting frames 4 and 5 extends it, leaving a gap
        // at 2 and 3.
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
        assert!(samples.insert(&run, &[10.0], &vec![0.0; rows], rows).is_err(), "forgotten frames stay forgotten");
    }

    #[test]
    fn gather_keeps_each_rows_history() {
        let mut samples = Samples::default();
        samples.append(&[0.0, 1.0], &Values::from(vec![1.0_f64, 2.0, 3.0, 4.0]), 2).expect("frames");
        let gathered = samples.gather(&[1]);
        assert_eq!(gathered.value(0, 0), Some(2.0));
        assert_eq!(gathered.value(0, 1), Some(4.0));
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
    fn runs_fill_any_span_and_cover_draws_the_finest_stored() {
        let (mut samples, buckets, frames) = holed();
        assert_eq!((samples.start(), samples.end()), (0, 32));
        let (at, values) = samples.read(&frames, &[0, 1]);
        assert!(samples.insert(&frames, &at, &values, 2).is_err(), "already present");
        assert_eq!(
            samples.cover(0..32, 0),
            vec![Run { level: 1, entries: 0..1 }, Run { level: 0, entries: 8..16 }, Run { level: 1, entries: 2..4 },],
            "frames where stored, buckets elsewhere"
        );
        assert_eq!(samples.cover(0..32, 1), vec![buckets.clone()]);
        assert_eq!(samples.entry(1, 1, 1, 2), Some(8.0));
        assert_eq!(samples.value(0, 9), Some(9.0));
        assert_eq!(samples.frame_at(12.5), Some(12));
        assert_eq!(samples.frame_at(20.0), None, "frame 20 is not stored");
        assert_eq!(samples.bound(20.0, false), 16, "past the stored frames, bounds fall on whole buckets");
        assert_eq!(samples.pieces(0..32), vec![(1, 0), (1, 1), (1, 2), (1, 3)]);
        let read = samples.read(&buckets, &[0, 1]);
        let mut copy = Samples::default();
        copy.insert(&buckets, &read.0, &read.1, 2).expect("read back");
        assert_eq!(copy.entry(0, 1, 0, 3), Some(3.0));
        assert_eq!(samples.runs(), vec![frames.clone(), buckets.clone()]);
        let stored = vec![frames.clone(), Run { level: 1, entries: 0..1 }, Run { level: 1, entries: 2..4 }];
        assert_eq!(samples.stored_runs(), stored);
        samples.remove(&frames);
        assert!(!samples.held(0, 9), "a removed span is no longer stored");
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
    fn appends_after_a_run_seal_only_complete_buckets() {
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
