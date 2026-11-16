use std::ops::Range;
use std::sync::{Arc, OnceLock};

use super::name::PageId;
use super::values::{Array, Kind, Picks, Value, Values};
use crate::{Error, Result};

/// Log2 of the rows per page (4,096). A page is the unit of sharing between versions, of GPU
/// upload, of residency when a paged table is drawn, and of a mark's per-row evaluation.
pub(crate) const PAGE_BITS: u32 = 12;
pub(crate) const PAGE_ROWS: usize = 1 << PAGE_BITS;
pub(crate) const PAGE_MASK: usize = PAGE_ROWS - 1;

/// How many writes back a page records which rows changed. Beyond that, the page counts as
/// entirely rewritten.
const REMEMBERED: u8 = 8;

/// One page of a column. It holds up to [`PAGE_ROWS`] values and an id unique to these contents. A
/// page made by writing over another records that page and the rows written (`written`). It also
/// caches its geometry's point count.
#[derive(Clone, Debug)]
pub(crate) struct Page {
    pub(crate) id: PageId,
    pub(crate) values: Values,
    pub(crate) written: Option<Arc<Written>>,
    /// Computed on first use and cached, since pages are immutable.
    points: OnceLock<usize>,
}

/// How a page was written. It records the page it copied (`from`), the rows written or added as
/// runs of offsets into the page, and how `from` was written in turn (`before`), up to
/// [`REMEMBERED`] writes back. The runs ascend and neither overlap nor touch, so a page written
/// whole records one.
#[derive(Debug)]
pub(crate) struct Written {
    pub(crate) from: PageId,
    pub(crate) rows: Box<[Range<u32>]>,
    pub(crate) before: Option<Arc<Written>>,
    depth: u8,
}

impl Page {
    pub(crate) fn new(values: Values) -> Page {
        Page { id: PageId::next(), values, written: None, points: OnceLock::new() }
    }

    /// A new page holding `values`, made by writing `rows` over `old`: runs of offsets into the
    /// page, ascending, that neither overlap nor touch.
    fn over(values: Values, old: &Page, rows: Vec<Range<u32>>) -> Page {
        let before = old.written.clone().filter(|w| w.depth < REMEMBERED);
        let depth = before.as_ref().map_or(1, |w| w.depth + 1);
        let written = Written { from: old.id, rows: rows.into(), before, depth };
        Page { id: PageId::next(), values, written: Some(Arc::new(written)), points: OnceLock::new() }
    }

    /// The page's geometry point count as shaders read it. See [`Values::points`].
    pub(crate) fn points(&self) -> usize {
        *self.points.get_or_init(|| self.values.points())
    }

    /// The rows written since page `before`, as ascending runs of offsets into the page that
    /// neither overlap nor touch. Empty if this page is `before`. `None` unless this page was
    /// written from `before` and still remembers it (see [`REMEMBERED`]).
    pub(crate) fn rows_since(&self, before: PageId) -> Option<Vec<Range<u32>>> {
        if self.id == before {
            return Some(Vec::new());
        }
        let mut rows = Vec::new();
        let mut at = self.written.as_deref();
        while let Some(written) = at {
            rows.extend_from_slice(&written.rows);
            if written.from == before {
                // One write's runs are joined already. Several writes' runs may meet.
                return Some(if std::ptr::eq(written, self.written.as_deref()?) { rows } else { joined(rows) });
            }
            at = written.before.as_deref();
        }
        None
    }
}

/// `rows` as ascending runs that neither overlap nor touch.
fn runs(mut rows: Vec<u32>) -> Vec<Range<u32>> {
    if !rows.is_sorted() {
        rows.sort_unstable();
    }
    let mut runs: Vec<Range<u32>> = Vec::new();
    for row in rows {
        match runs.last_mut() {
            Some(run) if row <= run.end => run.end = run.end.max(row + 1),
            _ => runs.push(row..row + 1),
        }
    }
    runs
}

/// `runs` in ascending order, with those that overlap or touch made one.
fn joined(mut runs: Vec<Range<u32>>) -> Vec<Range<u32>> {
    runs.sort_unstable_by_key(|run| run.start);
    let mut joined: Vec<Range<u32>> = Vec::with_capacity(runs.len());
    for run in runs {
        match joined.last_mut() {
            Some(last) if run.start <= last.end => last.end = last.end.max(run.end),
            _ => joined.push(run),
        }
    }
    joined
}

/// Rows of a column, as ascending runs that neither overlap nor touch. A column written whole is
/// one run, so reading a write costs its runs unless each row is asked for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Runs(Vec<Range<u32>>);

impl Runs {
    /// The number of rows.
    pub(crate) fn len(&self) -> usize {
        self.0.iter().map(|run| (run.end - run.start) as usize).sum()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether `row` is one of them.
    pub(crate) fn contains(&self, row: u32) -> bool {
        let i = self.0.partition_point(|run| run.end <= row);
        self.0.get(i).is_some_and(|run| run.start <= row)
    }

    /// The rows, ascending.
    pub(crate) fn iter(&self) -> impl Iterator<Item = u32> + '_ {
        self.0.iter().flat_map(Clone::clone)
    }

    /// The runs, ascending.
    pub(crate) fn ranges(&self) -> &[Range<u32>] {
        &self.0
    }

    /// Adds `run`, which starts at or after the end of every run held.
    fn push(&mut self, run: Range<u32>) {
        match self.0.last_mut() {
            Some(last) if last.end == run.start => last.end = run.end,
            _ if run.start < run.end => self.0.push(run),
            _ => {}
        }
    }

    /// Adds the rows of `other`.
    pub(crate) fn extend(&mut self, other: &Runs) {
        if !other.is_empty() {
            self.0 = joined(std::mem::take(&mut self.0).into_iter().chain(other.0.iter().cloned()).collect());
        }
    }
}

/// A field's values in pages of [`PAGE_ROWS`] rows. Writes replace only the pages they touch. The
/// others keep their ids.
///
/// Missing values fit any kind. A column's kind is fixed once it holds a value: until then, values
/// of any kind can be written to it, and it takes their kind. Values that are all missing can be
/// written to a column of any kind.
#[derive(Clone, Debug)]
pub(crate) struct Column {
    len: usize,
    pages: Arc<[Page]>,
    /// An empty slice with the column's storage type, so an empty column still knows its kind.
    like: Values,
    /// Whether the column has held a value. Until then its kind is not fixed.
    fixed: bool,
}

impl Column {
    pub(crate) fn new(values: &Values) -> Column {
        let len = values.len();
        let pages = (0..len.div_ceil(PAGE_ROWS))
            .map(|p| Page::new(values.slice(p * PAGE_ROWS..len.min((p + 1) * PAGE_ROWS))))
            .collect();
        Column { len, pages, like: values.slice(0..0), fixed: values.holds_any() }
    }

    /// A column of `len` missing values with the storage of `like`.
    pub(crate) fn missing(like: &Values, len: usize) -> Column {
        let empty = Column { len: 0, pages: Arc::new([]), like: like.slice(0..0), fixed: false };
        empty.write(len, &[], &empty).expect("same storage")
    }

    /// A column of existing `pages`, keeping their ids. Every page but the last must hold
    /// [`PAGE_ROWS`] values.
    pub(crate) fn of_pages(pages: Vec<Page>, like: &Values) -> Column {
        debug_assert!(pages.iter().rev().skip(1).all(|p| p.values.len() == PAGE_ROWS));
        let len = pages.iter().map(|p| p.values.len()).sum();
        let fixed = pages.iter().any(|p| p.values.holds_any());
        Column { len, pages: pages.into(), like: like.slice(0..0), fixed }
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn kind(&self) -> Kind {
        self.like.kind()
    }

    /// Whether the column has held a value, which fixes its kind.
    pub(crate) fn fixed(&self) -> bool {
        self.fixed
    }

    pub(crate) fn pages(&self) -> &[Page] {
        &self.pages
    }

    /// Whether `other` has the same length and page ids. That means the values are equal, without
    /// comparing any.
    pub(crate) fn shares(&self, other: &Column) -> bool {
        self.len == other.len && self.pages.iter().zip(other.pages.iter()).all(|(a, b)| a.id == b.id)
    }

    pub(crate) fn like(&self) -> &Values {
        &self.like
    }

    pub(crate) fn get(&self, row: usize) -> Option<Value> {
        self.pages.get(row >> PAGE_BITS)?.values.get(row & PAGE_MASK)
    }

    /// The values of the page holding row `row`, and the row's index in them. `None` past the
    /// column's end.
    pub(crate) fn at(&self, row: usize) -> Option<(&Values, usize)> {
        let values = &self.pages.get(row >> PAGE_BITS)?.values;
        let i = row & PAGE_MASK;
        (i < values.len()).then_some((values, i))
    }

    /// The values of rows `rows`, in that order, for GPU upload. Rows past the column's end come
    /// back missing, because a placeholder derived table, shown until its job finishes, can be
    /// shorter than the rows requested.
    pub(crate) fn pick(&self, rows: &[u32]) -> Values {
        let from: Vec<Option<usize>> = rows.iter().map(|&r| Some(r as usize).filter(|&r| r < self.len)).collect();
        let sources: Vec<&Values> = std::iter::once(&self.like).chain(self.pages.iter().map(|p| &p.values)).collect();
        Values::assemble(&sources, Picks::Found(&from)).expect("one storage")
    }

    /// A copy with `len` rows (at least the current count) and `writes` applied.
    ///
    /// `writes` are `(row, source row)` pairs sorted by row, each row at most once. Pages that no
    /// write changes and that keep their length keep their ids, so rewriting the same values costs
    /// nothing downstream. New rows not written are missing.
    /// Returns an error if both hold values, of different kinds. A column that holds no value takes
    /// the kind of `source`, and a `source` that holds none writes missing values of this kind.
    ///
    /// A write costs the values written and the pages they land in, not the column's rows. Writing
    /// every row in order, in the column's storage, copies nothing: each page of `source` becomes
    /// the column's (see [`replaced_by`](Column::replaced_by)).
    pub(crate) fn write(&self, len: usize, writes: &[(usize, usize)], source: &Column) -> Result<Column> {
        if self.kind() != source.kind() {
            if !self.fixed {
                return Column::missing(&source.like, self.len).write(len, writes, source);
            }
            if !source.fixed {
                return self.write(len, writes, &Column::missing(&self.like, source.len));
            }
            return Err(Error::invalid(format!("{:?} values for a {:?} field", source.kind(), self.kind())));
        }
        debug_assert!(len >= self.len);
        debug_assert!(writes.windows(2).all(|w| w[0].0 < w[1].0));
        let whole = len == self.len && source.len == len && writes.len() == len;
        if whole && self.like.stored_like(&source.like) && writes.iter().enumerate().all(|(row, w)| *w == (row, row)) {
            return Ok(self.replaced_by(source));
        }
        let count = len.div_ceil(PAGE_ROWS);
        let mut pages: Vec<Page> = Vec::with_capacity(count);
        let mut sources: Vec<&Values> = vec![&self.like];
        sources.extend(source.pages.iter().map(|p| &p.values));
        let mut next = 0;
        let mut fixed = self.fixed;
        for p in 0..count {
            let start = p * PAGE_ROWS;
            let page_len = (len - start).min(PAGE_ROWS);
            let first = next;
            while next < writes.len() && writes[next].0 < start + page_len {
                next += 1;
            }
            let page_writes = &writes[first..next];
            let old = self.pages.get(p);
            if page_writes.is_empty()
                && let Some(old) = old
                && old.values.len() == page_len
            {
                pages.push(old.clone());
                continue;
            }
            sources[0] = old.map_or(&self.like, |o| &o.values);
            let kept = sources[0].len();
            let values = Values::picked(&sources, Picks::Written { writes: page_writes, start, kept, len: page_len });
            fixed |= source.fixed && values.holds_any();
            pages.push(match old {
                // Record the rows whose values changed, plus the rows added past the old page's end.
                // A page whose rows all kept their values keeps its id.
                Some(old) => {
                    let mut rows: Vec<u32> = page_writes
                        .iter()
                        .map(|&(row, _)| row - start)
                        .filter(|&r| r < kept && !values.same_row(r, &old.values, r))
                        .map(|r| r as u32)
                        .collect();
                    rows.extend(kept as u32..page_len as u32);
                    if rows.is_empty() { old.clone() } else { Page::over(values, old, runs(rows)) }
                }
                None => Page::new(values),
            });
        }
        Ok(Column { len, pages: pages.into(), like: self.like.clone(), fixed })
    }

    /// This column with the values of `source`, which holds the same rows in the same storage. Each
    /// page of `source` becomes the column's as it is, so nothing is copied. A page whose values are
    /// equal keeps its id. Any other records the rows that differ, as a written page does.
    pub(crate) fn replaced_by(&self, source: &Column) -> Column {
        debug_assert!(source.len == self.len && self.like.stored_like(&source.like));
        let pages = self
            .pages
            .iter()
            .zip(source.pages.iter())
            .map(|(old, new)| match new.values.differing(&old.values) {
                rows if rows.is_empty() => old.clone(),
                rows => Page::over(new.values.clone(), old, rows),
            })
            .collect();
        Column { len: self.len, pages, like: self.like.clone(), fixed: self.fixed || source.fixed }
    }

    /// This column, ready for `source` to be written into it: `u32` numbers widen to `u64` when
    /// `source` holds a larger one, so no id is cut short. A reference keeps `u32` ids, as they
    /// arrive from writers without 64-bit integers, while every id fits.
    pub(crate) fn widened_for(&self, source: &Column) -> Column {
        let larger = |page: &Page| match &page.values.array {
            Array::U64(ids) => ids.iter().any(|&id| id > u64::from(u32::MAX)),
            _ => false,
        };
        if !matches!(self.like.array, Array::U32(_)) || !source.pages.iter().any(larger) {
            return self.clone();
        }
        let wide = |values: &Values| match &values.array {
            Array::U32(ids) => {
                Values { array: Array::U64(ids.iter().map(|&id| u64::from(id)).collect()), ..values.clone() }
            }
            _ => values.clone(),
        };
        let pages: Vec<Page> = self.pages.iter().map(|page| Page::new(wide(&page.values))).collect();
        Column { len: self.len, pages: pages.into(), like: wide(&self.like), fixed: self.fixed }
    }

    /// Whether the first `rows` rows are unchanged since `before`, which this column was written
    /// from a few writes back. That holds when every write since is at row `rows` or later, as with
    /// appends. Writes that a page no longer remembers count as changes.
    pub(crate) fn kept_below(&self, before: &Column, rows: usize) -> bool {
        (0..rows.div_ceil(PAGE_ROWS)).all(|p| {
            let (Some(now), Some(then)) = (self.pages.get(p), before.pages.get(p)) else { return false };
            let start = p * PAGE_ROWS;
            now.id == then.id
                || now
                    .rows_since(then.id)
                    .is_some_and(|written| written.iter().all(|r| start + r.start as usize >= rows))
        })
    }

    /// The rows written or added since `before`. For each page that differs from `before`'s, these
    /// are the rows it remembers writing since, or all its rows if it does not remember `before`'s
    /// page. A page that `before` lacks counts in full. Rows of `before` past this column's end are
    /// not included. Costs the column's pages and the runs written, not the rows.
    pub(crate) fn written_since(&self, before: &Column) -> Runs {
        let mut rows = Runs::default();
        for (p, now) in self.pages.iter().enumerate() {
            let start = (p * PAGE_ROWS) as u32;
            let whole = start..start + now.values.len() as u32;
            match before.pages.get(p) {
                Some(then) if then.id == now.id => {}
                Some(then) => match now.rows_since(then.id) {
                    Some(written) => written.into_iter().for_each(|run| rows.push(start + run.start..start + run.end)),
                    None => rows.push(whole),
                },
                None => rows.push(whole),
            }
        }
        rows
    }

    /// All values in row order as one [`Values`]. A single-page column returns its page without
    /// copying. Otherwise the pages are concatenated.
    pub(crate) fn values(&self) -> Values {
        match &self.pages[..] {
            [] => self.like.clone(),
            [page] => page.values.clone(),
            pages => Values::concat(&pages.iter().map(|p| &p.values).collect::<Vec<_>>()),
        }
    }

    /// A column of rows `rows` of this one, in that order. Leading whole pages whose rows are
    /// unchanged (`rows[i] == i`) keep their ids.
    pub(crate) fn gather(&self, rows: &[usize]) -> Column {
        let kept = rows.iter().enumerate().take_while(|&(i, &r)| i == r).count();
        let kept_pages = (kept / PAGE_ROWS).min(rows.len() / PAGE_ROWS);
        let sources: Vec<&Values> = std::iter::once(&self.like).chain(self.pages.iter().map(|p| &p.values)).collect();
        let mut pages: Vec<Page> = self.pages[..kept_pages].to_vec();
        for p in kept_pages..rows.len().div_ceil(PAGE_ROWS) {
            let chunk = &rows[p * PAGE_ROWS..rows.len().min((p + 1) * PAGE_ROWS)];
            pages.push(Page::new(Values::assemble(&sources, Picks::Rows(chunk)).expect("one storage")));
        }
        let fixed = self.fixed && pages.iter().any(|p| p.values.holds_any());
        Column { len: rows.len(), pages: pages.into(), like: self.like.clone(), fixed }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbers(n: usize) -> Values {
        Values::from((0..n).map(|i| i as f64).collect::<Vec<_>>())
    }

    /// The rows written in `now` since `before`.
    fn rows_written(now: &Column, before: &Column) -> Vec<usize> {
        now.written_since(before).iter().map(|row| row as usize).collect()
    }

    #[test]
    fn writes_touch_only_their_pages() {
        let column = Column::new(&numbers(PAGE_ROWS * 2 + 10));
        let source = Column::new(&Values::from(vec![-1.0_f64]));
        let written = column.write(column.len(), &[(PAGE_ROWS + 3, 0)], &source).expect("numbers");
        assert_eq!(written.pages()[0].id, column.pages()[0].id);
        assert_ne!(written.pages()[1].id, column.pages()[1].id);
        assert_eq!(written.pages()[2].id, column.pages()[2].id);
        assert_eq!(written.get(PAGE_ROWS + 3), Some(Value::Number(-1.0)));
        assert_eq!(written.get(PAGE_ROWS + 4), Some(Value::Number((PAGE_ROWS + 4) as f64)));
    }

    #[test]
    fn growth_pads_with_missing() {
        let column = Column::new(&numbers(3));
        let grown = column.write(5, &[(4, 0)], &Column::new(&Values::from(vec![9.0_f64]))).expect("numbers");
        assert_eq!(grown.len(), 5);
        assert_eq!(grown.get(3), None);
        assert_eq!(grown.get(4), Some(Value::Number(9.0)));
        assert_eq!(Column::missing(&numbers(0), 4).get(2), None);
    }

    #[test]
    fn written_pages_remember_the_rows_written_since() {
        let column = Column::new(&numbers(PAGE_ROWS + 10));
        let source = Column::new(&Values::from(vec![-1.0_f64, -2.0]));
        let once = column.write(column.len(), &[(3, 0), (PAGE_ROWS + 4, 1)], &source).expect("numbers");
        let twice = once.write(once.len(), &[(5, 0)], &source).expect("numbers");
        assert_eq!(rows_written(&twice, &column), vec![3, 5, PAGE_ROWS + 4], "every write since, in order");
        assert_eq!(rows_written(&twice, &once), vec![5]);
        assert!(twice.written_since(&twice).is_empty());
        // A page remembers a few writes back. Beyond that it counts as entirely rewritten.
        let values = Column::new(&Values::from((0..=REMEMBERED).map(|k| -2.0 - f64::from(k)).collect::<Vec<_>>()));
        let mut near = once.clone();
        for k in 1..usize::from(REMEMBERED) {
            near = near.write(near.len(), &[(7, k)], &values).expect("numbers");
        }
        assert_eq!(rows_written(&near, &column), vec![3, 7, PAGE_ROWS + 4]);
        let far = near.write(near.len(), &[(7, 0)], &values).expect("numbers");
        assert_eq!(rows_written(&far, &column), (0..PAGE_ROWS).chain([PAGE_ROWS + 4]).collect::<Vec<_>>());
        assert_eq!(rows_written(&far, &near), vec![7]);
    }

    #[test]
    fn rows_written_or_added_since_are_found_page_by_page() {
        let column = Column::new(&numbers(PAGE_ROWS + 10));
        let source = Column::new(&Values::from(vec![-1.0_f64]));
        let written = column.write(PAGE_ROWS + 12, &[(3, 0)], &source).expect("numbers");
        assert_eq!(
            rows_written(&written, &column),
            [3, PAGE_ROWS + 10, PAGE_ROWS + 11],
            "the row written, and the rows added past the end"
        );
        let fresh = Column::new(&numbers(PAGE_ROWS + 10));
        let every = fresh.written_since(&column);
        assert_eq!(every.ranges(), [0..(PAGE_ROWS + 10) as u32], "an unrelated column is one run of every row");
        assert!(column.written_since(&column).is_empty(), "nothing written since itself");
    }

    #[test]
    fn appends_leave_earlier_rows_unchanged() {
        let column = Column::new(&numbers(PAGE_ROWS + 10));
        let source = Column::new(&Values::from(vec![-1.0_f64]));
        let appended = column.write(PAGE_ROWS + 12, &[(PAGE_ROWS + 11, 0)], &source).expect("numbers");
        assert!(appended.kept_below(&column, PAGE_ROWS + 10), "rows appended after them leave them unchanged");
        let written = appended.write(appended.len(), &[(PAGE_ROWS + 9, 0)], &source).expect("numbers");
        assert!(written.kept_below(&appended, PAGE_ROWS + 9), "a row written after the rows checked");
        assert!(!written.kept_below(&appended, PAGE_ROWS + 10), "a row written within them");
        assert!(!Column::new(&numbers(PAGE_ROWS + 10)).kept_below(&column, 1), "an unrelated column keeps no rows");
    }

    #[test]
    fn rows_rewritten_with_the_same_value_are_unchanged() {
        let column = Column::new(&numbers(PAGE_ROWS + 10));
        // Row 4 holds 4.
        let source = Column::new(&Values::from(vec![-1.0_f64, 4.0]));
        let written = column.write(column.len(), &[(3, 0), (4, 1), (PAGE_ROWS + 4, 0)], &source).expect("numbers");
        assert_eq!(rows_written(&written, &column), vec![3, PAGE_ROWS + 4], "only the rows whose values changed");
        let again = written.write(written.len(), &[(3, 0), (4, 1)], &source).expect("numbers");
        assert!(again.shares(&written), "pages rewritten with their own values keep their ids");
    }

    #[test]
    fn a_page_counts_its_points_once_and_a_rewritten_page_recounts() {
        let path = |n: usize| (0..n).map(|i| [i as f64, 0.0]).collect::<Vec<_>>();
        let column = Column::new(&Values::from(vec![path(3), path(5)]));
        let page = &column.pages()[0];
        assert_eq!(page.points.get(), None, "nothing counted until asked");
        assert_eq!(page.points(), 8);
        assert_eq!(page.points.get(), Some(&8), "counted once, then cached");
        assert_eq!(column.clone().pages()[0].points.get(), Some(&8), "a copy of the column shares the count");
        let source = Column::new(&Values::from(vec![path(10)]));
        let written = column.write(column.len(), &[(0, 0)], &source).expect("paths");
        assert_eq!(written.pages()[0].points(), 15, "the rewritten page counts its own points");
    }

    #[test]
    fn gather_keeps_leading_pages() {
        let column = Column::new(&numbers(PAGE_ROWS + 5));
        let rows: Vec<usize> = (0..PAGE_ROWS).chain([PAGE_ROWS + 2, PAGE_ROWS + 4]).collect();
        let gathered = column.gather(&rows);
        assert_eq!(gathered.len(), PAGE_ROWS + 2);
        assert_eq!(gathered.pages()[0].id, column.pages()[0].id);
        assert_eq!(gathered.get(PAGE_ROWS + 1), Some(Value::Number((PAGE_ROWS + 4) as f64)));
    }
}
