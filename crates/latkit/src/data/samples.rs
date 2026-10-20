use std::sync::{Arc, PoisonError, RwLock};

use super::column::{PAGE_BITS, PAGE_MASK, PAGE_ROWS};
use super::name::PageId;
use super::values::Values;
use crate::{Error, Result};

/// Words in a frame page: frames of one row block, frame-major. An axis page holds as many words.
pub(crate) const FRAME_PAGE_WORDS: usize = 1 << 16;
/// Levels of detail kept: level `k` holds each row's least and greatest value over buckets of `8^k`
/// frames.
pub(crate) const LEVELS: u32 = 6;

/// Frames a bucket of level `level` spans.
pub(crate) fn bucket_frames(level: u32) -> u32 {
    1 << (3 * level)
}

/// An append-only list shared between versions. Indices are absolute: a version reads items
/// `start..end`, so forgetting the oldest never renumbers the rest.
///
/// A version that appends while it is the newest grows the shared list in place; an older version
/// that appends forks a copy of what it reads.
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
    /// An empty list whose first item will be absolute index `first`.
    fn from(first: usize) -> Log<T> {
        Log { items: Arc::default(), base: first, start: first, end: first }
    }

    pub(crate) fn start(&self) -> usize {
        self.start
    }

    pub(crate) fn end(&self) -> usize {
        self.end
    }

    pub(crate) fn push(&mut self, item: T) {
        {
            let mut items = self.items.write().unwrap_or_else(PoisonError::into_inner);
            if self.base + items.len() == self.end {
                items.push(item);
                self.end += 1;
                return;
            }
        }
        let mut fork = self.read(<[T]>::to_vec);
        fork.push(item);
        self.items = Arc::new(RwLock::new(fork));
        self.base = self.start;
        self.end += 1;
    }

    /// Reads items `start..end`.
    pub(crate) fn read<R>(&self, f: impl FnOnce(&[T]) -> R) -> R {
        let items = self.items.read().unwrap_or_else(PoisonError::into_inner);
        f(&items[self.start - self.base..self.end - self.base])
    }

    /// The item at absolute index `i`.
    pub(crate) fn get(&self, i: usize) -> Option<T> {
        (self.start..self.end).contains(&i).then(|| self.read(|items| items[i - self.start].clone()))
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

/// Consecutive frames of one row block's samples, frame-major: `(frame - first) * rows + row`.
///
/// The newest version grows its open page in place, so the page keeps its id while its length grows;
/// a version only reads the frames it has.
#[derive(Clone)]
pub(crate) struct FramePage {
    pub(crate) id: PageId,
    pub(crate) first: u32,
    pub(crate) rows: u32,
    values: Arc<RwLock<Vec<f32>>>,
}

impl FramePage {
    fn new(first: u32, values: Vec<f32>, rows: u32) -> FramePage {
        FramePage { id: PageId::next(), first, rows, values: Arc::new(RwLock::new(values)) }
    }

    /// Appends `frame`'s values when this version is the page's tip and the frame fits.
    fn extend(&self, frame: u32, values: &[f32]) -> bool {
        let mut stored = self.values.write().unwrap_or_else(PoisonError::into_inner);
        let at = (frame - self.first) as usize * self.rows as usize;
        if values.len() != self.rows as usize || stored.len() != at || at + values.len() > FRAME_PAGE_WORDS {
            return false;
        }
        stored.extend_from_slice(values);
        true
    }

    /// Reads the page's stored words.
    pub(crate) fn read<R>(&self, f: impl FnOnce(&[f32]) -> R) -> R {
        f(&self.values.read().unwrap_or_else(PoisonError::into_inner))
    }
}

/// Consecutive frames' axis coordinates as a high and a low `f32` word each, as the GPU reads them.
/// It grows in place like a [`FramePage`].
#[derive(Clone)]
pub(crate) struct AxisPage {
    pub(crate) id: PageId,
    pub(crate) first: u32,
    words: Arc<RwLock<Vec<u32>>>,
}

impl AxisPage {
    fn new(first: u32, at: f64) -> AxisPage {
        AxisPage { id: PageId::next(), first, words: Arc::new(RwLock::new(split(at).to_vec())) }
    }

    fn extend(&self, frame: u32, at: f64) -> bool {
        let mut words = self.words.write().unwrap_or_else(PoisonError::into_inner);
        let i = (frame - self.first) as usize * 2;
        if words.len() != i || i + 2 > FRAME_PAGE_WORDS {
            return false;
        }
        words.extend(split(at));
        true
    }

    pub(crate) fn read<R>(&self, f: impl FnOnce(&[u32]) -> R) -> R {
        f(&self.words.read().unwrap_or_else(PoisonError::into_inner))
    }
}

fn split(x: f64) -> [u32; 2] {
    let hi = x as f32;
    [hi.to_bits(), ((x - f64::from(hi)) as f32).to_bits()]
}

/// A field's samples over the data's axis: one frame per coordinate, every row in each frame.
/// Frames are numbered from the first ever appended; a version reads frames `start()..end()`.
///
/// Each row block also keeps levels of detail: level `k` holds, per bucket of `8^k` frames, each
/// row's least value in one log of pages and its greatest in another, a value per row like frame
/// pages. A bucket is written once its last frame is, so level pages grow like frame pages and a long
/// history draws from as few buckets as there are pixels.
#[derive(Clone, Default)]
pub(crate) struct Samples {
    at: Log<f64>,
    axis: Log<AxisPage>,
    blocks: Arc<[Log<FramePage>]>,
    /// Per row block, per level from 1, its pages of buckets: least values, then greatest.
    levels: Arc<[Vec<[Log<FramePage>; 2]>]>,
}

impl Samples {
    /// No frames yet, the first to be appended numbered `first`: what samples read back from bytes or
    /// gathered from others start from, so their frames keep their numbers.
    pub(crate) fn from_frame(first: u32) -> Samples {
        Samples { at: Log::from(first as usize), ..Samples::default() }
    }

    /// The first frame this version reads.
    pub(crate) fn start(&self) -> u32 {
        self.at.start() as u32
    }

    /// One past the last frame.
    pub(crate) fn end(&self) -> u32 {
        self.at.end() as u32
    }

    /// The coordinate of `frame`, one this version reads.
    pub(crate) fn at(&self, frame: u32) -> f64 {
        self.at.get(frame as usize).expect("a frame this version reads")
    }

    /// The first and last coordinates.
    pub(crate) fn span(&self) -> Option<[f64; 2]> {
        self.at.read(|at| Some([*at.first()?, *at.last()?]))
    }

    /// Appends frames: `values` holds `at.len()` frames of `rows` values each, frame-major.
    pub(crate) fn append(&mut self, at: &[f64], values: &Values, rows: usize) -> Result<()> {
        if values.len() != at.len() * rows {
            return Err(Error::invalid(format!("{} values for {} frames of {rows} rows", values.len(), at.len())));
        }
        let mut last = self.at.last();
        for &t in at {
            if !t.is_finite() {
                return Err(Error::invalid("a frame's coordinate must be finite"));
            }
            if last.is_some_and(|last| t < last) {
                return Err(Error::invalid("frame coordinates must not decrease"));
            }
            last = Some(t);
        }
        let mut blocks: Vec<Log<FramePage>> = self.blocks.to_vec();
        blocks.resize_with(rows.div_ceil(PAGE_ROWS).max(blocks.len()), Log::default);
        let mut levels: Vec<Vec<[Log<FramePage>; 2]>> = self.levels.to_vec();
        levels.resize_with(blocks.len(), || (0..LEVELS).map(|_| [Log::default(), Log::default()]).collect());
        let mut frame_values = vec![0.0_f32; rows];
        for (f, &t) in at.iter().enumerate() {
            let frame = self.end();
            for (row, value) in frame_values.iter_mut().enumerate() {
                let i = f * rows + row;
                *value = if values.is_valid(i) { values.number(i) as f32 } else { f32::NAN };
            }
            for (b, block) in blocks.iter_mut().enumerate().take(rows.div_ceil(PAGE_ROWS)) {
                let slice = &frame_values[b * PAGE_ROWS..rows.min((b + 1) * PAGE_ROWS)];
                if !block.last().is_some_and(|page| page.extend(frame, slice)) {
                    block.push(FramePage::new(frame, slice.to_vec(), slice.len() as u32));
                }
                seal(block, &mut levels[b], frame);
            }
            if !self.axis.last().is_some_and(|page| page.extend(frame, t)) {
                self.axis.push(AxisPage::new(frame, t));
            }
            self.at.push(t);
        }
        self.blocks = blocks.into();
        self.levels = levels.into();
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
        if self.end() > self.start() {
            self.read_frame(self.end() - 1, &mut frame);
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

    /// The pages of `block`'s level `level` holding buckets `buckets`: of least values for `which` 0,
    /// of greatest for 1.
    pub(crate) fn level_pages(
        &self,
        block: usize,
        level: u32,
        which: usize,
        buckets: std::ops::Range<u32>,
    ) -> Vec<FramePage> {
        let Some(log) = self.levels.get(block).and_then(|l| Some(&l.get(level as usize - 1)?[which])) else {
            return Vec::new();
        };
        log.read(|pages| {
            let from = pages.partition_point(|p| p.first <= buckets.start).saturating_sub(1);
            pages[from..].iter().take_while(|p| p.first < buckets.end).cloned().collect()
        })
    }

    /// Buckets of level `level` written in every row block: one past the last.
    pub(crate) fn sealed(&self, level: u32) -> u32 {
        self.levels
            .iter()
            .filter_map(|l| {
                l.get(level as usize - 1)?[0].last().map(|p| p.first + p.read(<[f32]>::len) as u32 / p.rows)
            })
            .min()
            .unwrap_or(0)
    }

    /// Forgets frames before coordinate `before`; pages that hold only forgotten frames drop. True
    /// when anything was forgotten.
    pub(crate) fn forget(&mut self, before: f64) -> bool {
        let first = self.at.start() + self.at.read(|at| at.partition_point(|&t| t < before));
        if first == self.at.start() {
            return false;
        }
        self.at.forget(first);
        let first = first as u32;
        let dropped = self.axis.read(|pages| pages.partition_point(|p| p.first <= first).saturating_sub(1));
        self.axis.forget(self.axis.start() + dropped);
        let mut blocks: Vec<Log<FramePage>> = self.blocks.to_vec();
        for block in &mut blocks {
            let dropped = block.read(|pages| pages.partition_point(|p| p.first <= first).saturating_sub(1));
            block.forget(block.start() + dropped);
        }
        self.blocks = blocks.into();
        let mut levels: Vec<Vec<[Log<FramePage>; 2]>> = self.levels.to_vec();
        for block in &mut levels {
            for (k, logs) in block.iter_mut().enumerate() {
                let bucket = first / bucket_frames(k as u32 + 1);
                for log in logs {
                    let dropped = log.read(|pages| pages.partition_point(|p| p.first <= bucket).saturating_sub(1));
                    log.forget(log.start() + dropped);
                }
            }
        }
        self.levels = levels.into();
        true
    }

    /// Buckets of each level from 1 written in every row block.
    pub(crate) fn sealed_levels(&self) -> [u32; LEVELS as usize] {
        std::array::from_fn(|k| self.sealed(k as u32 + 1))
    }

    /// The frames from the first at or after `at`, or after it with `past`.
    pub(crate) fn bound(&self, at: f64, past: bool) -> u32 {
        self.start() + self.at.read(|c| c.partition_point(|&t| if past { t <= at } else { t < at })) as u32
    }

    /// What covers frames `frames`, left to right: `(level, index)`, the coarsest written bucket
    /// that fits at each step, or a frame as level 0.
    pub(crate) fn pieces(&self, frames: std::ops::Range<u32>, sealed: &[u32; LEVELS as usize]) -> Vec<(u32, u32)> {
        let mut pieces = Vec::new();
        let (mut f, end) = (frames.start.max(self.start()), frames.end.min(self.end()));
        while f < end {
            let level = (1..=LEVELS)
                .rev()
                .find(|&k| {
                    let span = bucket_frames(k);
                    f.is_multiple_of(span) && f.saturating_add(span) <= end && f / span < sealed[k as usize - 1]
                })
                .unwrap_or(0);
            pieces.push((level, f / bucket_frames(level)));
            f += bucket_frames(level);
        }
        pieces
    }

    /// Folds piece `(level, index)` of row block `block` into `extent`, a least and a greatest
    /// value per row of the block, NaN until one is read.
    pub(crate) fn fold(&self, block: usize, (level, index): (u32, u32), extent: &mut [[f32; 2]]) {
        let logs: &[Log<FramePage>] = if level == 0 {
            self.blocks.get(block).map(std::slice::from_ref).unwrap_or_default()
        } else {
            self.levels.get(block).and_then(|l| l.get(level as usize - 1)).map_or(&[], |logs| &logs[..])
        };
        for (which, log) in logs.iter().enumerate() {
            let Some((page, base)) = frame_page(log, index) else { continue };
            page.read(|values| {
                for (e, &v) in extent.iter_mut().zip(&values[base as usize..(base + page.rows) as usize]) {
                    if level == 0 || which == 0 {
                        e[0] = e[0].min(v);
                    }
                    if level == 0 || which == 1 {
                        e[1] = e[1].max(v);
                    }
                }
            });
        }
    }

    /// The last frame at or before `at`.
    pub(crate) fn frame_at(&self, at: f64) -> Option<u32> {
        let after = self.at.read(|coordinates| coordinates.partition_point(|&t| t <= at));
        after.checked_sub(1).map(|i| (i + self.at.start()) as u32)
    }

    /// The first frame at or after `at`, or the last frame.
    pub(crate) fn frame_from(&self, at: f64) -> Option<u32> {
        let count = self.end() - self.start();
        let i = self.at.read(|coordinates| coordinates.partition_point(|&t| t < at)) as u32;
        (count > 0).then(|| self.start() + i.min(count - 1))
    }

    /// How far `at` lies from `frame` toward the next frame, in `0..=1`.
    pub(crate) fn t(&self, frame: u32, at: f64) -> f32 {
        match (self.at.get(frame as usize), self.at.get(frame as usize + 1)) {
            (Some(a), Some(b)) if b > a => ((at - a) / (b - a)).clamp(0.0, 1.0) as f32,
            _ => 0.0,
        }
    }

    /// The page holding `frame` of `block` and the word where the frame starts in it.
    pub(crate) fn cursor(&self, block: usize, frame: u32) -> Option<(FramePage, u32)> {
        if frame < self.start() || frame >= self.end() {
            return None;
        }
        self.blocks.get(block)?.read(|pages| {
            let i = pages.partition_point(|page| page.first <= frame).checked_sub(1)?;
            let page = &pages[i];
            Some((page.clone(), (frame - page.first) * page.rows))
        })
    }

    /// The pages of `block` holding frames `frames`.
    pub(crate) fn frame_pages(&self, block: usize, frames: std::ops::Range<u32>) -> Vec<FramePage> {
        let Some(block) = self.blocks.get(block) else { return Vec::new() };
        block.read(|pages| {
            let from = pages.partition_point(|p| p.first <= frames.start).saturating_sub(1);
            pages[from..].iter().take_while(|p| p.first < frames.end).cloned().collect()
        })
    }

    /// The axis pages holding frames `frames`.
    pub(crate) fn axis_pages(&self, frames: std::ops::Range<u32>) -> Vec<AxisPage> {
        self.axis.read(|pages| {
            let from = pages.partition_point(|p| p.first <= frames.start).saturating_sub(1);
            pages[from..].iter().take_while(|p| p.first < frames.end).cloned().collect()
        })
    }

    /// The value of `row` in `frame`, or `None` when missing.
    pub(crate) fn value(&self, row: usize, frame: u32) -> Option<f64> {
        let (page, base) = self.cursor(row >> PAGE_BITS, frame)?;
        let local = (row & PAGE_MASK) as u32;
        let value = (local < page.rows).then(|| page.read(|v| v[(base + local) as usize]))?;
        (!value.is_nan()).then_some(f64::from(value))
    }

    /// `frame`'s values for the first `rows` rows into `out`; rows the frame lacks are NaN.
    fn read_frame(&self, frame: u32, out: &mut [f32]) {
        out.fill(f32::NAN);
        let rows = out.len();
        for block in 0..rows.div_ceil(PAGE_ROWS) {
            let Some((page, base)) = self.cursor(block, frame) else { continue };
            let start = block * PAGE_ROWS;
            let n = (page.rows as usize).min(rows - start);
            page.read(|v| out[start..start + n].copy_from_slice(&v[base as usize..base as usize + n]));
        }
    }

    /// Every frame's values for `rows` rows, frame-major, missing as NaN.
    pub(crate) fn frames_of(&self, rows: usize) -> Vec<f32> {
        let mut out = vec![f32::NAN; (self.end() - self.start()) as usize * rows];
        if rows > 0 {
            for (i, chunk) in out.chunks_exact_mut(rows).enumerate() {
                self.read_frame(self.start() + i as u32, chunk);
            }
        }
        out
    }

    /// The samples of rows `rows`, in that order, over every frame.
    pub(crate) fn gather(&self, rows: &[usize]) -> Samples {
        self.gather_frames(rows, self.start()..self.end())
    }

    /// The samples of rows `rows`, in that order, over those of `frames` this version reads: what a
    /// table drawn in part shows of them about one coordinate.
    pub(crate) fn gather_frames(&self, rows: &[usize], frames: std::ops::Range<u32>) -> Samples {
        let frames = frames.start.max(self.start())..frames.end.min(self.end());
        let mut gathered = Samples::from_frame(frames.start);
        let width = rows.iter().max().map_or(0, |&r| r + 1);
        let mut frame_values = vec![0.0; width];
        for frame in frames {
            self.read_frame(frame, &mut frame_values);
            let picked: Vec<f32> = rows.iter().map(|&r| frame_values[r]).collect();
            gathered.append(&[self.at(frame)], &Values::from(picked), rows.len()).expect("valid frames");
        }
        gathered
    }
}

/// After `frame` is written to `block`, writes every bucket it completes, level by level: level 1
/// from frames, each level above from the eight buckets below it, the least of their least values
/// and the greatest of their greatest.
fn seal(block: &Log<FramePage>, levels: &mut [[Log<FramePage>; 2]], frame: u32) {
    let next = frame + 1;
    for level in 1..=LEVELS {
        let span = bucket_frames(level);
        if !next.is_multiple_of(span) {
            break;
        }
        let bucket = next / span - 1;
        let first = bucket * 8;
        for which in [0, 1] {
            let parts: Vec<(FramePage, u32)> = if level == 1 {
                (first..first + 8).filter_map(|f| frame_page(block, f)).collect()
            } else {
                let below = &levels[level as usize - 2][which];
                (first..first + 8).filter_map(|b| frame_page(below, b)).collect()
            };
            let Some((page, _)) = parts.first() else { return };
            let rows = page.rows as usize;
            let mut sealed = vec![f32::NAN; rows];
            for (page, base) in &parts {
                page.read(|values| {
                    for (row, out) in sealed.iter_mut().enumerate() {
                        let v = values.get(*base as usize + row).copied().unwrap_or(f32::NAN);
                        *out = if which == 0 { out.min(v) } else { out.max(v) };
                    }
                });
            }
            let log = &mut levels[level as usize - 1][which];
            if !log.last().is_some_and(|page| page.extend(bucket, &sealed)) {
                log.push(FramePage::new(bucket, sealed, rows as u32));
            }
        }
    }
}

/// The page holding entry `index` of `log` (a frame, or a bucket of a level), and where it starts.
fn frame_page(log: &Log<FramePage>, index: u32) -> Option<(FramePage, u32)> {
    log.read(|pages| {
        let i = pages.partition_point(|page| page.first <= index).checked_sub(1)?;
        let page = &pages[i];
        let base = (index - page.first) * page.rows;
        (page.read(<[f32]>::len) as u32 >= base + page.rows).then(|| (page.clone(), base))
    })
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
        assert_eq!(samples.sealed(1), 16, "130 frames seal 16 buckets of 8");
        assert_eq!(samples.sealed(2), 2, "and 2 of 64");
        let least = &samples.level_pages(0, 1, 0, 8..9)[0];
        let greatest = &samples.level_pages(0, 1, 1, 8..9)[0];
        let at = (8 - least.first) as usize * 2;
        // Bucket 8 spans frames 64..72, where frame 70 dips to -5.
        least.read(|v| assert_eq!(&v[at..at + 2], &[-5.0, -10.0]));
        greatest.read(|v| assert_eq!(&v[at..at + 2], &[71.0, 142.0]));
        // Bucket 1 of level 2 spans frames 64..128.
        samples.level_pages(0, 2, 0, 1..2)[0].read(|v| assert_eq!(&v[2..4], &[-5.0, -10.0]));
        samples.level_pages(0, 2, 1, 1..2)[0].read(|v| assert_eq!(&v[2..4], &[127.0, 254.0]));
    }

    #[test]
    fn appends_read_back_by_coordinate() {
        let mut samples = Samples::default();
        samples.append(&[0.0, 1.0], &Values::from(vec![1.0_f64, 2.0, 3.0, 4.0]), 2).expect("frames");
        assert_eq!(samples.end(), 2);
        assert_eq!(samples.frame_at(0.5), Some(0));
        assert_eq!(samples.value(1, 1), Some(4.0));
        assert_eq!(samples.frame_at(-1.0), None);
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
    }

    #[test]
    fn forgetting_keeps_frame_numbers_and_older_versions() {
        let rows = 4096;
        let mut samples = Samples::default();
        for t in 0..100 {
            samples.append(&[f64::from(t)], &Values::from(vec![t as f32; rows]), rows).expect("frame");
        }
        let older = samples.clone();
        let pages = |s: &Samples| s.blocks[0].read(<[FramePage]>::len);
        let before = pages(&samples);
        assert!(samples.forget(50.0));
        assert!(!samples.forget(50.0), "nothing more to forget");
        assert_eq!((samples.start(), samples.end()), (50, 100));
        assert_eq!(samples.span(), Some([50.0, 99.0]));
        assert_eq!(samples.value(7, 60), Some(60.0), "frames keep their numbers");
        assert_eq!(samples.value(7, 49), None);
        assert!(pages(&samples) < before, "whole pages before the first kept frame drop");
        assert_eq!(older.value(7, 10), Some(10.0), "an older version still reads them");
        samples.append(&[100.0], &Values::from(vec![1.0_f32; rows]), rows).expect("frame");
        assert_eq!(samples.end(), 101);
        assert_eq!(samples.frames_of(rows).len(), 51 * rows);
    }

    #[test]
    fn gather_keeps_each_rows_history() {
        let mut samples = Samples::default();
        samples.append(&[0.0, 1.0], &Values::from(vec![1.0_f64, 2.0, 3.0, 4.0]), 2).expect("frames");
        let gathered = samples.gather(&[1]);
        assert_eq!(gathered.value(0, 0), Some(2.0));
        assert_eq!(gathered.value(0, 1), Some(4.0));
    }
}
