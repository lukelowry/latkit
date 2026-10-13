use std::sync::{Arc, PoisonError, RwLock};

use super::column::{PAGE_BITS, PAGE_MASK, PAGE_ROWS};
use super::name::PageId;
use super::values::Values;
use crate::{Error, Result};

/// Words in a frame page: frames of one row block, frame-major.
pub(crate) const FRAME_PAGE_WORDS: usize = 1 << 16;

/// An append-only list shared between versions; each version sees the items it appended.
///
/// A version that appends while it is the newest grows the shared list in place; an older version
/// that appends forks a copy of what it sees.
pub(crate) struct Log<T> {
    items: Arc<RwLock<Vec<T>>>,
    len: usize,
}

impl<T> Clone for Log<T> {
    fn clone(&self) -> Log<T> {
        Log { items: self.items.clone(), len: self.len }
    }
}

impl<T> Default for Log<T> {
    fn default() -> Log<T> {
        Log { items: Arc::default(), len: 0 }
    }
}

impl<T: Clone> Log<T> {
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn push(&mut self, item: T) {
        {
            let mut items = self.items.write().unwrap_or_else(PoisonError::into_inner);
            if items.len() == self.len {
                items.push(item);
                self.len += 1;
                return;
            }
        }
        let mut fork = self.read(<[T]>::to_vec);
        fork.push(item);
        self.len = fork.len();
        self.items = Arc::new(RwLock::new(fork));
    }

    pub(crate) fn read<R>(&self, f: impl FnOnce(&[T]) -> R) -> R {
        f(&self.items.read().unwrap_or_else(PoisonError::into_inner)[..self.len])
    }

    pub(crate) fn last(&self) -> Option<T> {
        self.read(|items| items.last().cloned())
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

/// A field's samples over the data's axis: one frame per coordinate, every row in each frame.
#[derive(Clone, Default)]
pub(crate) struct Samples {
    at: Log<f64>,
    blocks: Arc<[Log<FramePage>]>,
}

impl Samples {
    pub(crate) fn frames(&self) -> u32 {
        self.at.len() as u32
    }

    /// The coordinate of `frame`.
    pub(crate) fn at(&self, frame: u32) -> f64 {
        self.at.read(|at| at[frame as usize])
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
        let mut frame_values = vec![0.0_f32; rows];
        for (f, &t) in at.iter().enumerate() {
            let frame = self.frames();
            for (row, value) in frame_values.iter_mut().enumerate() {
                let i = f * rows + row;
                *value = if values.is_valid(i) { values.number(i) as f32 } else { f32::NAN };
            }
            for (b, block) in blocks.iter_mut().enumerate().take(rows.div_ceil(PAGE_ROWS)) {
                let slice = &frame_values[b * PAGE_ROWS..rows.min((b + 1) * PAGE_ROWS)];
                if !block.last().is_some_and(|page| page.extend(frame, slice)) {
                    block.push(FramePage::new(frame, slice.to_vec(), slice.len() as u32));
                }
            }
            self.at.push(t);
        }
        self.blocks = blocks.into();
        Ok(())
    }

    /// The last frame at or before `at`.
    pub(crate) fn frame_at(&self, at: f64) -> Option<u32> {
        self.at.read(|coordinates| coordinates.partition_point(|&t| t <= at)).checked_sub(1).map(|i| i as u32)
    }

    /// How far `at` lies from `frame` toward the next frame, in `0..=1`.
    pub(crate) fn t(&self, frame: u32, at: f64) -> f32 {
        self.at.read(|c| match (c.get(frame as usize), c.get(frame as usize + 1)) {
            (Some(&a), Some(&b)) if b > a => ((at - a) / (b - a)).clamp(0.0, 1.0) as f32,
            _ => 0.0,
        })
    }

    /// The page holding `frame` of `block` and the word where the frame starts in it.
    pub(crate) fn cursor(&self, block: usize, frame: u32) -> Option<(FramePage, u32)> {
        if frame >= self.frames() {
            return None;
        }
        self.blocks.get(block)?.read(|pages| {
            let i = pages.partition_point(|page| page.first <= frame).checked_sub(1)?;
            let page = &pages[i];
            Some((page.clone(), (frame - page.first) * page.rows))
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
        let mut out = vec![f32::NAN; self.frames() as usize * rows];
        if rows > 0 {
            for (frame, chunk) in out.chunks_exact_mut(rows).enumerate() {
                self.read_frame(frame as u32, chunk);
            }
        }
        out
    }

    /// The samples of rows `rows`, in that order, over every frame.
    pub(crate) fn gather(&self, rows: &[usize]) -> Samples {
        let mut gathered = Samples::default();
        let width = rows.iter().max().map_or(0, |&r| r + 1);
        let mut frame_values = vec![0.0; width];
        for frame in 0..self.frames() {
            self.read_frame(frame, &mut frame_values);
            let picked: Vec<f32> = rows.iter().map(|&r| frame_values[r]).collect();
            gathered.append(&[self.at(frame)], &Values::from(picked), rows.len()).expect("valid frames");
        }
        gathered
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_read_back_by_coordinate() {
        let mut samples = Samples::default();
        samples.append(&[0.0, 1.0], &Values::from(vec![1.0_f64, 2.0, 3.0, 4.0]), 2).expect("frames");
        assert_eq!(samples.frames(), 2);
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
        assert_eq!(older.frames(), 1);
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
